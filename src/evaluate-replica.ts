import { compareLsn } from './compare-lsn';
import { EXCLUSION_REASON } from './constants/exclusion-reason.constant';
import { lagBytes } from './lag-bytes';
import type { ExclusionReason } from './types/exclusion-reason.type';
import type { ProbeOutcome } from './types/probe-outcome.type';
import type { ReplicaRequirement } from './types/replica-requirement.type';

/**
 * Подходит ли реплика: `null` — да, иначе причина. Допуск — только когда КАЖДОЕ
 * условие установлено: «не смогли определить» любое поле — исключение.
 * Порядок проверок задаёт, какая причина назовётся, когда их несколько.
 */
export function evaluateReplica(
  outcome: ProbeOutcome,
  requirement: ReplicaRequirement,
): ExclusionReason | null {
  if (!outcome.ok) {
    return EXCLUSION_REASON.unavailable;
  }
  const state = outcome.state;
  if (!state.inRecovery) {
    return EXCLUSION_REASON.promoted;
  }
  if (state.paused) {
    return EXCLUSION_REASON.paused;
  }
  const systemId = requirement.kind === 'position' ? requirement.position.systemId : requirement.systemId;
  if (state.systemId === null) {
    return EXCLUSION_REASON.stateUnknown;
  }
  if (state.systemId !== systemId) {
    return EXCLUSION_REASON.otherCluster;
  }
  if (state.timeline === null) {
    return state.hasStatsPrivilege ? EXCLUSION_REASON.timelineUnknown : EXCLUSION_REASON.noStatsPrivilege;
  }
  const timeline = requirement.kind === 'position' ? requirement.position.timeline : requirement.timeline;
  if (state.timeline !== timeline) {
    return EXCLUSION_REASON.timelineMismatch;
  }
  if (state.replayLsn === null) {
    return EXCLUSION_REASON.stateUnknown;
  }
  if (requirement.kind === 'position') {
    return compareLsn(state.replayLsn, requirement.position.lsn) >= 0 ? null : EXCLUSION_REASON.behind;
  }
  return lagBytes(requirement.primaryInsertLsn, state.replayLsn) <= requirement.maxLagBytes
    ? null
    : EXCLUSION_REASON.lagExceeded;
}
