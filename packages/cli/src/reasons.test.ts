import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OTHER, countGroups, declineGroup, stayGroup, unmeasuredGroup } from './reasons.js';

/** The plan `optimize --json` printed for the plain HTML fixture, as the engine wrote it. */
const planned = JSON.parse(
  readFileSync(new URL('../test/golden/optimize-plain-html.jsonl', import.meta.url), 'utf8')
    .trimEnd()
    .split('\n')
    .at(-1) ?? '{}',
) as { plan: { declined: { path: string; reason: string }[] } };

describe('declineGroup', () => {
  it('names a group for every reason the planner gave on a real run', () => {
    const groups = planned.plan.declined.map((entry) => [entry.path, declineGroup(entry.reason)]);
    expect(groups).toEqual([
      ['images/badge.png', 'would save too little'],
      ['images/badge@2x.png', 'would save too little'],
      ['images/favicon.png', 'no reference would move to a new file'],
      ['images/never-referenced.png', 'no reference would move to a new file'],
      ['images/removed.png', 'no reference would move to a new file'],
      ['images/team.jpg', 'would save too little'],
    ]);
  });

  it('groups both kinds of saving too small, as the engine words them', () => {
    const under = [
      'converting it would save 34 B, under the 1 KB a saving must reach to be reported or converted',
      'converting it would save 1.5 KB, 2% of the file, under the 10% of the file or 4 KB a saving must reach to be reported or converted',
    ];
    for (const reason of under) expect(declineGroup(reason)).toBe('would save too little');
  });

  it('groups the reasons that keep an original or a name, as the planner writes them', () => {
    const cases: [string, string][] = [
      [
        'measured as webp and came out no smaller, so converting it would cost bytes rather than save them',
        'no smaller when converted',
      ],
      [
        'nothing Upfly can see links to it, so a new file would be used by nobody. Upfly converts an image only when a reference moves to the new file',
        'no reference would move to a new file',
      ],
      [
        'img/a.webp already exists, so converting it would replace a file rather than add one. Rename one of them and run again.',
        'its new name is taken by another file',
      ],
      [
        'converting it would delete the original, and notes.txt:3 (and 1 more) still names its path: in a code example, which a page shows rather than loads',
        'named where Upfly cannot rewrite it',
      ],
      [
        'converting it would delete the original, and legacy/old.html:1 still names its path, in a file this run excluded',
        'named in a file this run leaves out',
      ],
      [
        'converting it would delete the original, and vendor/big.js could not be read to rule out a mention of it',
        'a file that may name it could not be read',
      ],
      [
        '`src/App.jsx` reaches it only through `./img/${name}.png`, a template assembled at run time. No reference would move to a new file, so it would be used by nobody. Upfly converts an image only when a reference moves to the new file',
        'no reference would move to a new file',
      ],
      [
        'its name already ends in .webp, but the file is JPEG, so there is no new name to convert it to. A browser reads the bytes rather than the name, so the image loads as it is; saving it again as a real .webp file would need no other change',
        'named for a format the file is not',
      ],
      [
        'its name already ends in .avif, but the file is PNG, so there is no new name to convert it to. A browser reads the bytes rather than the name, so the image loads as it is; saving it again as a real .avif file would need no other change',
        'named for a format the file is not',
      ],
    ];
    for (const [reason, group] of cases) expect(declineGroup(reason), reason).toBe(group);
  });

  it('groups an image a build loads, in each way the planner names the build', () => {
    const loaded = [
      '`src/views/splash/features/features-banner.jsx` loads it through the build as `./high-contrast-thumbnail.png`, and that build is set up in `webpack.config.js`, which may have no rule for WebP files; Upfly converts an image a build loads only for Vite, Next.js and Astro, which load WebP by themselves',
      '`src/index.js` loads it through the build as `./logo.png` (and 1 more), and that build is run as `react-scripts build` from `package.json`, which may have no rule for AVIF files; Upfly converts an image a build loads only for Vite, Next.js and Astro, which load AVIF by themselves',
      '`src/App.jsx` loads it through the build as `./inline-logo.jpg`, and Upfly found no build settings naming that build; Upfly converts an image a build loads only for Vite, Next.js and Astro, which load WebP by themselves',
    ];
    for (const reason of loaded) {
      expect(declineGroup(reason), reason).toBe('its build may not load the new format');
    }
  });

  it('groups a conversion that would make a reference break or load another file, in each of its sentences', () => {
    const misdirected = [
      '`img/lvm.jpg` in `about.html` reaches img/LVM.jpg on Windows and macOS, where a file is found whatever the case of its name, and converting this image removes it, so the reference would break.',
      '`logo.png` in `index.html` reaches img/logo.png, and converting this image removes it, so the reference would load public/logo.png instead. Rename one of the two images and run again.',
      '`/logo.png` in `index.html` (and 2 more) reaches public/logo.png, and once this image converts it would reach static/logo.webp first, so the reference would load the converted image instead. Rename one of the two images and run again.',
      '`logo.png` in `src/App.jsx` would become `logo.webp`, which reaches public/logo.webp first, so the reference would load that file instead. Rename one of the two images and run again.',
      '`logo.png` in `src/App.jsx` would become `logo.webp`, which names no file Upfly can find, so repointing the reference would break it.',
    ];
    for (const reason of misdirected) {
      expect(declineGroup(reason), reason).toBe('a reference would break or load another file');
    }
  });

  it('counts a sentence it does not know under another reason, rather than dropping it', () => {
    expect(declineGroup('a reason added after this list was written')).toBe(OTHER);
  });
});

describe('unmeasuredGroup', () => {
  it('names the format an image already has, and every way a measurement can fail', () => {
    expect(unmeasuredGroup('vector', 'webp')).toBe('SVG, which Upfly does not convert');
    expect(unmeasuredGroup('already-target-format', 'avif')).toBe('already AVIF');
    expect(unmeasuredGroup('encode-failed', 'webp')).toBe('could not be measured');
    expect(unmeasuredGroup(null, 'webp')).toBe(OTHER);
  });
});

describe('stayGroup', () => {
  it('groups why a reference to a copy stays as written', () => {
    expect(
      stayGroup(
        'an import names a file for the bundler, and public/a.png is in a folder the site serves as it is, which bundlers such as Vite do not import from',
      ),
    ).toBe('an import cannot reach a folder the site serves');
    expect(stayGroup('the reference has no static path to replace')).toBe(
      'it cannot be rewritten safely',
    );
  });
});

describe('countGroups', () => {
  it('counts each group once, the largest first, ties by name', () => {
    expect(countGroups(['b', 'a', 'b', 'c', 'a', 'b'])).toEqual([
      { count: 3, text: 'b' },
      { count: 2, text: 'a' },
      { count: 1, text: 'c' },
    ]);
  });
});
