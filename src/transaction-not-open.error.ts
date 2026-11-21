/**
 * На соединении, переданном в `commitAndIssueToken`, нет открытой транзакции:
 * COMMIT там ничего бы не закоммитил (Postgres ответил бы предупреждением с
 * тегом `COMMIT`), а транзакция вызывающего — если она на другом соединении —
 * осталась бы открытой, и токен оказался бы выдан до её COMMIT. Так бывает с
 * пулом и с любой обёрткой, которая отправляет запросы на случайное соединение.
 */
export class TransactionNotOpenError extends Error {
  override readonly name = 'TransactionNotOpenError';

  constructor() {
    super(
      'commitAndIssueToken: на этом соединении нет открытой транзакции — нужен клиент той транзакции, в которой шла запись (не пул и не обёртка над пулом); запись без BEGIN — issueToken(client)',
    );
  }
}
