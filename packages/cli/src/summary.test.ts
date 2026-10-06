import type { DedupePlan } from 'upfly-core';
import type { MovePlan } from 'upfly-core/internal';
import { describe, expect, it } from 'vitest';
import { renderSummary } from './layout.js';
import { type Output, stylesFor } from './output.js';
import { type NextStep, dedupeSummary, moveSummary } from './summary.js';

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

/**
 * A move of one image with `unfollowed` lines still naming its old path and `declined`
 * references that cannot follow it.
 */
function movePlan(unfollowed: number, declined: number): MovePlan {
  return {
    moves: [{ from: 'public/hero.png', to: 'public/img/hero.png' }],
    rewrites: [
      { file: 'index.html', edits: [{ start: 10, end: 19, replacement: '/img/hero.png' }] },
    ],
    refused: [],
    declined: Array.from({ length: declined }, (_, n) => ({
      file: 'app.js',
      line: n + 1,
      where: `app.js:${n + 1}`,
      text: 'hero',
      why: 'a template reference is assembled at runtime, so its text cannot be repointed',
    })),
    unfollowed: Array.from({ length: unfollowed }, (_, n) => ({
      image: 'public/hero.png',
      file: 'src/seo.ts',
      line: n + 1,
      text: 'https://example.com/hero.png',
      reason: 'full-address' as const,
      why: "a full address, which Upfly never rewrites: it cannot tell which host is the site's own",
    })),
  };
}

function moveRuns(plan: MovePlan) {
  return moveSummary({
    plan,
    apply: false,
    manifest: null,
    commit: null,
    git: { kind: 'not-a-repository' },
    notes: [],
    file: { written: '.upfly/move.txt' },
    next: null,
  });
}

function rowValue(plan: MovePlan, label: string): string | undefined {
  const rows = moveRuns(plan).sections.flat();
  return rows.find((row) => row.label === label)?.value.join('');
}

describe('a move', () => {
  it('says how many lines still name an old path with verbs that agree with the count', () => {
    expect(moveRuns(movePlan(1, 0)).closing).toContain(
      ' 1 line still names an old path and stays as written.',
    );
    expect(moveRuns(movePlan(2, 0)).closing).toContain(
      ' 2 lines still name an old path and stay as written.',
    );
    expect(rowValue(movePlan(1, 0), 'Not followed')).toBe('1 line still names an old path');
    expect(rowValue(movePlan(2, 0), 'Not followed')).toBe('2 lines still name an old path');
  });

  it('says a reference that cannot follow breaks, and two of them break', () => {
    expect(rowValue(movePlan(0, 1), 'Cannot follow')).toBe(
      '1 reference, which breaks unless changed by hand',
    );
    expect(rowValue(movePlan(0, 2), 'Cannot follow')).toBe(
      '2 references, which break unless changed by hand',
    );
  });
});
