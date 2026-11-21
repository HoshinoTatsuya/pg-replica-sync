import type { WalLayout } from './types/wal-layout.type';

/** `[max_data_alignment, wal_block_size, bytes_per_wal_segment]` из зонда → раскладка или null, если не в форме. */
export function walLayoutOf(raw: unknown): WalLayout | null {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return null;
  }
  const [maxAlign, blockSize, segmentSize] = raw.map((item) =>
    typeof item === 'string' ? Number(item) : item,
  );
  const positive = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) > 0;
  if (
    !positive(maxAlign) ||
    !positive(blockSize) ||
    !positive(segmentSize) ||
    segmentSize % blockSize !== 0
  ) {
    return null;
  }
  return { maxAlign, blockSize, segmentSize };
}
