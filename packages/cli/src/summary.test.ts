import type { DedupePlan } from 'upfly-core';
import { describe, expect, it } from 'vitest';
import { renderSummary } from './layout.js';
import { type Output, stylesFor } from './output.js';
import { type NextStep, dedupeSummary } from './summary.js';

/** A terminal showing 24-bit colour, as Node reports one. */
const terminal: Output = { write: () => true, isTTY: true, getColorDepth: () => 24 };
const styles = stylesFor(terminal, {}, { json: false, noColor: false });

const plan: DedupePlan = {
  sets: [
    {
      keep: 'img/a.png',
      kept: 'most-used',
      bytes: 100,
      copies: [{ path: 'img/b.png', references: 1, moved: 1, stays: [], unusedAfter: true }],
    },
  ],
  rewrites: [{ file: 'index.html', edits: [{ start: 0, end: 9, replacement: 'img/a.png' }] }],
};

function summaryWith(next: NextStep): string {
  return renderSummary(
    dedupeSummary({
      plan,
      apply: false,
      manifest: null,
      commit: null,
      git: { kind: 'not-a-repository' },
      notes: [],
      file: { written: '.upfly/report.txt' },
      next,
      upfly: 'npx upfly',
    }),
    styles,
  );
}

describe('the next step', () => {
  it('prints a command in bold, the one value that is, so it can be found and copied', () => {
    const text = summaryWith({ words: ['upfly', 'dedupe', '--apply'], text: 'unused' });
    expect(text).toContain('mNext\u001b[22;39m         \u001b[1mupfly dedupe --apply\u001b[22m\n');
    expect(text).toContain('mSets\u001b[22;39m         1 set of identical images, 2 files\n');
  });

  it('prints a step in words at the weight of the rest', () => {
    const text = summaryWith({
      words: null,
      text: 'commit or stash your changes, then add --apply',
    });
    expect(text).toContain(
      'mNext\u001b[22;39m         commit or stash your changes, then add --apply\n',
    );
  });
});
