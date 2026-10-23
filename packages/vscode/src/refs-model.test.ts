import { describe, expect, it } from 'vitest';
import type { RefsResult } from './contract.js';
import { refsNodes } from './refs-model.js';

function result(extra: Partial<RefsResult> = {}): RefsResult {
  return {
    type: 'result',
    command: 'refs',
    exitCode: 0,
    image: 'public/hero.png',
    bytes: 48_000,
    references: [],
    unfollowed: [],
    verdict: { kind: 'unused' },
    ...extra,
  };
}

describe('refsNodes', () => {
  it('opens with the image and its size', () => {
    expect(refsNodes(result())[0]).toMatchObject({
      label: 'public/hero.png',
      description: '48 KB',
      open: { file: 'public/hero.png', line: null },
    });
  });

  it('lists each reference at its file and line, with the path as written', () => {
    const nodes = refsNodes(
      result({
        references: [{ file: 'src/App.tsx', line: 12, text: '/hero.png', rewritable: true }],
      }),
    );
    expect(nodes[1]?.label).toBe('References');
    expect(nodes[1]?.children?.[0]).toMatchObject({
      label: 'src/App.tsx:12',
      description: '/hero.png',
      open: { file: 'src/App.tsx', line: 12, search: '/hero.png' },
    });
  });

  it('says why a reference stays as written', () => {
    const nodes = refsNodes(
      result({
        references: [
          {
            file: 'a.ts',
            line: 3,
            text: 'hero.png',
            rewritable: false,
            why: 'a path built at runtime',
          },
        ],
      }),
    );
    expect(nodes[1]?.children?.[0]?.tooltip).toBe(
      'Stays as written in every run: a path built at runtime',
    );
  });

  it('lists each line Upfly does not follow with its reason and whether a page can still load the image through it', () => {
    const nodes = refsNodes(
      result({
        unfollowed: [
          {
            file: 'index.html',
            line: 4,
            text: 'https://example.com/hero.png',
            reason: 'full-address',
            why: 'A full address, which Upfly never rewrites.',
            loads: true,
            host: 'example.com',
          },
          {
            file: 'README.md',
            line: 9,
            text: 'hero.png',
            reason: 'comment',
            why: 'A comment.',
            loads: false,
          },
        ],
      }),
    );
    const unfollowed = nodes[2];
    expect(unfollowed?.label).toBe('Not followed');
    expect(unfollowed?.children?.map((node) => node.description)).toEqual([
      'a full address; a page can still load the image through it',
      'a comment; nothing loads the image through it',
    ]);
  });

  it('lists the files the search could not read', () => {
    const nodes = refsNodes(
      result({ unsearchable: [{ file: 'big.bin', reason: 'too large to search' }] }),
    );
    expect(
      nodes.find((node) => node.label === 'Could not be searched')?.children?.[0],
    ).toMatchObject({
      label: 'big.bin',
      description: 'too large to search',
    });
  });

  it('ends with what optimize would do with the image', () => {
    const nodes = refsNodes(
      result({
        verdict: {
          kind: 'converts',
          to: 'public/hero.webp',
          savedBytes: 30_000,
          removesOriginal: true,
        },
      }),
    );
    expect(nodes.at(-1)).toMatchObject({
      label: 'What optimize would do',
      description: 'converts it to public/hero.webp, 30 KB smaller, and removes the original',
    });
  });

  it('lists the mentions of a possibly unused image under the verdict', () => {
    const nodes = refsNodes(
      result({
        verdict: {
          kind: 'possibly-unused',
          mentions: [{ where: 'cms/export.sql:20', quote: 'hero.png' }],
        },
      }),
    );
    expect(nodes.at(-1)?.children?.[0]).toMatchObject({
      label: 'hero.png',
      open: { file: 'cms/export.sql', line: 20 },
    });
  });

  it('says plainly when nothing references the image', () => {
    expect(refsNodes(result())[1]).toMatchObject({ label: 'References', description: 'none' });
  });
});
