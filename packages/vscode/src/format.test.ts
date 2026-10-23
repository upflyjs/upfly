import { formatBytes as engineFormatBytes } from 'upfly-core/internal';
import { describe, expect, it } from 'vitest';
import { formatBytes, plural } from './format.js';

describe('formatBytes', () => {
  it('writes sizes as the CLI writes them, so the editor and the terminal agree', () => {
    for (const bytes of [
      0, 1, 999, 1_000, 1_049, 1_050, 52_600, 999_949, 999_950, 1_234_567, 5e9,
    ]) {
      expect(formatBytes(bytes)).toBe(engineFormatBytes(bytes));
    }
  });
});

describe('plural', () => {
  it('agrees the noun with its count', () => {
    expect([plural(0, 'image'), plural(1, 'image'), plural(2, 'image')]).toEqual([
      '0 images',
      '1 image',
      '2 images',
    ]);
  });

  it('takes the plural it is given for a noun that is not regular', () => {
    expect(plural(2, 'copy', 'copies')).toBe('2 copies');
  });
});
