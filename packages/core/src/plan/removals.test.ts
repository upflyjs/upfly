import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding } from '../audit/audit.js';
import { buildGraph } from '../graph/graph.js';
import type { AssetProbe, ImageMetadata } from '../probe/probe.js';
import type { Asset, RawReference, Reference } from '../types.js';
import type { HedgedMention } from './plan.js';
import { type RemovalInput, convertedPath, planRemovals } from './removals.js';

const ROOT = resolve('/repo');

function asset(relative: string, bytes = 10_000): Asset {
  return {
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes,
  };
}

function header(relative: string, over: Partial<ImageMetadata> = {}): AssetProbe {
  const extension = relative.slice(relative.lastIndexOf('.') + 1);
  return {
    relative,
    metadata: { width: 64, height: 48, format: extension, pages: 1, ...over },
    encoded: [],
    skipped: [],
  };
}

const RAW: Omit<RawReference, 'file' | 'rawPath' | 'start' | 'end'> = {
  kind: 'attr',
  shape: 'html.img.src',
  ceiling: 'high',
  asserted: true,
};

function linked(file: string, rawPath: string, target: string): Reference {
  return {
    ...RAW,
    file: `${ROOT}/${file}`,
    rawPath,
    start: 10,
    end: 10 + rawPath.length,
    resolution: 'resolved',
    confidence: 'high',
    resolvedPath: `${ROOT}/${target}`,
    resolvedVia: 'file',
  } as Reference;
}

function dead(relative: string): Finding {
  return { kind: 'dead', asset: relative, bytes: 10_000, inPublicDir: false };
}

const PNG = 'images/arrived.png';
const WEBP = 'images/arrived.webp';

/**
 * An original kept beside its converted file, which a page names: what an editor leaves after
 * converting an image that arrived from outside it, once a line names the new file.
 */
function kept(over: Partial<RemovalInput> & { references?: Reference[] } = {}): RemovalInput {
  const { references, ...rest } = over;
  return {
    graph: buildGraph({
      root: ROOT,
      assets: [asset(PNG), asset(WEBP, 2_000)],
      references: references ?? [linked('page.html', 'images/arrived.webp', WEBP)],
      unscannedFiles: [],
      texts: [],
    }),
    audit: { findings: [dead(PNG)], conventionLinked: [] },
    probes: [header(PNG), header(WEBP)],
    format: 'webp',
    originals: new Set([PNG]),
    hedged: new Map(),
    ...rest,
  };
}

function reasonFor(input: RemovalInput, path = PNG): string | undefined {
  return planRemovals(input).declined.find((entry) => entry.path === path)?.reason;
}

describe('planRemovals', () => {
  it('removes an original whose converted file stands beside it and that nothing names', () => {
    const plan = planRemovals(kept());

    expect(plan.removals).toEqual([{ asset: PNG, converted: WEBP }]);
    expect(plan.declined).toEqual([]);
  });

  it('converts nothing and rewrites nothing', () => {
    const plan = planRemovals(kept());

    expect(plan.conversions).toEqual([]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.keptOriginals).toEqual([]);
    expect(plan.refusal).toBeNull();
  });

  it('keeps an original with no converted file beside it', () => {
    const input = kept({
      graph: buildGraph({
        root: ROOT,
        assets: [asset(PNG), asset('images/elsewhere/arrived.webp')],
        references: [],
        unscannedFiles: [],
        texts: [],
      }),
    });

    expect(planRemovals(input).removals).toEqual([]);
    expect(reasonFor(input)).toBe(`no ${WEBP} stands beside it, so nothing has replaced it`);
  });

  it('keeps an original whose converted file is another picture of another size', () => {
    const input = kept({ probes: [header(PNG), header(WEBP, { width: 32, height: 32 })] });

    expect(planRemovals(input).removals).toEqual([]);
    expect(reasonFor(input)).toBe(
      `${WEBP} is 32×32 where this image is 64×48, so it is not this image converted`,
    );
  });

  it('keeps an animation whose converted file holds one frame', () => {
    const gif = 'images/spinner.gif';
    const still = 'images/spinner.webp';
    const input = kept({
      graph: buildGraph({
        root: ROOT,
        assets: [asset(gif), asset(still)],
        references: [],
        unscannedFiles: [],
        texts: [],
      }),
      audit: { findings: [dead(gif)], conventionLinked: [] },
      probes: [header(gif, { pages: 12 }), header(still)],
      originals: new Set([gif]),
    });

    expect(reasonFor(input, gif)).toBe(
      `${still} holds 1 frame where this image holds 12 frames, so it is not this image converted`,
    );
  });

  it('keeps an original whose converted file is not in the format its name says', () => {
    const input = kept({ probes: [header(PNG), header(WEBP, { format: 'png' })] });

    expect(reasonFor(input)).toBe(
      `${WEBP} could not be read as a WebP image, so it cannot stand in for this one`,
    );
  });

  it('keeps an original when either header could not be read', () => {
    const unreadable = (relative: string): AssetProbe => ({ ...header(relative), metadata: null });

    expect(reasonFor(kept({ probes: [header(PNG), unreadable(WEBP)] }))).toMatch(
      /^images\/arrived\.webp could not be read as a WebP image/,
    );
    expect(reasonFor(kept({ probes: [unreadable(PNG), header(WEBP)] }))).toBe(
      `it could not be read as an image, so Upfly cannot check that ${WEBP} shows the same picture`,
    );
    expect(reasonFor(kept({ probes: [] }))).toMatch(/^it could not be read as an image/);
  });

  it('keeps an original a reference still names, naming the file', () => {
    const input = kept({
      references: [
        linked('page.html', 'images/arrived.webp', WEBP),
        linked('agent.html', 'images/arrived.png', PNG),
        linked('other.html', 'images/arrived.png', PNG),
      ],
      audit: { findings: [], conventionLinked: [] },
    });

    expect(planRemovals(input).removals).toEqual([]);
    expect(reasonFor(input)).toBe(
      '`agent.html` names it as `images/arrived.png` (and 1 more), so a page still uses it',
    );
  });

  it('keeps an original a pattern still reaches', () => {
    const glob = {
      ...linked('src/gallery.ts', './images/*.png', PNG),
      ceiling: 'medium',
      resolution: 'resolved-pattern',
      confidence: 'medium',
      resolvedPaths: [`${ROOT}/${PNG}`],
    } as unknown as Reference;
    const input = kept({ references: [glob], audit: { findings: [], conventionLinked: [] } });

    expect(reasonFor(input)).toBe(
      '`src/gallery.ts` reaches it through `./images/*.png`, so a page still uses it',
    );
  });

  it('keeps an original a framework reads by its file name', () => {
    const icon = 'app/icon.png';
    const input = kept({
      graph: buildGraph({
        root: ROOT,
        assets: [asset(icon), asset('app/icon.webp')],
        references: [],
        unscannedFiles: [],
        texts: [],
      }),
      audit: {
        findings: [],
        conventionLinked: [
          {
            asset: icon,
            reason: 'Next.js reads this from its route segment by filename; nothing references it',
          },
        ],
      },
      probes: [header(icon), header('app/icon.webp')],
      originals: new Set([icon]),
    });

    expect(reasonFor(input, icon)).toBe(
      'Next.js reads this from its route segment by filename; nothing references it',
    );
  });

  it('keeps an original whose name appears where a page may load it', () => {
    const hedge: HedgedMention = {
      where: 'src/App.vue:3',
      says: 'names it in a .vue file, a type Upfly does not read',
      loads: true,
    };
    const possibly: Finding = {
      kind: 'possibly-dead',
      asset: PNG,
      bytes: 10_000,
      inPublicDir: false,
      evidence: [
        { asset: PNG, source: 'unscanned-file', where: 'src/App.vue:3', quote: 'arrived.png' },
      ],
    };
    const input = kept({
      audit: { findings: [possibly], conventionLinked: [] },
      hedged: new Map([[PNG, hedge]]),
    });

    expect(reasonFor(input)).toBe(
      'src/App.vue:3 names it in a .vue file, a type Upfly does not read',
    );
  });

  it('keeps an original the audit did not find unused, whatever else it found', () => {
    const input = kept({ audit: { findings: [], conventionLinked: [] } });

    expect(reasonFor(input)).toBe('Upfly could not rule out that something names it');
  });

  it('keeps an original the search before a delete found named, excluded or unread', () => {
    const mention = kept({
      blockedByMention: new Map([
        [PNG, { where: 'notes.md:4', kind: 'in a comment, which no page loads' }],
      ]),
    });
    const excluded = kept({ blockedByExclusion: new Map([[PNG, 'drafts/page.html:2']]) });
    const unread = kept({ blockedByUnread: new Map([[PNG, 'locked/']]) });

    expect(reasonFor(mention)).toBe(
      'notes.md:4 still names its path: in a comment, which no page loads',
    );
    expect(reasonFor(excluded)).toBe(
      'drafts/page.html:2 still names its path, in a file this run excluded',
    );
    expect(reasonFor(unread)).toBe('locked/ could not be read to rule out a mention of it');
    for (const input of [mention, excluded, unread]) {
      expect(planRemovals(input).removals).toEqual([]);
    }
  });

  it('keeps an image already in the format, and a vector', () => {
    const vector = 'images/logo.svg';
    const input = kept({
      graph: buildGraph({
        root: ROOT,
        assets: [asset(WEBP), asset(vector), asset('images/logo.webp')],
        references: [],
        unscannedFiles: [],
        texts: [],
      }),
      audit: { findings: [dead(WEBP), dead(vector)], conventionLinked: [] },
      probes: [header(WEBP), header(vector), header('images/logo.webp')],
      originals: new Set([WEBP, vector]),
    });

    expect(planRemovals(input).removals).toEqual([]);
    expect(reasonFor(input, WEBP)).toBe(
      'its name already ends in .webp, so it is a converted file rather than an original beside one',
    );
    expect(reasonFor(input, vector)).toBe(
      'it is a vector, which Upfly never converts, so images/logo.webp is not a converted copy of it',
    );
  });

  it('plans nothing for a path that is not an image in the project, leaving the caller to say so', () => {
    const plan = planRemovals(kept({ originals: new Set(['images/missing.png']) }));

    expect(plan.removals).toEqual([]);
    expect(plan.declined).toEqual([]);
  });

  it('looks for the converted file in the run format, an AVIF header named heif', () => {
    const avif = 'images/arrived.avif';
    const input = kept({
      graph: buildGraph({
        root: ROOT,
        assets: [asset(PNG), asset(avif)],
        references: [],
        unscannedFiles: [],
        texts: [],
      }),
      probes: [header(PNG), header(avif, { format: 'heif' })],
      format: 'avif',
    });

    expect(planRemovals(input).removals).toEqual([{ asset: PNG, converted: avif }]);
  });

  it('decides each original named on its own, in path order', () => {
    const other = 'images/second.png';
    const input = kept({
      graph: buildGraph({
        root: ROOT,
        assets: [asset(PNG), asset(WEBP), asset(other)],
        references: [],
        unscannedFiles: [],
        texts: [],
      }),
      audit: { findings: [dead(PNG), dead(other)], conventionLinked: [] },
      probes: [header(PNG), header(WEBP), header(other)],
      originals: new Set([other, PNG]),
    });
    const plan = planRemovals(input);

    expect(plan.removals.map((removal) => removal.asset)).toEqual([PNG]);
    expect(plan.declined.map((entry) => entry.path)).toEqual([other]);
  });
});

describe('convertedPath', () => {
  it('swaps the extension and keeps everything before it as written', () => {
    expect(convertedPath('app/blog/[slug]/Og Image.PNG', 'webp')).toBe(
      'app/blog/[slug]/Og Image.webp',
    );
    expect(convertedPath('photos/a.b.jpeg', 'avif')).toBe('photos/a.b.avif');
  });
});
