import { describe, expect, it } from 'vitest';
import type { AuditResult, Finding } from './contract.js';
import { codeSpan, renderReport } from './report.js';

function result(findings: Finding[] = []): AuditResult {
  return {
    type: 'result',
    command: 'audit',
    exitCode: 0,
    report: {
      summary: {
        assets: 3,
        assetBytes: 3_000,
        sourceFiles: 2,
        references: 4,
        linkedReferences: 3,
        referencedAssets: 2,
        potentialSavingBytes: 0,
        probed: true,
        unmeasuredAssets: 0,
      },
      findings,
      unusedVectors: { count: 0, bytes: 0 },
      keptOriginals: { count: 0, bytes: 0, assets: [] },
      references: { unsafe: [], leftOut: [] },
      coverage: {
        unscannedExtensions: [{ ext: '.yml', fileCount: 2 }],
        excludedRoots: [{ path: 'dist', reason: 'a build output folder' }],
        servingRoots: { dirs: ['public'], declared: false },
      },
      skipped: [],
      caveats: [{ code: 'nothing-to-measure', message: '1 image needed no measurement' }],
    },
    savings: null,
  };
}

const META = { folder: 'site', path: '/work/site', when: '2026-10-23 16:00', cliVersion: '3.1.0' };

describe('renderReport', () => {
  it('opens with the folder, when the audit ran and which upfly ran it', () => {
    const text = renderReport(result(), META);
    expect(text.split('\n').slice(0, 3)).toEqual([
      '# Upfly audit: site',
      '',
      'The folder /work/site, read on 2026-10-23 16:00 by upfly 3.1.0. Nothing was changed.',
    ]);
  });

  it('lists each broken reference with its file and line', () => {
    const text = renderReport(
      result([{ kind: 'broken', file: 'a.html', line: 3, where: 'a.html:3', rawPath: 'gone.png' }]),
      META,
    );
    expect(text).toContain('- `gone.png` in a.html:3');
  });

  it('says none under a kind of finding the audit did not find', () => {
    expect(renderReport(result(), META)).toContain('## Broken references\n\nNone.');
  });

  it('says which folders the site is served from, and who decided', () => {
    expect(renderReport(result(), META)).toContain(
      '- Served from: `public`, worked out by Upfly from what the paths resolve against.',
    );
  });

  it('names the file types no reader reads and the folders not entered', () => {
    const text = renderReport(result(), META);
    expect(text).toContain('- Not read: 2 files of type `.yml`.');
    expect(text).toContain('- Not entered: `dist`, a build output folder.');
  });

  it("quotes the CLI's notes as they are", () => {
    expect(renderReport(result(), META)).toContain('- 1 image needed no measurement');
  });
});

describe('codeSpan', () => {
  it('fences a path that holds a backtick with a longer run of them', () => {
    expect(codeSpan('a`b.png')).toBe('``a`b.png``');
  });

  it('pads a path that starts with a backtick, as Markdown needs', () => {
    expect(codeSpan('`x`')).toBe('`` `x` ``');
  });
});
