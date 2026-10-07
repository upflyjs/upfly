import { describe, expect, it } from 'vitest';
import { compareStrings } from '../paths.js';
import { findSurvivingPaths, respellAs, spellingsFor } from './old-path-search.js';

/**
 * Searching for an old path without asking the graph.
 *
 * The tests that matter here are about what is searched for, not the searching. A
 * substring search is hard to get wrong; choosing the needle is where this check lives or
 * dies. Search the basename and every move looks like a disaster, because the asset still
 * has that name at its new home.
 */

const SERVING = ['public'];

/** A tiny in-memory tree. Nothing here touches a disk or a graph. */
function search(files: Record<string, string>, from: string, servingDirs = SERVING) {
  return findSurvivingPaths({
    moves: [{ from, to: 'public/moved/hero.png' }],
    files: Object.keys(files),
    readFile: async (relative) => {
      const text = files[relative];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    servingDirs,
  });
}

describe('the spellings an old path is searched for', () => {
  it('never searches the basename alone, because a move keeps the filename', () => {
    // After `public/img/hero.png` moves to `public/moved/hero.png`, every reference to the
    // new location still contains `hero.png`. A basename search would report all of them
    // as survivors, and a check whose noise cannot be told from its signal is worse than
    // no check.
    const spellings = spellingsFor('public/img/hero.png', SERVING);
    expect(spellings).not.toContain('hero.png');
    // Every spelling carries a directory separator, of either kind: one of them is the
    // Windows variant, `public\img\hero.png`.
    for (const spelling of spellings) {
      expect(spelling.includes('/') || spelling.includes('\\')).toBe(true);
    }
  });

  it('derives the URL spelling, which is the one that appears in markup', () => {
    // `public/img/hero.png` is served at `/img/hero.png`, and that is what an `<img src>`
    // actually says. Searching only the project-relative path would miss every one.
    expect(spellingsFor('public/img/hero.png', SERVING)).toContain('/img/hero.png');
  });

  it('treats an empty serving directory as the project root being served', () => {
    // The `''` case, which is easy to get backwards. The leading-slash spelling comes from
    // the base set every path gets, so no branch for `''` is needed to produce it.
    expect(spellingsFor('img/hero.png', [''])).toContain('/img/hero.png');
    // And `''` must not be treated as a prefix that strips nothing and yields `/`.
    expect(spellingsFor('img/hero.png', [''])).not.toContain('/');
  });

  it('does not treat a serving directory as a bare string prefix', () => {
    // `static` is a serving root and `staticky/logo.png` merely starts with those letters.
    // Stripping the prefix without requiring a separator would yield the URL
    // `/ky/logo.png`, a spelling that exists nowhere, searched for across the whole tree.
    const spellings = spellingsFor('staticky/logo.png', ['static']);
    expect(spellings).not.toContain('/ky/logo.png');
    expect(spellings).toContain('staticky/logo.png');
  });

  it('keeps a parent directory, so relative spellings are caught', () => {
    // `./img/hero.png` and `../../img/hero.png` both end in `img/hero.png`.
    expect(spellingsFor('public/img/hero.png', SERVING)).toContain('img/hero.png');
  });

  it('searches a backslash spelling too, for generated manifests', () => {
    expect(spellingsFor('public/img/hero.png', SERVING)).toContain('public\\img\\hero.png');
  });
});

describe('exchanging one path’s spelling for another’s', () => {
  it('answers in the kind of spelling the text used', () => {
    const from = 'public/img/hero.png';
    const to = 'public/img/hero.webp';
    const cases: [string, string | null][] = [
      ['/img/hero.png', '/img/hero.webp'],
      ['public/img/hero.png', 'public/img/hero.webp'],
      ['img/hero.png', 'img/hero.webp'],
      ['public\\img\\hero.png', 'public\\img\\hero.webp'],
      ['/public/img/hero.png', '/public/img/hero.webp'],
      ['hero.png', null],
    ];
    for (const [written, expected] of cases) {
      expect(respellAs(written, from, to, SERVING), written).toBe(expected);
    }
  });

  it('answers for a move out of the served folder only where the spelling has a counterpart', () => {
    const from = 'public/img/hero.png';
    const to = 'src/assets/hero.png';

    // The URL of a served image has no counterpart outside every serving directory: no
    // address reaches the new place, which is why the move lists such a line instead.
    expect(respellAs('/img/hero.png', from, to, SERVING)).toBeNull();
    expect(respellAs('public/img/hero.png', from, to, SERVING)).toBe('src/assets/hero.png');
    expect(respellAs('img/hero.png', from, to, SERVING)).toBe('assets/hero.png');
  });

  it('leaves a mention written in another letter case alone', () => {
    expect(respellAs('/IMG/Hero.PNG', 'public/img/hero.png', 'public/img/hero.webp', SERVING)).toBe(
      null,
    );
  });
});

describe('searching for what the move left behind', () => {
  it('finds a literal reference in a file type nothing parses', async () => {
    // A reference to a moved asset in `deploy/netlify.yml`. The move's regression count
    // can only disclose that `.yml` went unread; this search finds the line.
    const result = await search(
      { 'deploy/netlify.yml': 'from = "/img/hero.png"\nto = "/somewhere"\n' },
      'public/img/hero.png',
    );

    expect(result.survivors).toHaveLength(1);
    expect(result.survivors[0]?.file).toBe('deploy/netlify.yml');
    expect(result.survivors[0]?.line).toBe(1);
    expect(result.survivors[0]?.text).toContain('/img/hero.png');
  });

  it('finds the old path in another letter case, reporting it as the file spells it', async () => {
    // Windows and macOS find `public/img/hero.png` by `/IMG/Hero.png`, so a page naming it
    // that way still loads the old file there.
    const result = await search(
      { 'layout.njk': '<p>\n<img src="/IMG/Hero.png">\n' },
      'public/img/hero.png',
    );

    expect(result.survivors.map(({ line, spelling }) => [line, spelling])).toEqual([
      [2, '/IMG/Hero.png'],
    ]);
  });

  it('does not match a reference to the new location', async () => {
    // The premise of the whole design. `moved/hero.png` shares a basename with the old
    // path and must not match. If this ever passes with a basename search, the test data
    // no longer satisfies its premise: the old and new directories must differ.
    const result = await search(
      { 'page.html': '<img src="/moved/hero.png">' },
      'public/img/hero.png',
    );
    expect(result.survivors).toEqual([]);
  });

  it('does not report the rewrite it just made as a survivor', async () => {
    // An asset at the serving root has a URL that is its file name with a slash in
    // front, so the old URL (`/hero.png`) is a suffix of the new one
    // (`/upfly-moved/hero.png`). Unless matches inside a destination are discounted, a
    // correct rewrite comes back as a survivor: a success reported as a failure, the most
    // misleading thing this check could say.
    const result = await findSurvivingPaths({
      moves: [{ from: 'public/hero.png', to: 'public/upfly-moved/hero.png' }],
      files: ['routeData.ts'],
      readFile: async () => "const src = ogImageUrl ?? '/upfly-moved/hero.png';",
      servingDirs: SERVING,
    });

    expect(result.survivors).toEqual([]);
  });

  it('still reports a genuine survivor in a file that also holds the new path', async () => {
    // The inverse, which keeps the discount above from being a blanket exemption: a file
    // may hold both the rewritten reference and one that was missed.
    const result = await findSurvivingPaths({
      moves: [{ from: 'public/hero.png', to: 'public/upfly-moved/hero.png' }],
      files: ['both.html'],
      readFile: async () => '<img src="/upfly-moved/hero.png">\n<meta content="/hero.png">\n',
      servingDirs: SERVING,
    });

    expect(result.survivors).toHaveLength(1);
    expect(result.survivors[0]?.line).toBe(2);
  });

  it('reports one occurrence per line, not one per spelling that matched', async () => {
    // `/img/hero.png` contains the suffix `img/hero.png`, so a naive loop reports the same
    // line twice and the count says two occurrences where a reader can see one.
    const result = await search({ 'a.yml': 'src: /img/hero.png' }, 'public/img/hero.png');
    expect(result.survivors).toHaveLength(1);
  });

  it('finds several occurrences across files and orders them predictably', async () => {
    const result = await search(
      {
        'z.yml': 'a: /img/hero.png',
        'a.yml': 'b: /img/hero.png',
        'm.yml': 'nothing here',
      },
      'public/img/hero.png',
    );

    expect(result.survivors.map((s) => s.file)).toEqual(['a.yml', 'z.yml']);
    expect(result.filesSearched).toBe(3);
  });

  it('reports a file it could not read rather than counting it as clean', async () => {
    // A file the search could not read is a hole in its "nothing found", so it is named,
    // not skipped.
    const result = await findSurvivingPaths({
      moves: [{ from: 'public/img/hero.png', to: 'public/moved/hero.png' }],
      files: ['gone.yml'],
      readFile: async () => {
        throw new Error('ENOENT');
      },
      servingDirs: SERVING,
    });

    expect(result.survivors).toEqual([]);
    expect(result.filesSearched).toBe(0);
    expect(result.unsearchable.map((entry) => entry.file)).toEqual(['gone.yml']);
    expect(result.lines.join('\n')).toContain('could not be read at all');
  });

  it('states its limits even when it finds nothing', async () => {
    // As with the move's regression count: a clean result is where an unstated limit is
    // read as a guarantee, and this check has a large one.
    const result = await search({ 'a.yml': 'nothing' }, 'public/img/hero.png');

    expect(result.survivors).toEqual([]);
    const rendered = result.lines.join('\n');
    expect(rendered).toContain('What this search cannot see');
    expect(rendered).toContain('assembles at runtime');
    expect(rendered).toContain('excluded by an ignore rule');
    // The spellings are printed so the search can be repeated by hand.
    expect(rendered).toContain('/img/hero.png');
  });

  it('says a survivor is an occurrence to check, not a reference we broke', async () => {
    // It reads text, so it cannot tell a broken reference from prose or a changelog. The
    // honest word is the whole point: reporting a coincidence costs a glance, and the
    // alternative wording would make a coincidence look like a defect.
    const result = await search(
      { 'CHANGELOG.md': 'moved /img/hero.png away' },
      'public/img/hero.png',
    );

    expect(result.survivors).toHaveLength(1);
    expect(result.lines.join('\n')).toContain('to check');
    expect(result.lines.join('\n')).toContain('coincidence');
  });
});

describe('searching every file once, with exactly the answers of one search per spelling', () => {
  /**
   * The search sweeps each file once for every spelling. What it finds must be exactly
   * what one `indexOf` loop per spelling finds, occurrence for occurrence, so that simple
   * algorithm is kept here as the oracle and the search is compared against it rather than
   * against expectations written by hand.
   */
  type Move = { from: string; to: string };

  /** The oracle: one `indexOf` loop per spelling, and per destination, per file. */
  function oneSearchPerSpelling(
    moves: readonly Move[],
    files: Readonly<Record<string, string>>,
    servingDirs: readonly string[],
  ) {
    const spellings = [
      ...new Set(moves.flatMap((move) => spellingsFor(move.from, servingDirs))),
    ].sort((a, b) => b.length - a.length || compareStrings(a, b));
    const destinations = [...new Set(moves.flatMap((move) => spellingsFor(move.to, servingDirs)))];

    const survivors = Object.keys(files)
      .sort(compareStrings)
      .flatMap((file) => oneFileAsBefore(file, files[file] ?? '', spellings, destinations));
    survivors.sort(
      (a, b) =>
        compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.spelling, b.spelling),
    );
    return { spellings, survivors };
  }

  /**
   * One file, searched in any letter case: the text and the needles in lower case, which keeps
   * every offset for the generator's ASCII, and each match reported as the file spells it.
   */
  function oneFileAsBefore(
    file: string,
    text: string,
    spellings: readonly string[],
    destinations: readonly string[],
  ) {
    const lower = text.toLowerCase();
    const spans: [number, number][] = [];
    for (const needle of new Set(destinations.map((each) => each.toLowerCase()))) {
      for (
        let at = lower.indexOf(needle);
        at !== -1;
        at = lower.indexOf(needle, at + needle.length)
      ) {
        spans.push([at, at + needle.length]);
      }
    }
    const survivors: { file: string; line: number; offset: number; spelling: string }[] = [];
    const claimed = new Set<number>();
    // A Set keeps the first of two spellings that fold alike, so the rank order stands.
    for (const spelling of new Set(spellings.map((each) => each.toLowerCase()))) {
      for (
        let at = lower.indexOf(spelling);
        at !== -1;
        at = lower.indexOf(spelling, at + spelling.length)
      ) {
        const end = at + spelling.length;
        const line = text.slice(0, at).split('\n').length;
        if (claimed.has(line) || spans.some(([from, to]) => from <= at && end <= to)) continue;
        claimed.add(line);
        survivors.push({ file, line, offset: at, spelling: text.slice(at, end) });
      }
    }
    return survivors;
  }

  function searchAll(
    moves: readonly Move[],
    files: Readonly<Record<string, string>>,
    servingDirs: readonly string[],
  ) {
    return findSurvivingPaths({
      moves,
      files: Object.keys(files),
      readFile: async (relative) => files[relative] ?? '',
      servingDirs,
    });
  }

  it('agrees with one search per spelling on 400 generated trees, occurrence for occurrence', async () => {
    // Seeded rather than random so a failure is reproducible from the output alone. The
    // alphabet is tiny on purpose: paths like `a/png.png` and texts built from pieces of
    // them make overlapping matches, spellings nested inside longer ones, destinations
    // that contain an old spelling, needles shorter than the ending the index files them
    // under, and several matches on one line, far more often than real code does.
    //
    // The arithmetic is 32-bit and exact, and a choice comes from the high bits. A plain
    // `seed * 1103515245` passes 2^53, where a double drops the low bits, and choosing by
    // `seed % limit` then chooses from the weakest bits.
    let seed = 20260925;
    const next = (limit: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return Math.floor((seed / 2 ** 32) * limit);
    };
    const pick = <T>(items: readonly T[]): T => items[next(items.length)] as T;
    const segment = () => pick(['a', 'b', 'ab', 'Ab', 'png', 'p']);
    // Pieces of text in another letter case, which the search must find all the same.
    const cased = (piece: string) =>
      pick([
        piece,
        piece,
        piece.toUpperCase(),
        `${piece.charAt(0).toUpperCase()}${piece.slice(1)}`,
      ]);
    const path = () => {
      const directories = Array.from({ length: next(3) }, segment);
      return [...directories, `${segment()}${pick(['.png', '.jpg', '.p', '.png.png', ''])}`].join(
        '/',
      );
    };
    const deeper = (from: string) => {
      const cut = from.lastIndexOf('/');
      return cut === -1
        ? `upfly-moved/${from}`
        : `${from.slice(0, cut)}/upfly-moved/${from.slice(cut + 1)}`;
    };

    let compared = 0;
    let inAnotherCase = 0;
    for (let round = 0; round < 400; round++) {
      const servingDirs = [pick(['', 'a', 'public']), pick(['b', 'ab'])].slice(0, 1 + next(2));
      const moves = Array.from({ length: 1 + next(4) }, () => {
        const from = path();
        const to = pick([`${from.replace(/\.[^./]*$/, '')}.webp`, deeper(from), path()]);
        return { from, to };
      });
      const pieces = moves.flatMap((move) => [
        ...spellingsFor(move.from, servingDirs),
        ...spellingsFor(move.to, servingDirs),
        path(),
      ]);
      const files: Record<string, string> = {};
      for (let file = 0; file < 1 + next(3); file++) {
        files[`f${file}.txt`] = Array.from({ length: 4 + next(20) }, () =>
          next(4) === 0 ? pick(['\n', ' ', '"', '/', '.']) : cased(pick(pieces)),
        ).join(pick(['', ' ', '\n']));
      }

      const expected = oneSearchPerSpelling(moves, files, servingDirs);
      const actual = await searchAll(moves, files, servingDirs);

      expect(actual.spellings, `round ${round}`).toEqual(expected.spellings);
      expect(
        actual.survivors.map(({ file, line, offset, spelling }) => ({
          file,
          line,
          offset,
          spelling,
        })),
        `round ${round}: ${JSON.stringify({ moves, servingDirs, files })}`,
      ).toEqual(expected.survivors);
      compared += expected.survivors.length;
      inAnotherCase += expected.survivors.filter(
        ({ spelling }) => !expected.spellings.includes(spelling),
      ).length;
    }
    // Premise, asserted: the generator produced plenty to compare, not 400 empty trees, and
    // plenty that only a search in any letter case finds.
    expect(compared).toBeGreaterThan(1_000);
    expect(inAnotherCase).toBeGreaterThan(200);
  });

  it('skips a match that overlaps an earlier match of the same spelling, as indexOf did', async () => {
    // `x/png.png.png` holds `png.png` at 2, inside the destination `x/png.png`, and again
    // at 6, overlapping the first. Searching on from the end of the first match never
    // sees the second, so nothing survives. Counting every occurrence would report the
    // one at 6, a match the oracle's `indexOf` loop cannot produce.
    const result = await searchAll(
      [{ from: 'png.png', to: 'x/png.png' }],
      { 'a.txt': 'x/png.png.png' },
      [],
    );

    expect(result.survivors).toEqual([]);
  });

  it('gives a line to the longest spelling on it, even when a shorter one comes first', async () => {
    // The line's survivor is the first match in rank order, longest spelling first, and
    // only then by position. `img/hero.png` at the start of the line loses to
    // `/public/img/hero.png` further along.
    const result = await searchAll(
      [{ from: 'public/img/hero.png', to: 'public/moved/hero.png' }],
      { 'a.txt': 'img/hero.png then /public/img/hero.png' },
      SERVING,
    );

    expect(result.survivors.map(({ offset, spelling }) => [offset, spelling])).toEqual([
      [18, '/public/img/hero.png'],
    ]);
  });

  it('finds a spelling shorter than the ending the index files needles under', async () => {
    const result = await searchAll([{ from: 'x.y', to: 'z/x.y' }], { 'a.txt': 'x.y\n/x.y\n' }, []);

    expect(result.survivors.map(({ line, spelling }) => [line, spelling])).toEqual([
      [1, 'x.y'],
      [2, '/x.y'],
    ]);
  });

  it('numbers lines deep in a long file the way counting line breaks from the top does', async () => {
    const text = `${'filler\n'.repeat(4_320)}see /img/hero.png\n${'more\n'.repeat(700)}`;
    const result = await search({ 'long.txt': text }, 'public/img/hero.png');

    expect(result.survivors.map(({ line, offset }) => [line, offset])).toEqual([
      [4_321, text.indexOf('/img/hero.png')],
    ]);
  });
});
