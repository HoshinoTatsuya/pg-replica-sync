/** Раскладка WAL сервера (`pg_control_init()`): выравнивание, размер страницы и сегмента, байт. */
export interface WalLayout {
  readonly maxAlign: number;
  readonly blockSize: number;
  readonly segmentSize: number;
}
