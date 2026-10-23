/**
 * Whether each conversion's original sits in a folder the site is served from, which
 * `optimize --json` and `audit --json` give as `inPublicDir`, through the built binary on a
 * copy of the vite-react fixture: `public/` holds served images, `src/assets/` bundled ones.
 */

import { existsSync, rmSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BIN, copyFixture, jsonLines, tempFolder, upfly } from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Conversion {
  readonly asset: string;
  readonly replacesOriginal: boolean;
  readonly inPublicDir: boolean;
}

describe('inPublicDir', () => {
  it('marks the originals in a served folder, and only those, as the dry run counts them', () => {
    const root = copyFixture('vite-react', tempFolder(roots, 'upfly-served-'));

    const json = upfly(['optimize', root, '--json']);
    const text = upfly(['optimize', root]);

    expect(json.status, json.stderr).toBe(0);
    const { conversions } = (jsonLines(json.stdout).at(-1)?.plan ?? {}) as {
      conversions: Conversion[];
    };
    expect(conversions.length).toBeGreaterThan(0);
    for (const conversion of conversions) {
      expect(conversion.inPublicDir, conversion.asset).toBe(conversion.asset.startsWith('public/'));
    }
    const served = conversions.filter((each) => each.replacesOriginal && each.inPublicDir).length;
    expect(served).toBeGreaterThan(0);
    expect(text.stdout).toMatch(
      new RegExp(`\\b${served} of them are in a folder the site is served from`),
    );
  }, 120_000);

  it('is the same in the savings audit lists', () => {
    const root = copyFixture('vite-react', tempFolder(roots, 'upfly-served-audit-'));

    const audit = upfly(['audit', root, '--json']);

    expect(audit.status, audit.stderr).toBe(0);
    const savings = jsonLines(audit.stdout).at(-1)?.savings as { conversions: Conversion[] };
    for (const conversion of savings.conversions) {
      expect(conversion.inPublicDir, conversion.asset).toBe(conversion.asset.startsWith('public/'));
    }
  }, 120_000);
});
