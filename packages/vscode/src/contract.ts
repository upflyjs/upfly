/**
 * The lines `upfly <command> --json` prints, as far as the extension reads them. The CLI
 * ships a JSON Schema for each in `upfly/schema/`, and the tests check the CLI's real output
 * against those schemas, so these types only name the fields the extension uses.
 */

/** A command the extension runs. */
export type CommandName = 'audit' | 'refs';

/** One stage of a run finished, with what it counted. */
export type ProgressLine = {
  readonly type: 'progress';
  readonly command: string;
} & (
  | { readonly stage: 'discovered'; readonly images: number; readonly files: number }
  | { readonly stage: 'scanned'; readonly references: number }
  | { readonly stage: 'resolved'; readonly linked: number }
  | { readonly stage: 'measuring'; readonly done: number; readonly total: number }
  | { readonly stage: 'measured'; readonly images: number }
  | { readonly stage: 'audited'; readonly findings: number }
  | { readonly stage: 'planned'; readonly conversions: number; readonly rewrites: number }
  | { readonly stage: 'written'; readonly files: number }
);

/** What an image or parsing library said about one file, in its own words. */
export interface DiagnosticLine {
  readonly type: 'diagnostic';
  readonly command: string;
  readonly source: 'image' | 'parser';
  readonly asset?: string;
  readonly relative?: string;
  readonly detail: string;
}

/** Why a command stopped, in place of its result. */
export interface ErrorLine {
  readonly type: 'error';
  readonly command: string | null;
  /** 2: the command line or the config is wrong; 3: refused for safety; 4: unanticipated. */
  readonly exitCode: 2 | 3 | 4;
  /** A stable name to branch on, such as `V2_EXTENSION_CONFIG`; absent for some stops. */
  readonly reason?: string;
  /** What happened and what to do about it, in sentences. */
  readonly message: string;
}

/** A path and line in the project, counted from 1, or null when the line is not known. */
export interface Located {
  readonly file: string;
  readonly line: number | null;
}

/** A finding in the report. */
export type Finding =
  | {
      readonly kind: 'dead';
      readonly asset: string;
      readonly bytes: number;
      readonly inPublicDir: boolean;
    }
  | {
      readonly kind: 'possibly-dead';
      readonly asset: string;
      readonly bytes: number;
      readonly inPublicDir: boolean;
      readonly evidence: readonly Mention[];
    }
  | {
      readonly kind: 'broken';
      readonly file: string;
      readonly line: number | null;
      readonly where: string;
      readonly rawPath: string;
      readonly note?: string;
    }
  | {
      readonly kind: 'serving-root-unknown';
      readonly linked: number;
      readonly checkable: number;
      readonly suppressedBroken: number;
    }
  | {
      readonly kind: 'oversized';
      readonly asset: string;
      readonly bytes: number;
      readonly width: number | null;
      readonly height: number | null;
      readonly exceeded: readonly ('bytes' | 'width' | 'height')[];
    }
  | {
      readonly kind: 'format-opportunity';
      readonly asset: string;
      readonly to: 'webp' | 'avif';
      readonly bytes: number;
      readonly wouldBe: number;
      readonly savedBytes: number;
      readonly savedPercent: number;
    }
  | {
      readonly kind: 'duplicate';
      readonly assets: readonly string[];
      readonly bytes: number;
      readonly wastedBytes: number;
    };

/** Where an image's name appears outside a reference Upfly follows. */
export interface Mention {
  readonly asset: string;
  readonly where: string;
  readonly quote: string;
}

/** A reference Upfly never rewrites, with why. */
export interface UnsafeReference {
  readonly file: string;
  readonly rawPath: string;
  readonly resolution: string;
  readonly reason: string;
}

/** The report inside audit's result, as far as the extension reads it. */
export interface Report {
  readonly summary: {
    readonly assets: number;
    readonly assetBytes: number;
    readonly sourceFiles: number;
    readonly references: number;
    readonly linkedReferences: number;
    readonly referencedAssets: number;
    readonly potentialSavingBytes: number;
    readonly probed: boolean;
    readonly unmeasuredAssets: number;
  };
  readonly findings: readonly Finding[];
  readonly unusedVectors: { readonly count: number; readonly bytes: number };
  readonly keptOriginals: {
    readonly count: number;
    readonly bytes: number;
    readonly assets: readonly { readonly asset: string; readonly convertedTo: string }[];
  };
  readonly references: {
    readonly unsafe: readonly UnsafeReference[];
    readonly leftOut: readonly UnsafeReference[];
  };
  readonly coverage: {
    readonly unscannedExtensions: readonly { readonly ext: string; readonly fileCount: number }[];
    readonly excludedRoots: readonly { readonly path: string; readonly reason: string }[];
    readonly servingRoots: { readonly dirs: readonly string[]; readonly declared: boolean };
  };
  readonly skipped: readonly {
    readonly what: string;
    readonly stage: string;
    readonly reason: string;
  }[];
  readonly caveats: readonly { readonly code: string; readonly message: string }[];
}

/** One image `optimize` would convert. */
export interface Conversion {
  readonly asset: string;
  readonly target: string;
  readonly format: 'webp' | 'avif';
  readonly savedBytes: number;
  readonly replacesOriginal: boolean;
}

/** The last line of `upfly audit --json`. */
export interface AuditResult {
  readonly type: 'result';
  readonly command: 'audit';
  readonly exitCode: 0;
  readonly report: Report;
  /** What `optimize` would convert and save, or null when it was not measured. */
  readonly savings: {
    readonly images: number;
    readonly bytes: number;
    readonly savedBytes: number;
    readonly unmeasured: number;
    readonly conversions: readonly Conversion[];
  } | null;
}

/** Why Upfly does not follow a line that names an image's path. */
export type UnfollowedReason =
  | 'full-address'
  | 'built-at-runtime'
  | 'data-or-props'
  | 'unread-file-type'
  | 'comment'
  | 'folder'
  | 'other';

/** The last line of `upfly refs <image> --json`. */
export interface RefsResult {
  readonly type: 'result';
  readonly command: 'refs';
  readonly exitCode: 0;
  readonly image: string;
  readonly bytes: number;
  readonly references: readonly (Located & {
    readonly text: string;
    readonly rewritable: boolean;
    readonly why?: string;
  })[];
  readonly unfollowed: readonly {
    readonly file: string;
    readonly line: number;
    readonly text: string;
    readonly reason: UnfollowedReason;
    readonly why: string;
    readonly loads: boolean;
    readonly host?: string;
  }[];
  readonly unsearchable?: readonly { readonly file: string; readonly reason: string }[];
  readonly verdict:
    | {
        readonly kind: 'converts';
        readonly to: string;
        readonly savedBytes: number;
        readonly removesOriginal: boolean;
      }
    | { readonly kind: 'not-converted'; readonly why: string }
    | { readonly kind: 'unused' }
    | {
        readonly kind: 'possibly-unused';
        readonly mentions: readonly { readonly where: string; readonly quote: string }[];
      };
}

/** A command's result line. */
export type ResultLine = AuditResult | RefsResult;
