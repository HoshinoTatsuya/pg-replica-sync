import { InvalidReplicaSyncOptionsError } from './invalid-replica-sync-options.error';
import { lagBytes } from './lag-bytes';
import { lsnOrNull } from './lsn-or-null';
import { parseLsn } from './parse-lsn';
import { readNodeState } from './read-node-state';
import { requireInteger } from './require-integer';
import { timelineOf } from './timeline-of';
import { walLayoutOf } from './wal-layout-of';

const SYSTEM = '7708384681250484264';
const STARTED = '1794822000.123456';

/** Строка зонда мастера и реплики так, как её отдаёт pg (bigint и pg_lsn — текстом). */
const PRIMARY_ROW = {
  in_recovery: false,
  system_id: SYSTEM,
  started_at: STARTED,
  replay_lsn: null,
  pause_state: null,
  received_tli: null,
  has_stats: true,
  insert_lsn: '0/5002018',
  wal_file: '000000030000000000000005',
  write_pending: false,
  wal_layout: [8, 8192, 16_777_216],
};
const REPLICA_ROW = {
  in_recovery: true,
  system_id: SYSTEM,
  started_at: STARTED,
  replay_lsn: '0/5002000',
  pause_state: 'not paused',
  received_tli: 3,
  has_stats: true,
  insert_lsn: null,
  wal_file: null,
  write_pending: null,
  wal_layout: null,
};

/**
 * Разбор строки зонда: всё, что не разобралось, — «не смогли определить»
 * (`null`, пауза), а не допуск; ответ без булева `in_recovery` — отказ зонда.
 */
describe('строка зонда → состояние узла', () => {
  it('мастер: позиция вставки, позиция для токена (граница страницы), линия времени из имени WAL-файла, экземпляр', () => {
    expect(readNodeState(PRIMARY_ROW)).toEqual({
      inRecovery: false,
      systemId: SYSTEM,
      instance: `${SYSTEM}@${STARTED}`,
      replayLsn: null,
      insertLsn: parseLsn('0/5002018'),
      tokenLsn: parseLsn('0/5002000'),
      timeline: 3,
      paused: false,
      hasStatsPrivilege: true,
      writePending: false,
    });
  });

  it('реплика: позиция воспроизведения, линия времени приёмника, пауза только по точному «not paused»', () => {
    expect(readNodeState(REPLICA_ROW)).toEqual({
      inRecovery: true,
      systemId: SYSTEM,
      instance: `${SYSTEM}@${STARTED}`,
      replayLsn: parseLsn('0/5002000'),
      insertLsn: null,
      tokenLsn: null,
      timeline: 3,
      paused: false,
      hasStatsPrivilege: true,
      writePending: false,
    });
    for (const pause of ['pause requested', 'paused', null, 'NOT PAUSED']) {
      expect(readNodeState({ ...REPLICA_ROW, pause_state: pause }).paused).toBe(true);
    }
  });

  it('не в форме — null, а не допуск; признаки — только строгое true', () => {
    const state = readNodeState({
      ...REPLICA_ROW,
      system_id: '12a',
      started_at: '',
      replay_lsn: 'garbage',
      received_tli: 0,
      has_stats: 't',
    });
    expect(state.systemId).toBeNull();
    expect(state.instance).toBeNull();
    expect(state.replayLsn).toBeNull();
    expect(state.timeline).toBeNull();
    expect(state.hasStatsPrivilege).toBe(false);
    expect(readNodeState({ ...PRIMARY_ROW, write_pending: 'true' }).writePending).toBe(false);
    expect(readNodeState({ ...PRIMARY_ROW, write_pending: true }).writePending).toBe(true);
    expect(readNodeState({ ...PRIMARY_ROW, system_id: 123 }).systemId).toBeNull();
    expect(readNodeState({ ...PRIMARY_ROW, started_at: null }).instance).toBeNull();
    // Раскладка WAL не разобралась — позиция для токена равна позиции вставки.
    expect(readNodeState({ ...PRIMARY_ROW, wal_layout: null }).tokenLsn).toBe(parseLsn('0/5002018'));
  });

  it('экземпляр — только при обоих признаках: system_identifier и момент старта', () => {
    expect(readNodeState({ ...REPLICA_ROW, started_at: '' }).instance).toBeNull();
    expect(readNodeState({ ...REPLICA_ROW, started_at: 1_794_822_000 }).instance).toBeNull();
    expect(readNodeState({ ...REPLICA_ROW, system_id: null }).instance).toBeNull();
    expect(readNodeState(REPLICA_ROW).instance).toBe(`${SYSTEM}@${STARTED}`);
  });

  it('ответ без булева in_recovery — отказ зонда', () => {
    expect(() => readNodeState(undefined)).toThrow('in_recovery');
    expect(() => readNodeState({ ...PRIMARY_ROW, in_recovery: 'f' })).toThrow('in_recovery');
  });

  it('линия времени: реплика — целое > 0 (число или текст), мастер — 8 цифр имени WAL-файла', () => {
    expect(timelineOf(true, 7, null)).toBe(7);
    expect(timelineOf(true, '7', null)).toBe(7);
    expect(timelineOf(true, 0, null)).toBeNull();
    expect(timelineOf(true, -1, null)).toBeNull();
    expect(timelineOf(true, 1.5, null)).toBeNull();
    expect(timelineOf(true, null, '000000030000000000000005')).toBeNull();
    expect(timelineOf(false, 7, '0000000A0000000000000005')).toBe(10);
    expect(timelineOf(false, null, '000000000000000000000005')).toBeNull();
    expect(timelineOf(false, null, 'garbage')).toBeNull();
    expect(timelineOf(false, null, 5)).toBeNull();
  });

  it('позиция из ответа: только текст в форме X/Y', () => {
    expect(lsnOrNull('1/0')).toBe(4_294_967_296n);
    expect(lsnOrNull('1/G')).toBeNull();
    expect(lsnOrNull(4_294_967_296)).toBeNull();
    expect(lsnOrNull(null)).toBeNull();
  });

  it('раскладка WAL: три положительных целых, сегмент кратен странице', () => {
    expect(walLayoutOf([8, 8192, 16_777_216])).toEqual({
      maxAlign: 8,
      blockSize: 8192,
      segmentSize: 16_777_216,
    });
    expect(walLayoutOf(['8', '8192', '16777216'])).toEqual({
      maxAlign: 8,
      blockSize: 8192,
      segmentSize: 16_777_216,
    });
    expect(walLayoutOf([8, 8192])).toBeNull();
    expect(walLayoutOf([8, 8192, 10_000])).toBeNull();
    expect(walLayoutOf([0, 8192, 16_777_216])).toBeNull();
    expect(walLayoutOf([8, -8192, 16_777_216])).toBeNull();
    expect(walLayoutOf('8,8192,16777216')).toBeNull();
  });
});

describe('настройки и отставание', () => {
  it('целое в границах включительно; дробь, NaN, бесконечность — отказ', () => {
    expect(requireInteger('x', 1, 1, 3)).toBe(1);
    expect(requireInteger('x', 3, 1, 3)).toBe(3);
    expect(requireInteger('x', 0, 0)).toBe(0);
    for (const value of [0, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => requireInteger('x', value, 1, 3)).toThrow(InvalidReplicaSyncOptionsError);
    }
    expect(() => requireInteger('x', -1, 0)).toThrow('ожидается целое ≥ 0');
    expect(() => requireInteger('x', 4, 1, 3)).toThrow('ожидается целое в 1..3');
  });

  it('отставание: реплика, снятая позже мастера и впереди него, — ноль, а не отрицательное', () => {
    expect(lagBytes(10n, 4n)).toBe(6n);
    expect(lagBytes(10n, 10n)).toBe(0n);
    expect(lagBytes(10n, 15n)).toBe(0n);
  });
});
