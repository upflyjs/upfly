import { describe, expect, it } from 'vitest';
import { buildGraph } from '../graph/graph.js';
import type { Asset, ExcludedRoot, RawReference, Reference, UnscannedFile } from '../types.js';
import { checkMoveRegression } from './move-check.js';

/**
 * The disclosure that travels with a move's regression count.
 *
 * These tests pin its shape: that it is present, that it survives the cases where it
 * looks unnecessary, and that it names what a reader can act on. They cannot judge its
 * wording; reading the rendered output is how that gets checked.
 *
 * Graphs go through the real `buildGraph`, so `unscannedExtensions` is counted by the
 * code that counts it in production. A hand-written extension table could let the
 * ordering test pass against data the real counter never produces.
 */

const ROOT = '/repo';

/** One unread file per entry, so the real extension counter does the counting. */
function unreadFiles(spec: readonly { ext: string; count: number }[]): UnscannedFile[] {
  const files: UnscannedFile[] = [];
  for (const { ext, count } of spec) {
    for (let index = 0; index < count; index++) {
      files.push({
        path: `${ROOT}/unread/f${index}${ext}`,
        relative: `unread/f${index}${ext}`,
        extension: ext,
        reason: 'unclaimed-extension',
        detail: '',
      });
    }
  }
  return files;
}

/** Files of a type Upfly reads that the scan could not parse. */
function parseFailures(spec: readonly { relative: string; detail: string }[]): UnscannedFile[] {
  return spec.map((entry) => ({
    path: `${ROOT}/${entry.relative}`,
    relative: entry.relative,
    extension: entry.relative.slice(entry.relative.lastIndexOf('.')),
    reason: 'parse-failed' as const,
    detail: entry.detail,
  }));
}

/** A graph with `broken` broken references and whatever went unread. */
function graphWith(input: {
  broken: number;
  unread?: readonly { ext: string; count: number }[];
  failed?: readonly { relative: string; detail: string }[];
}) {
  const assets: Asset[] = [
    { path: `${ROOT}/public/hero.png`, relative: 'public/hero.png', extension: '.png', bytes: 10 },
  ];
  const base: Omit<RawReference, 'file' | 'rawPath' | 'start' | 'end'> = {
    kind: 'attr',
    shape: 'html.img.src',
    ceiling: 'high',
    asserted: true,
  };
  // The `Reference` union requires `confidence: 'unsafe'` and `resolvedPath: null` of
  // anything not resolved. A reference in a state the engine cannot produce would make
  // every assertion below true of data no run can create, so the data follows the type
  // rather than being cast through `unknown`.
  const references: Reference[] = Array.from({ length: input.broken }, (_, index) => ({
    ...base,
    file: `${ROOT}/page${index}.html`,
    rawPath: '/gone.png',
    start: 10,
    end: 20,
    resolution: 'broken' as const,
    confidence: 'unsafe' as const,
    resolvedPath: null,
  }));

  return buildGraph({
    root: ROOT,
    assets,
    references,
    unscannedFiles: [...unreadFiles(input.unread ?? []), ...parseFailures(input.failed ?? [])],
  });
}

function excluded(names: readonly string[]): ExcludedRoot[] {
  return names.map((name) => ({
    path: `${ROOT}/${name}`,
    relative: name,
    reason: `a build or version-control directory named '${name}'`,
    byRule: false,
  }));
}

/** The whole disclosure as one string, which is how a reader meets it. */
function rendered(check: { lines: readonly string[] }): string {
  return check.lines.join('\n');
}

describe('a move’s regression count, and what it cannot see', () => {
  it('never states the count without stating its limit', () => {
    // The sentence that matters is "no new broken references". The qualifier has to
    // travel with it, because a reader who reads one line reads that one.
    const check = checkMoveRegression({
      before: graphWith({ broken: 111 }),
      after: graphWith({ broken: 111 }),
      excludedRoots: [],
    });

    expect(check.regressed).toBe(false);
    expect(rendered(check)).toContain('no new broken references among those Upfly can parse');
    expect(rendered(check)).toContain('What that count cannot see');
    // The circularity itself is named, not just its consequence: a reader cannot weigh
    // the number without knowing that one graph produced both sides of it.
    expect(rendered(check)).toContain('same graph');
  });

  it('still states the limit when nothing went unread at all', () => {
    // A tree where every file was read is where the count looks most like a guarantee,
    // and a caveat that disappeared there would turn the clean case into the false one.
    // The class is absent from this tree, not from the check.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({ broken: 0 }),
      excludedRoots: [],
    });

    expect(check.limit.typesThatCouldHide).toEqual([]);
    expect(check.limit.unreadFileCount).toBe(0);
    expect(rendered(check)).toContain('could have broken without');
    expect(rendered(check)).toContain('No unread file in this tree could hold a path');
    // Runtime-assembled paths are not a property of the tree, so this one has no
    // escape hatch in any tree.
    expect(rendered(check)).toContain('assembles at runtime');
  });

  it('states the limit on a regression too, not only on a clean run', () => {
    // A regression of 3 is just as silent about a fourth break it could not see.
    // Hiding the caveat exactly when the move has proven fallible is backwards.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0, unread: [{ ext: '.yml', count: 1 }] }),
      after: graphWith({ broken: 3, unread: [{ ext: '.yml', count: 1 }] }),
      excludedRoots: [],
    });

    expect(check.regressed).toBe(true);
    expect(rendered(check)).toContain('regression:');
    expect(rendered(check)).toContain('3 references Upfly can parse broke in this move');

    // Assert the bullets, not the heading: `render` pushes `What that count cannot see`
    // before the conditional bullets, so a change that suppressed every bullet on a
    // regression would leave the heading standing and this test green.
    expect(rendered(check)).toContain('could have broken without');
    expect(rendered(check)).toContain('.yml: 1 file');
    expect(rendered(check)).toContain('assembles at runtime');
  });

  it('names parse failures separately, because they are fixable and the types are not', () => {
    // A parse failure is the likeliest place a break hides: the failure that hides a
    // reference to the moved asset also hides its breakage, so the count stays level.
    // Grouped by extension, the failures would read as "Upfly cannot read HTML" rather
    // than one invalid construct in one file. See "What "broken before versus after" can
    // see" in ARCHITECTURE.md.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({
        broken: 0,
        failed: [
          { relative: 'bratislava.html', detail: 'invalid css syntax at line 16, column 5' },
        ],
      }),
      excludedRoots: [],
    });

    expect(check.limit.parseFailed.map((entry) => entry.relative)).toEqual(['bratislava.html']);
    const text = rendered(check);
    expect(text).toContain('of a type Upfly reads could not be parsed');
    // Named individually with the parser's complaint: unlike an unread type, this is one
    // file a person can open.
    expect(text).toContain('bratislava.html: invalid css syntax at line 16, column 5');
    expect(text).toContain('usually fixable');
  });

  it('says nothing about parse failures when there were none', () => {
    // Here so the assertion above means something: a bullet that always prints proves
    // nothing about a tree that has them.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({ broken: 0, unread: [{ ext: '.yml', count: 1 }] }),
      excludedRoots: [],
    });

    expect(check.limit.parseFailed).toEqual([]);
    expect(rendered(check)).not.toContain('could not be parsed');
  });

  it('names an unread type that could hold a path, and not one that could not', () => {
    // The line `couldHideAReference` draws. A `.woff2` holds no path text, so naming it
    // would send a reader to look for a reference inside a font. `.svg` is named because
    // it can carry `<image href>` and nothing parses it.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({
        broken: 0,
        unread: [
          { ext: '.yml', count: 2 },
          { ext: '.woff2', count: 9 },
          { ext: '.svg', count: 1 },
        ],
      }),
      excludedRoots: [],
    });

    const named = check.limit.typesThatCouldHide.map((entry) => entry.ext);
    expect(named).toContain('.yml');
    expect(named).toContain('.svg');
    expect(named).not.toContain('.woff2');
    // And the count quoted to the reader excludes the font, or the sentence promises a
    // blind spot bigger than the one that exists.
    expect(check.limit.unreadFileCount).toBe(3);
  });

  it('names a database and compiled code, whose bytes can hold a path a page loads', () => {
    const could = ['.db', '.sqlite', '.wasm', '.node', '.bin', '.swf'];
    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({
        broken: 0,
        unread: [...could, '.mp4', '.zip'].map((ext) => ({ ext, count: 1 })),
      }),
      excludedRoots: [],
    });

    expect(check.limit.typesThatCouldHide.map((entry) => entry.ext)).toEqual([...could].sort());
    expect(check.limit.unreadFileCount).toBe(could.length);
  });

  it('names the types holding most files first, so truncation hides the smallest', () => {
    // In alphabetical order the one type that matters can sit behind "and 1 more". The
    // data below is built so the two orderings disagree: alphabetically `.aaa` leads, by
    // volume it is last. Names that sorted the same way under both orders would let an
    // alphabetical sort pass, so that premise is asserted rather than assumed.
    const unread = [
      { ext: '.aaa', count: 1 },
      { ext: '.bbb', count: 2 },
      { ext: '.ccc', count: 3 },
      { ext: '.ddd', count: 4 },
      { ext: '.eee', count: 5 },
      { ext: '.zzz', count: 900 },
    ];

    const alphabetical = [...unread].map((entry) => entry.ext).sort();
    const byVolume = [...unread].sort((a, b) => b.count - a.count).map((entry) => entry.ext);
    expect(alphabetical).not.toEqual(byVolume); // the premise, asserted

    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({ broken: 0, unread }),
      excludedRoots: [],
    });

    expect(check.limit.typesThatCouldHide.map((entry) => entry.ext)).toEqual(byVolume);
    // The biggest is named in the output; the smallest is the one summarised away.
    expect(rendered(check)).toContain('.zzz: 900 files');
    expect(rendered(check)).toContain('... and 1 more');
    expect(rendered(check)).not.toContain('.aaa:');
  });

  it('discloses directories nothing opened, and says they are outside the unread count', () => {
    // A reader told "2 files went unread" would otherwise take 2 for the whole blind
    // spot. An excluded directory's files were never seen, so they are absent from
    // that count as well as from the graph.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0, unread: [{ ext: '.yml', count: 2 }] }),
      after: graphWith({ broken: 0, unread: [{ ext: '.yml', count: 2 }] }),
      excludedRoots: excluded(['node_modules', 'tmp']),
    });

    expect(check.limit.neverRead.map((entry) => entry.relative)).toEqual(['node_modules', 'tmp']);
    expect(rendered(check)).toContain('2 directories went unopened');
    expect(rendered(check)).toContain('nothing inside is counted above either');
    // The rule that closed each one, so a reader can decide whether to care.
    expect(rendered(check)).toContain("a build or version-control directory named 'tmp'");
  });

  it('says nothing about excluded directories when there are none', () => {
    // The inverse of the test above, and it is here because a bullet that always
    // prints would make the previous assertion meaningless.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({ broken: 0 }),
      excludedRoots: [],
    });

    expect(check.limit.neverRead).toEqual([]);
    expect(rendered(check)).not.toContain('went unopened');
  });

  it('warns when the two sides of the comparison did not read the same files', () => {
    // Then part of the difference between the counts may be coverage rather than the
    // move, and the comparison is not like-for-like. It should not happen, since a move
    // relocates assets rather than sources, so it is surfaced rather than assumed away.
    const check = checkMoveRegression({
      before: graphWith({ broken: 2, unread: [{ ext: '.yml', count: 4 }] }),
      after: graphWith({ broken: 2, unread: [{ ext: '.yml', count: 2 }] }),
      excludedRoots: [],
    });

    expect(check.limit.readDifferently).toBe(true);
    expect(check.limit.unreadBefore).toBe(4);
    expect(check.limit.unreadAfter).toBe(2);
    expect(rendered(check)).toContain('did not read the same number of files');
    expect(rendered(check)).toContain('not like-for-like');
  });

  it('does not warn when both sides read the same files', () => {
    const check = checkMoveRegression({
      before: graphWith({ broken: 2, unread: [{ ext: '.yml', count: 4 }] }),
      after: graphWith({ broken: 2, unread: [{ ext: '.yml', count: 4 }] }),
      excludedRoots: [],
    });

    expect(check.limit.readDifferently).toBe(false);
    expect(rendered(check)).not.toContain('did not read the same number of files');
  });

  it('does not call a drop in broken references a success', () => {
    // A move repairs nothing, so fewer broken references than before means something
    // else changed. Reporting that as a clean run would be the reassuring version of
    // a result nobody has explained.
    const check = checkMoveRegression({
      before: graphWith({ broken: 5 }),
      after: graphWith({ broken: 4 }),
      excludedRoots: [],
    });

    expect(check.regressed).toBe(false);
    expect(rendered(check)).not.toContain('no new broken references');
    expect(rendered(check)).toContain('needs explaining');
  });

  it('does not offer a zero as proof when the break is in a file type nothing reads', () => {
    // A reference to a moved asset in `deploy/netlify.yml`, which nothing scans: the move
    // breaks it and both counts still read 0, which is the shape of the check. What the
    // output adds is that the `.yml` was never read, so the zero is not offered as proof.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0, unread: [{ ext: '.yml', count: 1 }] }),
      after: graphWith({ broken: 0, unread: [{ ext: '.yml', count: 1 }] }),
      excludedRoots: [],
    });

    expect(check.brokenBefore).toBe(0);
    expect(check.brokenAfter).toBe(0);
    expect(check.regressed).toBe(false);
    expect(rendered(check)).toContain('.yml: 1 file');
    expect(rendered(check)).toContain('could have broken without');
  });
});
