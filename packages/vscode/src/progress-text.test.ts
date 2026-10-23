import { describe, expect, it } from 'vitest';
import type { ProgressLine } from './contract.js';
import { progressText } from './progress-text.js';

function line(fields: Record<string, unknown>): ProgressLine {
  return { type: 'progress', command: 'audit', ...fields } as ProgressLine;
}

describe('progressText', () => {
  it('names the files being read once the images are found', () => {
    expect(progressText(line({ stage: 'discovered', images: 12, files: 7 }))).toBe(
      'reading 7 files',
    );
  });

  it('agrees the noun with a count of one', () => {
    expect(progressText(line({ stage: 'scanned', references: 1 }))).toBe('resolving 1 reference');
  });

  it('counts the images measured so far', () => {
    expect(progressText(line({ stage: 'measuring', done: 3, total: 12 }))).toBe(
      'measuring images: 3 of 12',
    );
  });

  it('says what refs does after its plan: it searches every file', () => {
    const planned = { ...line({ stage: 'planned', conversions: 1, rewrites: 2 }), command: 'refs' };
    expect(progressText(planned as ProgressLine)).toBe('searching every file');
  });

  it('says what audit does once its findings are in: it writes up the report', () => {
    expect(progressText(line({ stage: 'audited', findings: 4 }))).toBe('writing the report');
  });
});
