/**
 * `COMMIT` не закоммитил: транзакция была в состоянии ошибки, и Postgres ответил
 * `ROLLBACK` без исключения. Записи нет — и токена после неё быть не должно.
 */
export class TransactionNotCommittedError extends Error {
  override readonly name = 'TransactionNotCommittedError';

  constructor(readonly command: string) {
    super(`COMMIT завершился как ${JSON.stringify(command)}: транзакция откачена, запись не прошла`);
  }
}
