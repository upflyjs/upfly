/**
 * Checks the engine's `broken`, `dead` and `possibly-dead` findings against the repository
 * itself, so a person reviews only the ones a machine cannot settle.
 *
 * It does not run the engine's resolver, sweep or adapters. It walks and indexes the tree
 * with its own code, taking from the engine only the image extensions and the functions
 * that write a path in its encoded spellings. A check built on the engine's code agrees
 * with the engine's mistakes; `fixture-integrity.test.ts` follows the same rule. Each item
 * comes back `confirmed-genuine`, `confirmed-false` or `ambiguous`, with the evidence that
 * decided it. See "Verifying findings from outside the engine" in bench/README.md.
 */

import { appendFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import type { ReferenceKind, Report } from 'upfly-core';
import { IMAGE_EXTENSIONS, spell, spellingsOf } from 'upfly-core/internal';

export type Verdict = 'confirmed-genuine' | 'confirmed-false' | 'ambiguous';

export interface ItemVerdict {
  readonly kind: 'broken' | 'dead' | 'possibly-dead';
  /** What was checked, as the report names it. */
  readonly subject: string;
  readonly verdict: Verdict;
  /** What the oracle actually saw. A verdict without this is an opinion. */
  readonly evidence: readonly string[];
  /**
   * Items sharing this are one decision, and the worksheet renders them once: twenty
   * fixtures all missing `/next.svg` are one judgement call, not twenty.
   */
  readonly group?: string;
}

export interface VerifyResult {
  readonly items: readonly ItemVerdict[];
  /** Files the oracle could not read or did not grep, each with the reason. */
  readonly unreadable: readonly string[];
  readonly filesIndexed: number;
  readonly filesGrepped: number;
}

/** One mention of an asset filename found by the oracle's own grep. */
interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** True when the token matched the stem under a different extension. */
  readonly extensionSwapped: boolean;
}

/**
 * Everything the oracle knows about the repository, built once.
 *
 * `files` holds every path as the filesystem spells it, so a lookup is case-exact on every
 * platform. `existsSync` is case-insensitive on Windows, and would call a `broken` finding
 * false when the reference breaks on a case-sensitive filesystem.
 */
interface RepoIndex {
  readonly files: ReadonlySet<string>;
  readonly hitsByToken: ReadonlyMap<string, readonly Hit[]>;
  readonly hitsByStem: ReadonlyMap<string, readonly Hit[]>;
  /**
   * Lowercased text of every grepped file, for the literal searches. Kept in memory because
   * it is the only way to find a name the tokeniser cannot represent, and a bench tool can
   * afford it.
   */
  readonly lowerTexts: ReadonlyMap<string, string>;
  readonly unreadable: readonly string[];
  readonly filesIndexed: number;
  readonly filesGrepped: number;
  /**
   * Whether the tokeniser that built this index can produce a given basename. Carried on
   * the index so the answer comes from that same tokeniser.
   */
  readonly canRepresent: (name: string) => boolean;
}

const MAX_GREP_BYTES = 8 * 1024 * 1024;

export async function verifyFindings(
  root: string,
  report: Report,
  publicDirs: readonly string[],
): Promise<VerifyResult> {
  const index = await buildIndex(root);
  const items: ItemVerdict[] = [];

  for (const finding of report.findings) {
    if (finding.kind === 'broken') {
      items.push(verifyBroken(finding.file, finding.rawPath, index, publicDirs));
    } else if (finding.kind === 'dead') {
      items.push(verifyDead(finding.asset, index));
    } else if (finding.kind === 'possibly-dead') {
      items.push(verifyHedge(finding.asset, finding.evidence, index));
    }
  }

  // Unused vectors are counted in `unusedVectors` rather than listed in `findings`, but each
  // is still a `dead` or `possibly-dead` claim about the repository, so each is checked like
  // one. `assets` is `null` unless the run asked for the list, which is why `validate.ts`
  // passes `includeUnusedVectors`.
  for (const vector of report.unusedVectors.assets ?? []) {
    items.push(
      vector.kind === 'dead'
        ? verifyDead(vector.asset, index)
        : verifyHedge(vector.asset, vector.evidence, index),
    );
  }

  return {
    items,
    unreadable: index.unreadable,
    filesIndexed: index.filesIndexed,
    filesGrepped: index.filesGrepped,
  };
}

const MARKDOWN = new Set(['.md', '.mdx', '.markdown']);

/**
 * Where a path's query or fragment starts: the first `?` or `#` outside a character
 * reference, since the `#` of `a&#38;b.png` is part of the name.
 */
function suffixStart(rawPath: string): number {
  const masked = rawPath.replace(
    /&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (reference) => 'x'.repeat(reference.length),
  );
  const index = masked.search(/[?#]/);
  return index === -1 ? rawPath.length : index;
}

/**
 * The reference kind a file's type implies, which decides the spellings a path can have:
 * only in Markdown is a backslash before punctuation an escape. Read from the file rather
 * than from the finding, so the check stays independent of the engine it checks. Raw HTML
 * inside Markdown then gets the escape reading too, which can only find more files.
 */
function kindOfFile(file: string): ReferenceKind {
  return MARKDOWN.has(posix.extname(file).toLowerCase()) ? 'md' : 'attr';
}

/**
 * Resolves a `broken` finding's path again, against the directory index. A relative path
 * is tried from the referencing file only; a root-relative one against the serving roots of
 * the app that holds the file, the `public/` directories above it, and the project root.
 */
function verifyBroken(
  file: string,
  rawPath: string,
  index: RepoIndex,
  publicDirs: readonly string[],
): ItemVerdict {
  const subject = `${file} → ${rawPath}`;
  const path = rawPath.slice(0, suffixStart(rawPath));

  // Every spelling the path decodes to. `netguru%20(1).jpg` names a file called
  // `netguru (1).jpg`, and a check that compared the text as written would share the
  // engine's blind spot and confirm a false `broken` as genuine.
  const spellings = spellingsOf(path, kindOfFile(file)).map((candidate) => candidate.path);
  const candidates = spellings.flatMap((spelling) => candidatePaths(file, spelling, publicDirs));

  const found = candidates.filter((candidate) => index.files.has(candidate));
  if (found.length > 0) {
    return {
      kind: 'broken',
      subject,
      verdict: 'confirmed-false',
      evidence: [`the path resolves to a file that exists: ${found.join(', ')}`],
    };
  }

  // A file of that name somewhere else in the tree is not a resolution, but it is
  // the shape of "somebody moved it" and a person should see it rather than have
  // the machine rule on it.
  // Asked of every spelling too: a percent-encoded basename matches nothing on disk.
  const names = new Set(spellings.map((spelling) => posix.basename(spelling).toLowerCase()));
  const elsewhere = [...index.files].filter((entry) =>
    names.has(posix.basename(entry).toLowerCase()),
  );

  if (elsewhere.length > 0) {
    return {
      kind: 'broken',
      subject,
      verdict: 'ambiguous',
      group: path,
      evidence: [
        `nothing serves ${path} to this file: none of ${candidates.length} candidate paths exist.`,
        `The name does exist at ${elsewhere.slice(0, 4).join(', ')}${elsewhere.length > 4 ? ` (+${elsewhere.length - 4} more)` : ''},`,
        'but none of those directories serve this file, so they are not resolutions.',
        'The engine is right that nothing serves it here. What a person has to decide is',
        'whether a reference to a file the app never ships is a finding worth reporting.',
      ],
    };
  }

  return {
    kind: 'broken',
    subject,
    verdict: 'confirmed-genuine',
    evidence: [
      `none of ${candidates.length} candidate paths exist: ${candidates.slice(0, 4).join(', ')}`,
      `and no file named ${posix.basename(path)} exists anywhere in the repository`,
    ],
  };
}

/**
 * Every path a server could answer this reference with.
 *
 * A serving root applies only to files of the app it serves: `apps/v4/public` serves the
 * app rooted at `apps/v4`, so it cannot answer `/next.svg` for a file in another app. A
 * `public/` directory above the file is tried the same way, as serving-root detection would
 * find it. Trying every root would call a correct `broken` false. This models how static
 * serving works, which is what the engine is measured against, rather than copying the
 * engine. See "The resolver's seven outcomes" in ARCHITECTURE.md.
 */
function candidatePaths(
  file: string,
  path: string,
  publicDirs: readonly string[],
): readonly string[] {
  const candidates: string[] = [];

  if (path.startsWith('/')) {
    const bare = path.slice(1);

    for (const dir of publicDirs) {
      const appRoot = dir === '' ? '.' : posix.dirname(dir);
      if (appRoot === '.' || file.startsWith(`${appRoot}/`)) {
        candidates.push(dir === '' ? bare : posix.join(dir, bare));
      }
    }

    let directory = posix.dirname(file);
    while (directory !== '.' && directory !== '/') {
      candidates.push(posix.join(directory, 'public', bare));
      directory = posix.dirname(directory);
    }

    // The project root, for a plain static site that serves from the top.
    candidates.push(posix.join('public', bare));
    candidates.push(bare);
  } else {
    candidates.push(posix.normalize(posix.join(posix.dirname(file), path)));
    // No project-root reading of a relative path. The engine allows that fallback only for
    // a speculative reference, and every `broken` finding is asserted: `./images/a.jpg` in
    // an `<img src>` means beside this file. Trying the root would match an unrelated file
    // and report a correct `broken` as false.
  }

  return [...new Set(candidates)].filter((candidate) => !candidate.startsWith('..'));
}

/**
 * Whether the tokeniser can produce this basename, found by running it over a synthetic
 * occurrence of the name. A character test cannot answer this: the leftward walk adds at
 * most six words, so a long name made of allowed characters can still be unrepresentable.
 */
function tokeniserCanRepresent(name: string, pattern: RegExp): boolean {
  const wanted = name.toLowerCase();
  for (const [token] of oracleTokens(`"/probe/${name}"`, pattern)) {
    if (token.toLowerCase() === wanted) return true;
  }
  return false;
}

/**
 * The first line of `text`, a file's lowercased text, that names a file literally in one of
 * `spellings`, or, failing those, that names `name` once its percent-escapes are decoded, as a
 * server decodes them: `Zaječar%20(2).jpg` names `Zaječar (2).jpg`. A run of escapes that is not
 * UTF-8, or that decodes to a line break, is left as written, so every line keeps its number.
 */
function literalIn(
  text: string,
  spellings: readonly string[],
  name: string,
): { readonly line: number; readonly spelling: string } | null {
  const lineAt = (searched: string, at: number) => searched.slice(0, at).split('\n').length;
  for (const spelling of spellings) {
    const at = text.indexOf(spelling.toLowerCase());
    if (at !== -1) return { line: lineAt(text, at), spelling };
  }
  if (!text.includes('%')) return null;
  const decoded = text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      const value = decodeURIComponent(run);
      return /[\r\n]/.test(value) ? run : value;
    } catch {
      return run;
    }
  });
  const at = decoded.indexOf(name.toLowerCase());
  return at === -1 ? null : { line: lineAt(decoded, at), spelling: name };
}

/**
 * Every spelling a source file might name this asset by: as on disk, percent-encoded and
 * entity-encoded. A page that writes `hero%20image.png` references `hero image.png`, and
 * missing it confirms a false `dead`, which tells someone to delete a file their site serves.
 */
function nameSpellings(asset: string): readonly string[] {
  const name = posix.basename(asset);
  return [
    ...new Set([
      name,
      spell(name, 'percent-encoded', 'attr'),
      spell(name, 'html-entities', 'attr'),
    ]),
  ];
}

/**
 * The asset's name under another image extension, found by literal search. Like
 * `literalHits`, it runs only for spellings the token index cannot represent; the caller
 * has already asked `hitsByStem` about the rest.
 *
 * The needle is the stem, a dot and an image extension other than the asset's own, so
 * `only encoded` does not match `only encoded-2.png`. The asset's own extension is the
 * exact match, answered before this runs.
 */
function literalStemHits(
  asset: string,
  stems: ReadonlySet<string>,
  index: RepoIndex,
): readonly string[] {
  const unrepresentable = [...stems].filter(
    (stem) => !index.canRepresent(`${stem}${posix.extname(asset)}`),
  );
  if (unrepresentable.length === 0) return [];

  const own = posix.extname(asset).toLowerCase();
  const others = IMAGE_EXTENSIONS.filter((extension) => extension !== own);
  const found: string[] = [];

  for (const [file, text] of index.lowerTexts) {
    if (file === asset) continue;
    for (const stem of unrepresentable) {
      for (const extension of others) {
        const needle = `${stem}${extension}`.toLowerCase();
        const at = text.indexOf(needle);
        if (at === -1) continue;
        const line = text.slice(0, at).split('\n').length;
        found.push(`  ${file}:${line}  (as ${stem}${extension})`);
        break;
      }
      if (found.length >= 5) break;
    }
    if (found.length >= 5) break;
  }

  return found;
}

/**
 * Searches literally for the spellings of an asset's name that the token index cannot
 * hold. `photo (1).webp` has parentheses, which are outside the tokeniser's character
 * class. Widening the class is not the fix, because parentheses delimit unquoted CSS
 * `url(…)` and Markdown `![](…)`. A substring search has no tokenisation gaps, and it runs
 * only for such names, so its cost follows their number rather than the repository's size.
 *
 * Returns `null` when the token index still has to be asked.
 */
function literalHits(asset: string, index: RepoIndex): ItemVerdict | null {
  // The search runs when any spelling is unrepresentable, not only the name on disk:
  // `hero image.png` is representable, but the index cannot see `hero%20image.png`, since
  // `%` is outside its character class.
  const spellings = nameSpellings(asset);
  const unrepresentable = spellings.filter((spelling) => !index.canRepresent(spelling));
  if (unrepresentable.length === 0) return null;

  const found: string[] = [];
  for (const [file, text] of index.lowerTexts) {
    if (file === asset) continue;
    const hit = literalIn(text, unrepresentable, posix.basename(asset));
    if (hit !== null) found.push(`  ${file}:${hit.line}  (as ${hit.spelling})`);
    if (found.length >= 5) break;
  }

  if (found.length === 0) {
    // When the name itself is representable, only the other spellings were searched for,
    // so the token index still has to be asked.
    if (index.canRepresent(posix.basename(asset))) return null;
    return {
      kind: 'dead',
      subject: asset,
      verdict: 'confirmed-genuine',
      evidence: [
        'the filename contains a character the token index cannot represent, so it was',
        'searched for literally across every grepped file, and appears in none of them.',
      ],
    };
  }

  return {
    kind: 'dead',
    subject: asset,
    verdict: 'confirmed-false',
    evidence: [
      `the exact filename appears in ${found.length} place(s), found by literal search`,
      'because the token index cannot represent it:',
      ...found,
    ],
  };
}

/**
 * Searches the repository for a `dead` asset's name. `dead` says the name appears nowhere,
 * the strongest claim the engine makes, so the search also covers directories
 * `.upflyignore` excludes and the name under other image extensions.
 */
function verifyDead(asset: string, index: RepoIndex): ItemVerdict {
  const literal = literalHits(asset, index);
  if (literal !== null) return literal;

  // Every spelling the index can hold. `literalHits` has searched for the others.
  const exact = nameSpellings(asset)
    .flatMap((spelling) => index.hitsByToken.get(spelling.toLowerCase()) ?? [])
    .filter((hit) => hit.file !== asset);
  if (exact.length > 0) {
    return {
      kind: 'dead',
      subject: asset,
      verdict: 'confirmed-false',
      evidence: [
        `the filename appears in ${exact.length} place(s) the engine did not hedge on:`,
        ...exact.slice(0, 5).map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`),
      ],
    };
  }

  // The stem is asked for in every spelling too: a name mentioned only as
  // `hero%20image.jpg` is still mentioned, and a miss here falls through to
  // `confirmed-genuine`.
  const stems = new Set(
    nameSpellings(asset).map((spelling) => {
      const lower = spelling.toLowerCase();
      const cut = lower.lastIndexOf('.');
      return cut === -1 ? lower : lower.slice(0, cut);
    }),
  );
  const swapped = [...stems]
    .flatMap((candidate) => index.hitsByStem.get(candidate) ?? [])
    .filter((hit) => hit.extensionSwapped && hit.file !== asset);

  // The index cannot hold `%`, so `only%20encoded.jpg` is indexed under the stem
  // `20encoded`, where no spelling of `only encoded` can find it. As in `literalHits`,
  // spellings the index cannot represent are searched for literally.
  if (swapped.length === 0) {
    const literal = literalStemHits(asset, stems, index);
    if (literal.length > 0) {
      return {
        kind: 'dead',
        subject: asset,
        verdict: 'ambiguous',
        evidence: [
          'the exact filename appears nowhere, but the same name under another image',
          'extension does, found by literal search, because the token index cannot',
          'represent the spelling the source used:',
          ...literal.slice(0, 5),
        ],
      };
    }
  }
  if (swapped.length > 0) {
    return {
      kind: 'dead',
      subject: asset,
      verdict: 'ambiguous',
      evidence: [
        'the exact filename appears nowhere, but the same name under another image',
        'extension does, which is either an unrelated asset or a reference someone',
        'already converted by hand:',
        ...swapped.slice(0, 5).map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`),
      ],
    };
  }

  return {
    kind: 'dead',
    subject: asset,
    verdict: 'confirmed-genuine',
    evidence: [
      `grepped ${index.filesGrepped} files, including directories the project's ignore file excludes:`,
      `no mention of ${posix.basename(asset)} anywhere, under any image extension`,
    ],
  };
}

/**
 * Checks each citation of a `possibly-dead` finding. The hedge does not say whether the
 * asset is alive, so what is checked is that the cited file and line hold the name. A
 * citation of the wrong place is worse than none, because a user follows it.
 */
function verifyHedge(
  asset: string,
  evidence: readonly { where: string; quote: string; source: string }[],
  index: RepoIndex,
): ItemVerdict {
  const checked: string[] = [];
  const wrong: string[] = [];

  for (const mention of evidence) {
    const match = /^(.*?):(\d+)$/.exec(mention.where);
    const file = match?.[1] ?? mention.where;
    const line = match?.[2] === undefined ? null : Number(match[2]);

    if (!index.files.has(file)) {
      wrong.push(`${mention.where}: that file is not in the repository`);
      continue;
    }

    // Every spelling here too: a citation of a line that writes `hero%20image.png` is
    // correct, and missing it would report a correct engine as wrong.
    const spellings = nameSpellings(asset);
    const hits = spellings.flatMap(
      (spelling) => index.hitsByToken.get(spelling.toLowerCase()) ?? [],
    );
    let inFile = hits.filter((hit) => hit.file === file);

    // A spelling the token index cannot hold is looked for literally, in that file only.
    if (inFile.length === 0) {
      const text = index.lowerTexts.get(file);
      const unrepresentable = spellings.filter((spelling) => !index.canRepresent(spelling));
      const hit =
        text === undefined ? null : literalIn(text, unrepresentable, posix.basename(asset));
      if (hit !== null) {
        inFile = [{ file, line: hit.line, text: hit.spelling, extensionSwapped: false }];
      }
    }

    if (inFile.length === 0) {
      wrong.push(`${mention.where}: the file does not contain ${posix.basename(asset)}`);
    } else if (line !== null && !inFile.some((hit) => hit.line === line)) {
      wrong.push(
        `${mention.where}: the name is in that file but on line(s) ${inFile
          .map((hit) => hit.line)
          .slice(0, 4)
          .join(', ')}, not ${line}`,
      );
    } else {
      checked.push(`${mention.where} (${mention.source}): the name is there`);
    }
  }

  if (wrong.length > 0) {
    return {
      kind: 'possibly-dead',
      subject: asset,
      verdict: 'confirmed-false',
      evidence: ['a citation does not hold up:', ...wrong.map((entry) => `  ${entry}`)],
    };
  }

  return {
    kind: 'possibly-dead',
    subject: asset,
    verdict: 'confirmed-genuine',
    evidence: checked.map((entry) => `  ${entry}`),
  };
}

/**
 * Indexes one file's image-filename tokens into the two maps. A function of its own so
 * that `assertOracleSeesSpaces` runs the same indexing path as the walk.
 */
function indexOneFile(
  text: string,
  rel: string,
  pattern: RegExp,
  hitsByToken: Map<string, Hit[]>,
  hitsByStem: Map<string, Hit[]>,
): void {
  const lineStarts = offsetsOfLines(text);

  for (const [raw, index] of oracleTokens(text, pattern)) {
    const token = raw.toLowerCase();
    const stem = token.slice(0, token.lastIndexOf('.'));
    const hit: Hit = {
      file: rel,
      line: lineOf(lineStarts, index),
      text: lineText(text, index),
      extensionSwapped: false,
    };
    pushHit(hitsByToken, token, hit);
    pushHit(hitsByStem, stem, { ...hit, extensionSwapped: true });
  }
}

/**
 * The oracle's own filename tokeniser. The pattern cannot cross a space, so from each match
 * it walks left over up to six space-separated words and yields every step: `Practice.webp`,
 * then `Firing Practice.webp`.
 *
 * A copy of the engine's `imageFilenameCandidates` rather than an import, so the oracle
 * agrees with the engine by coincidence, not by construction. `assertOracleSeesSpaces`
 * keeps the copy from losing the walk.
 */
function* oracleTokens(text: string, pattern: RegExp): Generator<[token: string, index: number]> {
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const end = match.index + match[0].length;
    yield [match[0], match.index];

    let start = match.index;
    for (let word = 0; word < 6; word += 1) {
      if (text[start - 1] !== ' ') break;
      let candidate = start - 1;
      while (candidate > 0 && /[\w@.\-]/.test(text[candidate - 1] ?? '')) candidate -= 1;
      if (candidate === start - 1) break;
      start = candidate;
      yield [text.slice(start, end), start];
    }
    match = pattern.exec(text);
  }
}

/**
 * Proves the index can see a filename containing a space before any verdict relies on it:
 * an oracle blind to that class reports a clean result either way. It throws rather than
 * warns, because a warning in a bench script is a line nobody reads.
 */
function assertOracleSeesSpaces(pattern: () => RegExp): void {
  // Asserts on what `indexOneFile` puts in the map rather than on `oracleTokens`, so an
  // indexing path that bypasses the space-aware tokeniser fails here.
  const hitsByToken = new Map<string, Hit[]>();
  const hitsByStem = new Map<string, Hit[]>();
  indexOneFile('src="/ncc/Firing Practice.webp"', 'probe.html', pattern(), hitsByToken, hitsByStem);

  if (!hitsByToken.has('firing practice.webp')) {
    throw new Error(
      'The oracle cannot see a filename containing a space, so any false-dead rate it reports is meaningless.',
    );
  }
}

/** The oracle's own walk and grep. Nothing here imports the engine's machinery. */
async function buildIndex(root: string): Promise<RepoIndex> {
  const files = new Set<string>();
  const hitsByToken = new Map<string, Hit[]>();
  const hitsByStem = new Map<string, Hit[]>();
  const lowerTexts = new Map<string, string>();
  const unreadable: string[] = [];
  let filesGrepped = 0;

  const extensions = IMAGE_EXTENSIONS.map((extension) => extension.slice(1)).join('|');
  // Letters, digits and marks of any script, as a name is written: an ASCII class would read
  // `Рисунок2.png` as a mention of `2.png`.
  const makePattern = () => new RegExp(`[\\p{L}\\p{N}\\p{M}_@.\\-]+\\.(?:${extensions})\\b`, 'giu');
  const pattern = makePattern();

  assertOracleSeesSpaces(makePattern);

  const unlistable = (directory: string, error: unknown): void => {
    const rel = relative(root, directory).replaceAll('\\', '/');
    unreadable.push(`${rel}/: ${error instanceof Error ? error.message : String(error)}`);
  };

  let walked = 0;
  const startedAt = Date.now();
  for await (const absolute of walk(root, unlistable)) {
    const rel = relative(root, absolute).replaceAll('\\', '/');
    files.add(rel);
    walked += 1;
    // Progress, synchronously to stderr: a slow index is otherwise indistinguishable from
    // a hang, and this is pointed at repositories nobody has profiled.
    if (walked % 2000 === 0) {
      appendFileSync(
        2,
        `      oracle: ${walked} walked, ${filesGrepped} grepped, ${((Date.now() - startedAt) / 1000).toFixed(0)}s\n`,
      );
    }

    const extension = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    // An SVG is text as well as an image, so it is read: editors write names into it, such
    // as Inkscape's `sodipodi:docname="GitLab.svg"`, and the engine's sweep cites those lines.
    if (IMAGE_EXTENSIONS.includes(extension) && extension !== '.svg') continue;

    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch (error) {
      unreadable.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (text.length > MAX_GREP_BYTES) {
      unreadable.push(`${rel}: larger than ${MAX_GREP_BYTES} bytes, not grepped`);
      continue;
    }
    // `String.fromCharCode(0)` rather than a literal NUL, which is invisible in the source
    // and easily corrupted.
    if (text.includes(String.fromCharCode(0))) {
      unreadable.push(`${rel}: contains a NUL byte, treated as binary and not grepped`);
      continue;
    }
    filesGrepped += 1;
    lowerTexts.set(rel, text.toLowerCase());

    indexOneFile(text, rel, pattern, hitsByToken, hitsByStem);
  }

  return {
    canRepresent: (name: string) => tokeniserCanRepresent(name, makePattern()),
    files,
    hitsByToken,
    hitsByStem,
    lowerTexts,
    unreadable,
    filesIndexed: files.size,
    filesGrepped,
  };
}

/**
 * Appends without copying. Spreading into a new array per hit is quadratic in the number
 * of times one filename appears.
 */
function pushHit(into: Map<string, Hit[]>, key: string, hit: Hit): void {
  const existing = into.get(key);
  if (existing === undefined) into.set(key, [hit]);
  else existing.push(hit);
}

/**
 * Directories the oracle does not index: every directory the engine prunes by default
 * (version control, dependencies, generated output and Upfly's own records), which a test
 * holds it to. A stale bundle can name an asset the source no longer uses, a dependency can
 * hold a user's filename by coincidence, and Upfly's manifests name every file it touched;
 * any of them would call a correct `dead` false. Minified bundles are also where the
 * filename pattern is slowest. The list is the oracle's own, not imported from the engine.
 */
export const ORACLE_SKIPS: ReadonlySet<string> = new Set([
  '.astro',
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.upfly',
  'dist',
  'build',
  'out',
  'coverage',
  '_site',
  '.docusaurus',
  'storybook-static',
  '.vercel',
  '.netlify',
  '.angular',
  'venv',
  '.venv',
  'site-packages',
  '__pycache__',
  '__MACOSX',
]);

/**
 * Every file under `directory`, outside the skipped folders. A directory it cannot list
 * goes to `unlistable` rather than being dropped, because a dead verdict may rest on it.
 */
async function* walk(
  directory: string,
  unlistable: (directory: string, error: unknown) => void,
): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    unlistable(directory, error);
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ORACLE_SKIPS.has(entry.name)) yield* walk(path, unlistable);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function offsetsOfLines(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/** Binary search rather than a scan per match: some of these files are large. */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function lineText(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset) + 1;
  const end = text.indexOf('\n', offset);
  return text
    .slice(start, end === -1 ? undefined : end)
    .trim()
    .slice(0, 140);
}
