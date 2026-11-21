import type { EXCLUSION_REASON } from '../constants/exclusion-reason.constant';

export type ExclusionReason = (typeof EXCLUSION_REASON)[keyof typeof EXCLUSION_REASON];
