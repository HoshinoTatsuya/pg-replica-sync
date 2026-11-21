import { EXCLUSION_REASON } from './constants/exclusion-reason.constant';
import { evaluateReplica } from './evaluate-replica';
import { parseLsn } from './parse-lsn';
import type { NodeState } from './types/node-state.type';
import type { ProbeOutcome } from './types/probe-outcome.type';
import type { ReplicaRequirement } from './types/replica-requirement.type';

const SYSTEM = '7708384681250484264';
const REPLICA: NodeState = {
  inRecovery: true,
  systemId: SYSTEM,
  instance: `${SYSTEM}@2026-01-01 00:00:00+00`,
  replayLsn: parseLsn('10/0'),
  insertLsn: null,
  tokenLsn: null,
  timeline: 1,
  paused: false,
  hasStatsPrivilege: true,
  writePending: false,
};
const ok = (patch: Partial<NodeState> = {}): ProbeOutcome => ({ ok: true, state: { ...REPLICA, ...patch } });
const token = (lsn: string, timeline = 1, systemId = SYSTEM): ReplicaRequirement => ({
  kind: 'position',
  position: { systemId, timeline, lsn: parseLsn(lsn) },
});
const lag = (primaryInsert: string, maxLagBytes: bigint): ReplicaRequirement => ({
  kind: 'lag',
  systemId: SYSTEM,
  timeline: 1,
  primaryInsertLsn: parseLsn(primaryInsert),
  maxLagBytes,
});

describe('подходит ли реплика', () => {
  it('догнала позицию токена на границе 32 бит: 10/0 ≥ 9/FFFFFFFF и ≥ 10/0, но < 10/1', () => {
    expect(evaluateReplica(ok(), token('9/FFFFFFFF'))).toBeNull();
    expect(evaluateReplica(ok(), token('10/0'))).toBeNull();
    expect(evaluateReplica(ok(), token('10/1'))).toBe(EXCLUSION_REASON.behind);
    expect(evaluateReplica(ok({ replayLsn: parseLsn('0/FFFFFFFF') }), token('1/0'))).toBe(
      EXCLUSION_REASON.behind,
    );
    expect(evaluateReplica(ok({ replayLsn: parseLsn('9/0') }), token('10/0'))).toBe(EXCLUSION_REASON.behind);
  });

  it('без токена: отставание от позиции вставки мастера — в потолке включительно', () => {
    expect(evaluateReplica(ok(), lag('10/100', 256n))).toBeNull();
    expect(evaluateReplica(ok(), lag('10/101', 256n))).toBe(EXCLUSION_REASON.lagExceeded);
    expect(evaluateReplica(ok(), lag('11/0', 256n))).toBe(EXCLUSION_REASON.lagExceeded);
    expect(evaluateReplica(ok(), lag('F/0', 0n))).toBeNull();
  });

  it('«не смогли определить» любое поле — исключение, а не допуск', () => {
    expect(evaluateReplica({ ok: false, error: new Error('x') }, token('0/0'))).toBe(
      EXCLUSION_REASON.unavailable,
    );
    expect(evaluateReplica(ok({ replayLsn: null }), token('0/0'))).toBe(EXCLUSION_REASON.stateUnknown);
    expect(evaluateReplica(ok({ replayLsn: null }), lag('0/0', 1n << 62n))).toBe(
      EXCLUSION_REASON.stateUnknown,
    );
    expect(evaluateReplica(ok({ systemId: null }), token('0/0'))).toBe(EXCLUSION_REASON.stateUnknown);
    expect(evaluateReplica(ok({ timeline: null }), token('0/0'))).toBe(EXCLUSION_REASON.timelineUnknown);
    expect(evaluateReplica(ok({ timeline: null, hasStatsPrivilege: false }), token('0/0'))).toBe(
      EXCLUSION_REASON.noStatsPrivilege,
    );
  });

  it('стала мастером, на паузе, другая линия времени, другой кластер — исключение при любой позиции', () => {
    expect(evaluateReplica(ok({ inRecovery: false }), token('0/0'))).toBe(EXCLUSION_REASON.promoted);
    expect(evaluateReplica(ok({ paused: true }), token('0/0'))).toBe(EXCLUSION_REASON.paused);
    expect(evaluateReplica(ok(), token('0/0', 2))).toBe(EXCLUSION_REASON.timelineMismatch);
    expect(evaluateReplica(ok({ timeline: 2 }), lag('10/0', 1n << 62n))).toBe(
      EXCLUSION_REASON.timelineMismatch,
    );
    expect(evaluateReplica(ok(), token('0/0', 1, '1'))).toBe(EXCLUSION_REASON.otherCluster);
  });
});
