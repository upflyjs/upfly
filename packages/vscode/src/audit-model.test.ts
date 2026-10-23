import { describe, expect, it } from 'vitest';
import { type TreeNode, auditNodes, parseWhere } from './audit-model.js';
import type { AuditResult, Finding, Report } from './contract.js';

function result(findings: Finding[] = [], extra: Partial<AuditResult> = {}): AuditResult {
  const report: Report = {
    summary: {
      assets: 12,
      assetBytes: 126_939,
      sourceFiles: 5,
      references: 12,
      linkedReferences: 10,
      referencedAssets: 10,
      potentialSavingBytes: 75_455,
      probed: true,
      unmeasuredAssets: 0,
    },
    findings,
    unusedVectors: { count: 0, bytes: 0 },
    keptOriginals: { count: 0, bytes: 0, assets: [] },
    references: { unsafe: [], leftOut: [] },
    coverage: {
      unscannedExtensions: [],
      excludedRoots: [],
      servingRoots: { dirs: ['public'], declared: false },
    },
    skipped: [],
    caveats: [],
  };
  return { type: 'result', command: 'audit', exitCode: 0, report, savings: null, ...extra };
}

function section(nodes: readonly TreeNode[], label: string): TreeNode {
  const found = nodes.find((node) => node.label.startsWith(label));
  if (found === undefined) throw new Error(`no section ${label}: ${nodes.map((n) => n.label)}`);
  return found;
}

describe('auditNodes', () => {
  it('counts the images found and their size', () => {
    const images = section(auditNodes(result()), '12 images');
    expect(images.description).toBe('126.9 KB, 10 in use');
  });

  it('counts the references and the files that hold them', () => {
    const references = section(auditNodes(result()), '12 references');
    expect(references.description).toBe('in 5 files, 10 lead to an image');
  });

  it('lists each image optimize would convert with what it saves, opening the image', () => {
    const nodes = auditNodes(
      result(
        [
          {
            kind: 'format-opportunity',
            asset: 'src/banner.png',
            to: 'webp',
            bytes: 59_782,
            wouldBe: 7_182,
            savedBytes: 52_600,
            savedPercent: 87,
          },
        ],
        {
          savings: {
            images: 1,
            bytes: 59_782,
            savedBytes: 52_600,
            unmeasured: 0,
            conversions: [
              {
                asset: 'src/banner.png',
                target: 'src/banner.webp',
                format: 'webp',
                savedBytes: 52_600,
                replacesOriginal: true,
              },
            ],
          },
        },
      ),
    );
    const smaller = section(nodes, 'Could be smaller');
    expect(smaller.description).toBe('1 image, 52.6 KB less');
    expect(smaller.children?.[0]).toMatchObject({
      label: 'src/banner.png',
      description: '59.8 KB to 7.2 KB as WebP, 87% smaller',
      open: { file: 'src/banner.png', line: null },
      image: 'src/banner.png',
    });
  });

  it("falls back to the measured findings when optimize's savings are not known", () => {
    const nodes = auditNodes(
      result([
        {
          kind: 'format-opportunity',
          asset: 'a.png',
          to: 'webp',
          bytes: 2_000,
          wouldBe: 1_000,
          savedBytes: 1_000,
          savedPercent: 50,
        },
      ]),
    );
    expect(section(nodes, 'Could be smaller').children?.map((node) => node.label)).toEqual([
      'a.png',
    ]);
  });

  it('opens a broken reference in its file at its line', () => {
    const nodes = auditNodes(
      result([
        {
          kind: 'broken',
          file: 'src/App.tsx',
          line: 14,
          where: 'src/App.tsx:14',
          rawPath: './gone.png',
        },
      ]),
    );
    expect(section(nodes, 'Broken references').children?.[0]).toMatchObject({
      label: './gone.png',
      description: 'src/App.tsx:14',
      open: { file: 'src/App.tsx', line: 14 },
    });
  });

  it('marks an unused image in a served folder, since something outside may link to it', () => {
    const nodes = auditNodes(
      result([{ kind: 'dead', asset: 'public/old.png', bytes: 70, inPublicDir: true }]),
    );
    const unused = section(nodes, 'Unused');
    expect(unused.description).toBe('1 image, 70 B');
    expect(unused.children?.[0]?.description).toBe('70 B, in a folder the site serves');
  });

  it('lists where the name of a possibly unused image appears, opening each place', () => {
    const nodes = auditNodes(
      result([
        {
          kind: 'possibly-dead',
          asset: 'img/logo.png',
          bytes: 900,
          inPublicDir: false,
          evidence: [{ asset: 'img/logo.png', where: 'data/site.yml:3', quote: 'logo.png' }],
        },
      ]),
    );
    const image = section(nodes, 'Possibly unused').children?.[0];
    expect(image?.children?.[0]).toMatchObject({
      label: 'logo.png',
      description: 'data/site.yml:3',
      open: { file: 'data/site.yml', line: 3 },
    });
  });

  it('lists each copy in a set of identical images', () => {
    const nodes = auditNodes(
      result([{ kind: 'duplicate', assets: ['a.png', 'b/a.png'], bytes: 70, wastedBytes: 70 }]),
    );
    const set = section(nodes, 'Identical copies').children?.[0];
    expect(set?.label).toBe('2 copies, 70 B each');
    expect(set?.children?.map((node) => node.open?.file)).toEqual(['a.png', 'b/a.png']);
  });

  it('names the limits an oversized image is over', () => {
    const nodes = auditNodes(
      result([
        {
          kind: 'oversized',
          asset: 'hero.jpg',
          bytes: 2_400_000,
          width: 6000,
          height: 4000,
          exceeded: ['bytes', 'width'],
        },
      ]),
    );
    expect(section(nodes, 'Oversized').children?.[0]?.description).toBe(
      '2.4 MB, 6000 x 4000 pixels: over the size and the width limits',
    );
  });

  it('says none under a kind of finding the audit did not find', () => {
    const broken = section(auditNodes(result()), 'Broken references');
    expect(broken.description).toBe('none');
    expect(broken.children).toBeUndefined();
  });

  it('opens a reference that is never rewritten at the path as written, its line not being known', () => {
    const plain = result();
    const nodes = auditNodes({
      ...plain,
      report: {
        ...plain.report,
        references: {
          leftOut: [],
          unsafe: [
            {
              file: 'src/a.ts',
              rawPath: '`/img/${name}.png`',
              resolution: 'dynamic',
              reason: 'built at runtime',
            },
          ],
        },
      },
    });
    const never = section(nodes, '12 references').children?.[0]?.children?.[0];
    expect(never?.open).toEqual({ file: 'src/a.ts', line: null, search: '`/img/${name}.png`' });
  });
});

describe('parseWhere', () => {
  it('reads a file and its line', () => {
    expect(parseWhere('src/a.css:12')).toEqual({ file: 'src/a.css', line: 12 });
  });

  it('reads a file alone when no line is given', () => {
    expect(parseWhere('notes/README')).toEqual({ file: 'notes/README', line: null });
  });
});
