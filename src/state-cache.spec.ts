import { parseLsn } from './parse-lsn';
import { StateCache } from './state-cache';
import type { ProbeOutcome } from './types/probe-outcome.type';

const OK: ProbeOutcome = {
  ok: true,
  state: {
    inRecovery: true,
    systemId: '1',
    instance: '1@2026-01-01 00:00:00+00',
    replayLsn: parseLsn('0/10'),
    insertLsn: null,
    tokenLsn: null,
    timeline: 1,
    paused: false,
    hasStatsPrivilege: true,
    writePending: false,
  },
};
const FAILED: ProbeOutcome = { ok: false, error: new Error('нет связи') };
const PROBE = { seq: 1, startedAt: 0 };

describe('кэш состояния узлов', () => {
  it('запись живёт ровно потолок и выселяется, а не только перестаёт читаться', () => {
    let now = 1_000;
    const cache = new StateCache(new Set(['r1', 'r2']), 100, 500, () => now);
    cache.set('r1', OK, PROBE);
    cache.set('r2', FAILED, PROBE);
    now += 99;
    expect(cache.get('r1')?.outcome).toBe(OK);
    expect(cache.size).toBe(2);
    now += 1;
    expect(cache.get('r1')).toBeUndefined();
    expect(cache.size).toBe(1);
    expect(cache.get('r2')?.outcome).toBe(FAILED);
    now += 400;
    expect(cache.size).toBe(0);
  });

  it('ключи — только узлы настройки: чужой ключ — отказ', () => {
    const cache = new StateCache(new Set(['r1']), 100, 100, () => 0);
    expect(() => cache.set('r9', OK, PROBE)).toThrow('не из настройки');
    expect(cache.size).toBe(0);
  });

  it('часы шагнули назад: все записи выселены (иначе прожили бы лишний час), дальше — по новым часам', () => {
    let now = 3_600_000;
    const cache = new StateCache(new Set(['r1', 'r2']), 100, 500, () => now);
    cache.set('r1', OK, PROBE);
    cache.set('r2', FAILED, PROBE);
    now += 50;
    expect(cache.size).toBe(2);
    now = 1_000;
    expect(cache.get('r1')).toBeUndefined();
    expect(cache.size).toBe(0);
    // Контроль: по новым часам кэш снова работает с тем же потолком.
    cache.set('r1', OK, PROBE);
    now += 99;
    expect(cache.get('r1')?.outcome).toBe(OK);
    now += 1;
    expect(cache.get('r1')).toBeUndefined();
  });

  it('часы стоят на месте — не шаг назад: запись живёт', () => {
    const cache = new StateCache(new Set(['r1']), 100, 100, () => 5);
    cache.set('r1', OK, PROBE);
    expect(cache.get('r1')?.outcome).toBe(OK);
    expect(cache.get('r1')?.outcome).toBe(OK);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined as unknown as number],
  ])('часы вернули не-число (%s): записи выселены и не кладутся', (_label, bad) => {
    let now: number = 0;
    const cache = new StateCache(new Set(['r1']), 100, 100, () => now);
    cache.set('r1', OK, PROBE);
    now = bad;
    expect(cache.get('r1')).toBeUndefined();
    cache.set('r1', OK, PROBE);
    expect(cache.size).toBe(0);
    now = 10;
    expect(cache.get('r1')).toBeUndefined();
  });
});
