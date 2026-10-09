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
    expect(respellAs('/IMG/A%20B.png', 'public/img/a b.png', 'public/img/a b.webp', SERVING)).toBe(
      null,
    );
  });

  it('answers a percent-encoded spelling with the destination encoded', () => {
    const from = 'public/img/a b.png';
    expect(respellAs('/img/a%20b.png', from, 'public/img/a b.webp', SERVING)).toBe(
      '/img/a%20b.webp',
    );
    expect(respellAs('/img/a%20b.png', from, 'public/my pics/a b.png', SERVING)).toBe(
      '/my%20pics/a%20b.png',
    );
    expect(respellAs('img/a%20b.png', from, 'public/pics/a b.png', SERVING)).toBe('pics/a%20b.png');
  });

  it('keeps what the text wrote around the part that changes', () => {
    // A writer who encoded one character and not the others, or wrote a hyphen as a
    // character reference, keeps that spelling: only the part of the path that changes is
    // written anew.
    expect(
      respellAs(
        '/img/caf%C3%A9 au lait.png',
        'public/img/café au lait.png',
        'public/img/café au lait.webp',
        SERVING,
      ),
    ).toBe('/img/caf%C3%A9 au lait.webp');
    expect(
      respellAs(
        'img/mtel&#45;logo.png',
        'public/img/mtel-logo.png',
        'public/img/mtel-logo.webp',
        SERVING,
      ),
    ).toBe('img/mtel&#45;logo.webp');
  });

  it('answers each spelling with text that reads as the destination, whatever it encodes', () => {
    // Generated names and spellings: whatever a writer encoded, the answer read the same way
    // is exactly the destination's spelling of that kind.
    let seed = 20261009;
    const next = (limit: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return Math.floor((seed / 2 ** 32) * limit);
    };
    const pick = <T>(items: readonly T[]): T => items[next(items.length)] as T;
    const names = ['a b', 'café', 'Q&A', 'x (1)', 'enc%20name', 'é è', 'a@2x', 'plain'];
    const encode = (text: string) =>
      [...text]
        .map((character) =>
          character !== '/' && next(2) === 0 ? encodeURIComponent(character) : character,
        )
        .join('');
    let answered = 0;
    for (let round = 0; round < 300; round++) {
      const from = `public/${pick(['img', 'my img'])}/${pick(names)}.png`;
      const to = pick([
        from.replace(/\.png$/, '.webp'),
        from.replace('public/', 'public/moved here/'),
        `public/${pick(names)}/${pick(names)}.png`,
      ]);
      const plain = pick(
        spellingsFor(from, SERVING).filter((spelling) => !spelling.includes('\\')),
      );
      const written = encode(plain);
      const answer = respellAs(written, from, to, SERVING);
      if (answer === null) continue;
      answered += 1;
      const expected = spellingsFor(to, SERVING);
      const readAs = written === plain ? answer : decodeURIComponent(answer);
      expect(expected, `${written} for ${from} to ${to} gave ${answer}`).toContain(readAs);
    }
    expect(answered).toBeGreaterThan(200);
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

  it('reports one occurrence per place, not one per spelling that matched', async () => {
    // `/img/hero.png` contains the suffix `img/hero.png`, so a naive loop reports the same
    // place twice and the count says two occurrences where a reader can see one.
    const result = await search({ 'a.yml': 'src: /img/hero.png' }, 'public/img/hero.png');
    expect(result.survivors.map(({ spelling }) => spelling)).toEqual(['/img/hero.png']);
  });

  it('reports every place on a line that names a moved path, not only the longest', async () => {
    // A srcset names three images on one line. Reporting the line once, for whichever path is
    // longest, would leave the other two unnamed and their originals unguarded.
    const result = await findSurvivingPaths({
      moves: ['a.png', 'a@2x.png', 'a@3x.png'].map((name) => ({
        from: `public/img/${name}`,
        to: `public/img/${name.replace('.png', '.webp')}`,
      })),
      files: ['Team.vue'],
      readFile: async () => '<img srcset="/img/a.png 1x, /img/a@2x.png 2x, /img/a@3x.png 3x">\n',
      servingDirs: SERVING,
    });

    expect(result.survivors.map(({ line, spelling }) => [line, spelling])).toEqual([
      [1, '/img/a.png'],
      [1, '/img/a@2x.png'],
      [1, '/img/a@3x.png'],
    ]);
  });

  it('reports a second place on a line apart from one the caller discounts', async () => {
    // A caller that rewrites the first place discounts it by offset, so the second, a path in
    // an attribute Upfly does not read, has to be its own occurrence.
    const result = await search(
      { 'Card.jsx': '<img src="/img/hero.png" data-zoom="/img/hero.png" />\n' },
      'public/img/hero.png',
    );

    expect(result.survivors.map(({ offset }) => offset)).toEqual([10, 36]);
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

describe('a path written the way a browser reads it', () => {
  it('finds a path a URL writes percent-encoded, reporting it as the file spells it', async () => {
    // A browser asks for `/img/a%20b.png` and the server decodes it to `a b.png`, so a page
    // naming the path that way loads the original as surely as one naming it plainly.
    const result = await search(
      { 'src/Team.vue': '<template>\n  <img src="/img/a%20b.png">\n</template>\n' },
      'public/img/a b.png',
    );

    expect(
      result.survivors.map(({ line, spelling, searched }) => [line, spelling, searched]),
    ).toEqual([[2, '/img/a%20b.png', '/img/a b.png']]);
  });

  it('finds a name beyond ASCII written as its UTF-8 escapes, in either case of hex digit', async () => {
    const result = await search(
      { 'team.njk': '<img src="/img/caf%C3%A9.png">\n<img src="/img/CAF%c3%a9.png">\n' },
      'public/img/café.png',
    );

    expect(result.survivors.map(({ line, spelling }) => [line, spelling])).toEqual([
      [1, '/img/caf%C3%A9.png'],
      [2, '/img/CAF%c3%a9.png'],
    ]);
  });

  it('finds a path a writer encoded only in part, or with escapes it did not need', async () => {
    const result = await search(
      {
        'a.liquid': '<img src="/img/caf%C3%A9 au lait.png">\n',
        'b.liquid': '<img src="/img/caf%C3%A9%20au%20lait%2Epng">\n',
      },
      'public/img/café au lait.png',
    );

    expect(result.survivors.map(({ file, spelling }) => [file, spelling])).toEqual([
      ['a.liquid', '/img/caf%C3%A9 au lait.png'],
      ['b.liquid', '/img/caf%C3%A9%20au%20lait%2Epng'],
    ]);
  });

  it('finds a path written with character references, as an HTML parser reads an attribute', async () => {
    // A template Upfly does not read becomes HTML, and the browser decodes `&#32;` and
    // `&amp;` before it asks for the file, then the server decodes the percent-escapes.
    const result = await findSurvivingPaths({
      moves: ['a b.png', 'Q&A.png', 'café x.png'].map((name) => ({
        from: `public/img/${name}`,
        to: `public/img/${name.replace('.png', '.webp')}`,
      })),
      files: ['Team.vue'],
      readFile: async () =>
        '<img src="/img/a&#32;b.png">\n<img src="/img/Q&amp;A.png">\n<img src="/img/caf&eacute;%20x.png">\n',
      servingDirs: SERVING,
    });

    expect(result.survivors.map(({ line, spelling }) => [line, spelling])).toEqual([
      [1, '/img/a&#32;b.png'],
      [2, '/img/Q&amp;A.png'],
      [3, '/img/caf&eacute;%20x.png'],
    ]);
  });

  it('reads each escape once, so a path that decodes to another file never counts for this one', async () => {
    // `%2520` is an escaped percent sign: the server reads `a%20b.png`, a file whose name
    // holds a percent sign, and never `a b.png`.
    const files = { 'Team.vue': '<img src="/img/a%2520b.png">\n' };

    expect((await search(files, 'public/img/a b.png')).survivors).toEqual([]);
    expect(
      (await search(files, 'public/img/a%20b.png')).survivors.map(({ spelling }) => spelling),
    ).toEqual(['/img/a%2520b.png']);
  });

  it('still finds a name holding a percent sign by its name as written', async () => {
    const result = await search(
      { 'a.yml': 'src: /img/enc%20name.png\n' },
      'public/img/enc%20name.png',
    );

    expect(result.survivors.map(({ spelling }) => spelling)).toEqual(['/img/enc%20name.png']);
  });

  it('finds both files where one text names a file as written and another as a URL reads it', async () => {
    // `/img/a%20b.png` is the file `a%20b.png` to a program that opens it by name, and the file
    // `a b.png` to a browser. Each original is guarded by the place.
    const result = await findSurvivingPaths({
      moves: ['a b.png', 'a%20b.png'].map((name) => ({
        from: `public/img/${name}`,
        to: `public/img/${name.replace('.png', '.webp')}`,
      })),
      files: ['a.yml'],
      readFile: async () => 'src: /img/a%20b.png\n',
      servingDirs: SERVING,
    });

    expect(result.survivors.map(({ searched }) => searched).sort()).toEqual([
      '/img/a b.png',
      '/img/a%20b.png',
    ]);
  });

  it('does not report a destination written encoded as a survivor', async () => {
    // After a move, the new URL ends with the old one when the image sat at a serving root,
    // and a rewrite writes it percent-encoded as the old one was.
    const result = await findSurvivingPaths({
      moves: [{ from: 'public/a b.png', to: 'public/moved/a b.png' }],
      files: ['page.html'],
      readFile: async () => '<img src="/moved/a%20b.png">\n<meta content="/a%20b.png">\n',
      servingDirs: SERVING,
    });

    expect(result.survivors.map(({ line }) => line)).toEqual([2]);
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
        compareStrings(a.file, b.file) ||
        a.line - b.line ||
        a.offset - b.offset ||
        compareStrings(a.spelling, b.spelling),
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
    // A place is where a match ends, since every spelling of a path ends with its file name:
    // the longest spelling there names it, and a match elsewhere on the line is another place.
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
        if (claimed.has(end) || spans.some(([from, to]) => from <= at && end <= to)) continue;
        claimed.add(end);
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

  it('gives each place on a line to the longest spelling that ends there', async () => {
    // `/public/img/hero.png` also matches `public/img/hero.png` and `img/hero.png` where it
    // ends, and that place is its own. The `img/hero.png` at the start of the line is another
    // place, written by itself, so it is a survivor too.
    const result = await searchAll(
      [{ from: 'public/img/hero.png', to: 'public/moved/hero.png' }],
      { 'a.txt': 'img/hero.png then /public/img/hero.png' },
      SERVING,
    );

    expect(result.survivors.map(({ offset, spelling }) => [offset, spelling])).toEqual([
      [0, 'img/hero.png'],
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
