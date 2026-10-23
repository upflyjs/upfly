/**
 * A size in bytes as the CLI writes one: `70 B`, `52.6 KB`, `1.2 MB`, in powers of 1,000.
 *
 * @param value bytes
 */
export function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${tenths(value / 1_000)} KB`;
  if (value < 1_000_000_000) return `${tenths(value / 1_000_000)} MB`;
  return `${tenths(value / 1_000_000_000)} GB`;
}

/** One decimal place, without a trailing `.0`. */
function tenths(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

/**
 * A count and its noun, agreeing: `1 image`, `2 images`.
 *
 * @param count how many
 * @param noun the singular
 * @param many the plural, when adding `s` does not make it
 */
export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}
