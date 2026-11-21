import { deepFreeze } from '../deep-freeze';

/** Формы значений Postgres, которые разбирает пакет. Без флага g: регулярки общие. */
export const WAL_FORMAT = {
  /** `pg_lsn` в тексте: `X/Y`, по 1–8 шестнадцатеричных цифр. */
  LSN_TEXT: /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/,
  /** Имя WAL-файла: 8 цифр линии времени + 16 цифр сегмента. */
  WAL_FILE: /^([0-9A-F]{8})[0-9A-F]{16}$/,
  /** `system_identifier` — uint64 в десятичной записи. */
  SYSTEM_ID: /^[0-9]{1,20}$/,
  /** Линия времени в токене: десятичное без ведущих нулей. */
  TIMELINE_TEXT: /^[1-9][0-9]{0,9}$/,
  MAX_TIMELINE: 0xffffffff,
  MAX_LSN: (1n << 64n) - 1n,
  /** `pg_get_wal_replay_pause_state()` вне паузы; любое другое значение — пауза. */
  NOT_PAUSED: 'not paused',
} as const;
deepFreeze(WAL_FORMAT);
