import { deepFreeze } from '../deep-freeze';

/** Роль узла, на который ушло чтение. */
export const NODE_ROLE = {
  primary: 'primary',
  replica: 'replica',
} as const;
deepFreeze(NODE_ROLE);
