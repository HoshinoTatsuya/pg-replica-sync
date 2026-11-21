/** Настройка маршрутизатора или кодека токенов неверна: отказ при создании, а не при первом чтении. */
export class InvalidReplicaSyncOptionsError extends Error {
  override readonly name = 'InvalidReplicaSyncOptionsError';
}
