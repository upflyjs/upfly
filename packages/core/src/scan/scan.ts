/**
 * Read every source file and hand it to the adapter that claimed it.
 *
 * This is the one place that handles adapter failure. A file that cannot be read or
 * parsed becomes an `unscanned` entry instead of an exception, so one unparseable `.scss`
 * cannot stop an audit, and the audit's sweep treats it like a file no adapter claimed.
 * `readFile` is injected, so that handling is tested against an in-memory file map. See
 * "Scanning: one place that owns adapter failure" in ARCHITECTURE.md.
 */

import { UpflyError } from '../errors.js';
import { mapInOrder } from '../map-in-order.js';
import { imageFilenameCandidates } from '../paths.js';
import type { Adapter, RawReference, SourceFile, UnscannedFile } from '../types.js';
import { lineOf } from './citation.js';
import { couldHoldReference } from './could-hold-reference.js';
import { hashText } from './text-hash.js';

/**
 * Reads a file's text. Injected so this module stays pure.
 *
 * The real implementation is `(path) => readFile(path, 'utf8')`, and the store writes
 * UTF-8 back. Offsets are UTF-16 code units into the string this returns. A byte-order
 * mark survives the round trip; bytes that are not UTF-8 do not, which is why a text
 * holding U+FFFD is never rewritten (see `ScannedText`).
 */
export type ReadFilePort = (absolutePath: string) => Promise<string>;

/**
 * An asset filename found in a file's text, in a form no adapter turned into a
 * reference.
 *
 * Collected here, while the text is in memory, so the audit's `possibly-dead` sweep never
 * reads a source file a second time.
 */
export interface ScannedMention {
  /** Lowercased asset basename, e.g. `hero.png`. */
  readonly basename: string;
  /** POSIX-relative path of the file it appeared in. */
  readonly relative: string;
  /** One-based line. */
  readonly line: number;
  /** The token exactly as written, so the report can quote it. */
  readonly quote: string;
}

/**
 * The text of a source file as the scan read it, identified by its hash.
 *
 * Every offset in a reference found in the file counts into this text and no other, so a
 * write checks the file against `hash` before applying an edit at those offsets.
 */
export interface ScannedText {
  /** Absolute path of the file, as in `RawReference.file`. */
  readonly path: string;
  /** SHA-256 of the text, encoded as UTF-8. */
  readonly hash: string;
  /**
   * Whether the text holds U+FFFD, which UTF-8 decoding puts in place of bytes that are not
   * UTF-8. Writing such a text back would not reproduce those bytes, so no edit is planned
   * in it. A valid file holding U+FFFD itself cannot be told apart from the text alone, and
   * loses only its rewrites.
   */
  readonly holdsReplacementCharacter: boolean;
}

/**
 * A parser's own error message, for `ScanOptions.onDiagnostic` and never for the report.
 *
 * The counterpart of `ProbeDiagnostic`: the report carries our description of the
 * failure, and the library's wording, which changes between versions, goes here. `bench`
 * writes these beside its report as `<repo>.diagnostics.txt`.
 */
export interface ScanDiagnostic {
  /** POSIX-relative path of the file that would not parse. */
  readonly relative: string;
  /** Which adapter was reading it. */
  readonly adapterId: string;
  /** Verbatim from PostCSS or Babel. Unstable across versions, never a report's business. */
  readonly detail: string;
}

export interface ScanOptions {
  /** Files to read, as returned by `discover`. Output order follows this order. */
  readonly sourceFiles: readonly SourceFile[];
  /** The same adapters `discover` was given. Each `adapterId` must be among them. */
  readonly adapters: readonly Adapter[];
  readonly readFile: ReadFilePort;
  /**
   * Lowercased basenames of every asset `discover` found. Omit it and no mentions are
   * collected.
   *
   * All assets rather than the unreferenced ones, which are not known until the graph
   * exists; the sweep narrows them later.
   */
  readonly assetBasenames?: ReadonlySet<string>;
  /** Files read at once, the next starting as soon as any finishes. Defaults to 16. */
  readonly concurrency?: number;
  /**
   * Where a parser's own error text goes, if anywhere. The report does not need it; it
   * helps only to debug an adapter.
   */
  readonly onDiagnostic?: (diagnostic: ScanDiagnostic) => void;
}

export interface ScanResult {
  /** Every reference found, in source-file order and then in source order. */
  readonly references: readonly RawReference[];
  /**
   * Files an adapter claimed but that were never scanned.
   *
   * The same list shape `discover` produces for unclaimed extensions, because the
   * audit treats them identically: in both cases we did not learn what the file
   * references, so an asset named only there must not be reported as dead.
   */
  readonly unscanned: readonly UnscannedFile[];
  /**
   * Asset filenames seen in the text but not turned into references. Empty unless
   * `assetBasenames` was given.
   */
  readonly mentions: readonly ScannedMention[];
  /** The text of every file that yielded a reference, in source-file order. */
  readonly texts: readonly ScannedText[];
}

/** What UTF-8 decoding puts in place of each byte sequence that is not UTF-8. */
const REPLACEMENT_CHARACTER = '\uFFFD';

/** How many files are read at once. IO-bound, so higher than the core count. */
const DEFAULT_CONCURRENCY = 16;

/**
 * Adapters that throw only on text holding one of `couldHoldReference`'s tokens, so a
 * file without any can skip the parse. `css`, `javascript` and `astro` are absent: their
 * parsers reject invalid input whether or not it holds a reference, and that failure
 * must still be reported.
 *
 * One exception is accepted: a token-free `.mdx` file whose `import`/`export` blocks do
 * not parse is skipped rather than reported. It holds nothing to find, and MDX itself
 * refuses to compile it. See "Skipping files that cannot hold a reference" in
 * ARCHITECTURE.md.
 */
const SKIPPABLE_ADAPTER_ID_SET = new Set(['html', 'json', 'markdown']);

/**
 * Read and parse every source file.
 *
 * @throws {UpflyError} `ADAPTER_NOT_REGISTERED` if a file names an adapter that was not
 * supplied, which means `discover` was given a different adapter set. Skipping the file
 * instead would leave it unread and could make an asset look dead.
 */
export async function scanSources(options: ScanOptions): Promise<ScanResult> {
  const byId = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));

  const references: RawReference[] = [];
  const unscanned: UnscannedFile[] = [];
  const mentions: ScannedMention[] = [];
  const texts: ScannedText[] = [];

  // The results keep the source-file order, so the output does not depend on which read
  // finished first, and the report is the same for the same input without a later sort.
  const scanned = await mapInOrder(
    options.sourceFiles,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    (file) => scanOne(file, adapterFor(file, byId), options.readFile, options.assetBasenames),
  );

  for (const result of scanned) {
    // Both, not either: a file that failed can still carry the references found
    // before the failure.
    references.push(...result.references);
    if (result.failure !== null) unscanned.push(result.failure);
    mentions.push(...result.mentions);
    if (result.text !== null) texts.push(result.text);
    // Emitted here rather than inside the concurrent map, so diagnostics arrive in
    // source-file order. Nothing deterministic reads them, but debugging output that
    // reorders between runs is harder to use.
    if (result.diagnostic !== null) options.onDiagnostic?.(result.diagnostic);
  }

  return { references, unscanned, mentions, texts };
}

function adapterFor(file: SourceFile, byId: ReadonlyMap<string, Adapter>): Adapter {
  const adapter = byId.get(file.adapterId);
  if (adapter === undefined) {
    throw new UpflyError(
      'ADAPTER_NOT_REGISTERED',
      `${file.relative} was claimed by adapter '${file.adapterId}', which was not supplied to scanSources.`,
    );
  }
  return adapter;
}

interface ScannedFile {
  readonly references: readonly RawReference[];
  /** `null` when the file was read and parsed. */
  readonly failure: UnscannedFile | null;
  readonly mentions: readonly ScannedMention[];
  /** `null` unless a third-party parser said something. */
  readonly diagnostic: ScanDiagnostic | null;
  /** `null` when the file yielded no reference, so no edit can ever be made to it. */
  readonly text: ScannedText | null;
}

/**
 * Why a path holding U+FFFD, in a text that did not read cleanly as UTF-8, names no file
 * Upfly can know.
 */
const NAME_NOT_READABLE =
  'the page is not valid UTF-8, so the file name this path holds cannot be read: U+FFFD stands where its bytes were';

/**
 * A reference whose path holds U+FFFD, which decoding put where the page's bytes were not
 * UTF-8, refused rather than looked up. The name as the page spells it cannot be read back,
 * so a lookup reports a file that exists (`café.png`, written in Latin-1) as broken. The
 * resolver gives an `unsafe` reference no target, and the note says why.
 */
function refuseUnreadableNames<Scanned extends { readonly references: readonly RawReference[] }>(
  scanned: Scanned,
  text: string,
): Scanned {
  if (!text.includes(REPLACEMENT_CHARACTER)) return scanned;
  return {
    ...scanned,
    references: scanned.references.map((reference) =>
      reference.rawPath.includes(REPLACEMENT_CHARACTER)
        ? { ...reference, ceiling: 'unsafe', note: NAME_NOT_READABLE }
        : reference,
    ),
  };
}

async function scanOne(
  file: SourceFile,
  adapter: Adapter,
  readFile: ReadFilePort,
  assetBasenames: ReadonlySet<string> | undefined,
): Promise<ScannedFile> {
  let text: string;
  try {
    text = await readFile(file.path);
  } catch (error) {
    // A file that vanished or became unreadable after the walk: reported, not thrown.
    return {
      references: [],
      failure: unscannedFile(file, 'unreadable', describe(error)),
      mentions: [],
      diagnostic: null,
      text: null,
    };
  }

  const scanned = refuseUnreadableNames(parseOne(file, adapter, text, assetBasenames), text);
  if (scanned.references.length === 0) return { ...scanned, text: null };
  return {
    ...scanned,
    text: {
      path: file.path,
      hash: hashText(text),
      holdsReplacementCharacter: text.includes(REPLACEMENT_CHARACTER),
    },
  };
}

/**
 * Everything done with one file's text: the mention pass, the adapter, and the error
 * handling around both. Two things here fail silently when wrong: keeping the references
 * an adapter found before it failed (`UpflyError.partial`), and sending the parser's own
 * wording to the diagnostic channel rather than to the report.
 */
function parseOne(
  file: SourceFile,
  adapter: Adapter,
  text: string,
  assetBasenames: ReadonlySet<string> | undefined,
): Omit<ScannedFile, 'text'> {
  // One pass over text already in memory. Done before the adapter runs so that a
  // file which fails to parse still contributes its mentions: that file is exactly
  // the one whose references we do not know.
  const mentions = collectMentions(file, text, assetBasenames);

  // Skip the parse when no reference could come out of this text. Not a decline that
  // needs reporting: the adapter would have returned nothing either. Only for the
  // adapters in `SKIPPABLE_ADAPTER_ID_SET`, whose comment says why.
  if (SKIPPABLE_ADAPTER_ID_SET.has(adapter.id) && !couldHoldReference(text)) {
    return { references: [], failure: null, mentions, diagnostic: null };
  }

  try {
    return {
      references: adapter.findReferences({ file: file.path, text }),
      failure: null,
      mentions,
      diagnostic: null,
    };
  } catch (error) {
    // Every throw, not only `ADAPTER_PARSE_FAILED`: a bug in a community adapter must
    // not stop the audit, and its message still reaches the report. A composite format
    // can find references before meeting a part it cannot parse (unparseable CSS in a
    // Markdown `<style>` block). Those references are correct, so they are kept, and the
    // file is still reported as `parse-failed`.
    return {
      references: partialOf(error),
      failure: unscannedFile(file, 'parse-failed', describe(error)),
      mentions,
      diagnostic: diagnosticOf(error, file, adapter),
    };
  }
}

/** Every asset filename this text names, from the set in `assetBasenames`. */
function collectMentions(
  file: SourceFile,
  text: string,
  assetBasenames: ReadonlySet<string> | undefined,
): ScannedMention[] {
  if (assetBasenames === undefined || assetBasenames.size === 0) return [];

  const found: ScannedMention[] = [];
  const seen = new Set<string>();

  // `imageFilenameCandidates` rather than a local pattern, so a filename, spaces
  // included, is found here exactly as the sweep finds it in unread files. If the two
  // lookups differ, an asset named only in a scanned file can be reported as dead.
  for (const [token, offset] of imageFilenameCandidates(text)) {
    const basename = token.toLowerCase();
    // One mention per basename per file: a hundred repeats of the same name are one
    // piece of evidence, and the report cites a place rather than a count.
    if (assetBasenames.has(basename) && !seen.has(basename)) {
      seen.add(basename);
      found.push({
        basename,
        relative: file.relative,
        line: lineOf(text, offset),
        quote: token,
      });
    }
  }

  return found;
}

/**
 * The parser's own words, if it gave any, for the diagnostic channel.
 *
 * Read off the error, never off `UnscannedFile`, whose one `detail` field holds the
 * error's message. With no field for the parser's wording, it has no path into the report.
 */
function diagnosticOf(error: unknown, file: SourceFile, adapter: Adapter): ScanDiagnostic | null {
  if (!(error instanceof UpflyError) || error.diagnostic === '') return null;
  return { relative: file.relative, adapterId: adapter.id, detail: error.diagnostic };
}

/**
 * References an adapter had already found when it failed.
 *
 * The one place `UpflyError.partial` is narrowed: it is typed `unknown[]` so that
 * `errors.ts` need not depend on `types.ts`.
 */
function partialOf(error: unknown): RawReference[] {
  return error instanceof UpflyError ? [...(error.partial as RawReference[])] : [];
}

function unscannedFile(
  file: SourceFile,
  reason: 'parse-failed' | 'unreadable',
  detail: string,
): UnscannedFile {
  return {
    path: file.path,
    relative: file.relative,
    extension: file.extension,
    reason,
    detail: withoutAbsolutePath(detail, file),
  };
}

/**
 * The failure message, with this file's absolute path written the way the rest of
 * the report writes paths.
 *
 * Adapters are handed an absolute path and some put it in the message they throw, which
 * reaches the report, so the same repository checked out in two places would produce
 * different reports. Done here rather than in each adapter, because this layer knows both
 * spellings and a community adapter's message cannot be relied on to be clean. The
 * report's own absolute-path test cannot catch a regression, since no fixture tree holds
 * a file that fails to parse; `scan.test.ts` covers it.
 */
function withoutAbsolutePath(message: string, file: SourceFile): string {
  if (message === '') return message;

  // `split`/`join` rather than a regex: the path is full of backslashes on Windows
  // and escaping them into a pattern is a bug waiting to happen.
  const scrubbed = message.split(file.path).join(file.relative);
  const posix = file.path.replaceAll('\\', '/');
  return posix === file.path ? scrubbed : scrubbed.split(posix).join(file.relative);
}

/** A one-line description of a failure, without asserting its shape. */
function describe(error: unknown): string {
  if (error instanceof UpflyError) return `${error.code}: ${error.message}`;
  if (error instanceof Error && 'code' in error) {
    const { code } = error as Error & { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.message : String(error);
}
