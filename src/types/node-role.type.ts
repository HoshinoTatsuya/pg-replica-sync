import type { NODE_ROLE } from '../constants/node-role.constant';

export type NodeRole = (typeof NODE_ROLE)[keyof typeof NODE_ROLE];
