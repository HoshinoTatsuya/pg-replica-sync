import type { ROUTE_REASON } from '../constants/route-reason.constant';

export type RouteReason = (typeof ROUTE_REASON)[keyof typeof ROUTE_REASON];
