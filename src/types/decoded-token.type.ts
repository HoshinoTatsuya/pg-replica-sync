import type { WalPosition } from './wal-position.type';

/**
 * Итог разбора токена: позиция, «выдан без позиции» или отказ разбора.
 * `issuedAt` — момент выдачи, мс эпохи Unix по часам выдавшего процесса.
 */
export type DecodedToken =
  | { readonly kind: 'position'; readonly position: WalPosition; readonly issuedAt: number }
  | { readonly kind: 'unresolved'; readonly issuedAt: number }
  | { readonly kind: 'invalid'; readonly detail: string };
