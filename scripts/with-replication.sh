#!/usr/bin/env bash
# Поднимает НАСТОЯЩУЮ потоковую репликацию в docker: мастер и три реплики из
# одного образа postgres в своей сети. Реплика создаётся `pg_basebackup -R`
# (standby.signal + primary_conninfo) со своим физическим слотом. Адреса
# отдаются в окружении и запускается переданная команда; контейнеры (с томами)
# и сеть убираются в trap при любом исходе.
#
# PG_PRIMARY_URL, PG_REPLICA1_URL, PG_REPLICA2_URL, PG_REPLICA3_URL — адреса
#   суперпользователя (test/test); роль приложения без суперправ — app/app
#   (членство pg_monitor — ровно то, что нужно зонду состояния).
# Третья реплика — расходная: спека промоции делает её мастером, остальные две
#   продолжают следовать за исходным мастером, и соседние спеки этого не видят.
# PG_BOUNCER_TX_URL — pgbouncer в режиме transaction над replica1 и replica2
#   (несколько хостов, новые серверные соединения — по кругу): «балансировщик», который
#   привязывает к серверу только транзакцию (роль app/app).
# PG_CASCADE_URL — каскадная реплика (реплика replica1), PG_ARCHIVE_URL — реплика
#   ТОЛЬКО через архив WAL (restore_command, без primary_conninfo): мастер архивирует
#   сегменты в общий том.
# Все семь адресов уже заданы (своя топология) — docker не нужен.
# PG_TEST_IMAGE — образ postgres (по умолчанию postgres:17-alpine; поддерживаются 15–18),
#   PG_BOUNCER_IMAGE — образ pgbouncer; по умолчанию закреплён digest, на котором проверено
#   (PgBouncer 1.26.1): плавающий тег сменил бы pgbouncer под спеками незаметно.
# PG_REPLICATION_BIND / PG_REPLICATION_HOST — где публиковать порты и по какому
#   адресу к ним ходить (по умолчанию 127.0.0.1; в CI с docker:dind — 0.0.0.0 и docker).
set -euo pipefail
if [[ -n "${PG_PRIMARY_URL:-}" && -n "${PG_REPLICA1_URL:-}" && -n "${PG_REPLICA2_URL:-}" && -n "${PG_REPLICA3_URL:-}" && -n "${PG_BOUNCER_TX_URL:-}" && -n "${PG_CASCADE_URL:-}" && -n "${PG_ARCHIVE_URL:-}" ]]; then
  exec "$@"
fi
IMAGE="${PG_TEST_IMAGE:-postgres:17-alpine}"
BOUNCER_IMAGE="${PG_BOUNCER_IMAGE:-edoburu/pgbouncer@sha256:8638aa563607256d3c7440437534195f1066a92b68015d89ae9d6b935b444a6d}"
BIND="${PG_REPLICATION_BIND:-127.0.0.1}"
HOST="${PG_REPLICATION_HOST:-127.0.0.1}"
TAG="pg-replica-sync-test-$$"
NET="${TAG}-net"
PRIMARY="${TAG}-primary"
REPLICAS=("${TAG}-replica1" "${TAG}-replica2" "${TAG}-replica3")
BOUNCER="${TAG}-bouncer"
CASCADE="${TAG}-cascade"
ARCHIVE_REPLICA="${TAG}-archive"
ARCHIVE_VOLUME="${TAG}-wal-archive"
BOUNCER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pg-replica-sync-bouncer-XXXXXX")"

cleanup() {
  docker rm -f -v "${PRIMARY}" "${REPLICAS[@]}" "${BOUNCER}" "${CASCADE}" "${ARCHIVE_REPLICA}" >/dev/null 2>&1 || true
  docker volume rm "${ARCHIVE_VOLUME}" >/dev/null 2>&1 || true
  case "${BOUNCER_DIR}" in
    "${TMPDIR:-/tmp}"/pg-replica-sync-bouncer-*) rm -rf "${BOUNCER_DIR}" ;;
  esac
  docker network rm "${NET}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

port_of() {
  docker port "$1" 5432/tcp | head -1 | sed 's/.*://'
}

# Готовность — настоящим запросом ПО TCP (временный сервер initdb слушает только
# unix-сокет и затем перезапускается). $2 — ожидаемый pg_is_in_recovery().
wait_ready() {
  local name="$1" expect="$2"
  for _ in $(seq 1 240); do
    if [[ "$(docker exec "${name}" psql -h 127.0.0.1 -U test -d postgres -tAc 'select pg_is_in_recovery()' 2>/dev/null || true)" == "${expect}" ]]; then
      return 0
    fi
    sleep 0.5
  done
  echo "${name} не поднялся (ожидался pg_is_in_recovery() = ${expect})" >&2
  docker logs "${name}" 2>&1 | tail -20 >&2
  return 1
}

docker network create "${NET}" >/dev/null
docker volume create "${ARCHIVE_VOLUME}" >/dev/null
docker run --rm -v "${ARCHIVE_VOLUME}:/archive" --entrypoint sh "${IMAGE}" -c 'chown postgres:postgres /archive' >/dev/null
docker run -d --name "${PRIMARY}" --network "${NET}" -v "${ARCHIVE_VOLUME}:/archive" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test \
  -p "${BIND}:0:5432" "${IMAGE}" -c fsync=off -c archive_mode=on \
  -c "archive_command=cp %p /archive/%f" >/dev/null
wait_ready "${PRIMARY}" f

docker exec "${PRIMARY}" sh -c 'echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"'
docker exec -i "${PRIMARY}" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U test -d postgres -q >/dev/null <<'SQL'
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator';
CREATE ROLE app WITH LOGIN PASSWORD 'app';
GRANT pg_monitor TO app;
SELECT pg_create_physical_replication_slot('replica1');
SELECT pg_create_physical_replication_slot('replica2');
SELECT pg_create_physical_replication_slot('replica3');
SELECT pg_reload_conf();
SQL

index=0
for replica in "${REPLICAS[@]}"; do
  index=$((index + 1))
  docker run -d --name "${replica}" --network "${NET}" --user postgres \
    -e PGPASSWORD=replicator -p "${BIND}:0:5432" --entrypoint sh "${IMAGE}" -c \
    "set -e; pg_basebackup -h ${PRIMARY} -U replicator -D \"\$PGDATA\" -R -X stream -S replica${index} -c fast; chmod 700 \"\$PGDATA\"; exec postgres" >/dev/null
done
for replica in "${REPLICAS[@]}"; do
  wait_ready "${replica}" t
done

# Каскадная — от replica1 (без слота); архивная — копия мастера, standby.signal без
# primary_conninfo: WAL только из архива.
docker run -d --name "${CASCADE}" --network "${NET}" --user postgres \
  -e PGPASSWORD=replicator -p "${BIND}:0:5432" --entrypoint sh "${IMAGE}" -c \
  "set -e; pg_basebackup -h ${REPLICAS[0]} -U replicator -D \"\$PGDATA\" -R -X stream -c fast; chmod 700 \"\$PGDATA\"; exec postgres -c primary_slot_name=''" >/dev/null
docker run -d --name "${ARCHIVE_REPLICA}" --network "${NET}" --user postgres -v "${ARCHIVE_VOLUME}:/archive" \
  -e PGPASSWORD=replicator -p "${BIND}:0:5432" --entrypoint sh "${IMAGE}" -c \
  "set -e; pg_basebackup -h ${PRIMARY} -U replicator -D \"\$PGDATA\" -X stream -c fast; chmod 700 \"\$PGDATA\"; touch \"\$PGDATA/standby.signal\"; exec postgres -c archive_mode=off -c \"restore_command=cp /archive/%f %p\" -c primary_conninfo=''" >/dev/null
wait_ready "${CASCADE}" t
wait_ready "${ARCHIVE_REPLICA}" t

# pgbouncer в режиме transaction над replica1 и replica2: каждая транзакция —
# на любой из двух серверов (новые серверные соединения — по кругу хостов,
# простаивающие — в порядке очереди). Проверка готовности — настоящим запросом
# через pgbouncer из одноразового контейнера той же сети.
chmod 755 "${BOUNCER_DIR}"
cat >"${BOUNCER_DIR}/pgbouncer.ini" <<INI
[databases]
postgres = host=${REPLICAS[0]},${REPLICAS[1]} port=5432 dbname=postgres

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = plain
auth_file = /cfg/userlist.txt
pool_mode = transaction
server_round_robin = 1
default_pool_size = 8
max_client_conn = 200
ignore_startup_parameters = extra_float_digits
INI
printf '"app" "app"\n' >"${BOUNCER_DIR}/userlist.txt"
chmod 644 "${BOUNCER_DIR}/pgbouncer.ini" "${BOUNCER_DIR}/userlist.txt"
docker run -d --name "${BOUNCER}" --network "${NET}" -v "${BOUNCER_DIR}:/cfg:ro" \
  -p "${BIND}:0:6432" --entrypoint pgbouncer "${BOUNCER_IMAGE}" /cfg/pgbouncer.ini >/dev/null
bouncer_ready=0
for _ in $(seq 1 120); do
  if docker run --rm --network "${NET}" -e PGPASSWORD=app "${IMAGE}" \
    psql -h "${BOUNCER}" -p 6432 -U app -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    bouncer_ready=1
    break
  fi
  sleep 0.5
done
if [[ "${bouncer_ready}" != 1 ]]; then
  echo "pgbouncer не поднялся" >&2
  docker logs "${BOUNCER}" 2>&1 | tail -20 >&2
  exit 1
fi

url_of() {
  echo "postgres://test:test@${HOST}:$(port_of "$1")/postgres"
}
PG_PRIMARY_URL="$(url_of "${PRIMARY}")" \
PG_REPLICA1_URL="$(url_of "${REPLICAS[0]}")" \
PG_REPLICA2_URL="$(url_of "${REPLICAS[1]}")" \
PG_REPLICA3_URL="$(url_of "${REPLICAS[2]}")" \
PG_CASCADE_URL="$(url_of "${CASCADE}")" \
PG_ARCHIVE_URL="$(url_of "${ARCHIVE_REPLICA}")" \
PG_BOUNCER_TX_URL="postgres://app:app@${HOST}:$(docker port "${BOUNCER}" 6432/tcp | head -1 | sed 's/.*://')/postgres" \
  "$@"
