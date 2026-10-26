/**
 * `upfly optimize --remove-originals`, through the built binary, on copies of the plain HTML
 * fixture outside the workspace: an image that arrived converted with its original kept, as
 * an editor converts one written from outside it, and that original removed later.
 */

import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
  FIXTURES,
  commitAll,
  copyFixture,
  git,
  jsonLines,
  snapshot,
  tempFolder,
  upfly,
  write,
} from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOT_THE_PROJECT = ['.git', '.upfly'];
const PNG = 'images/arrived.png';
const WEBP = 'images/arrived.webp';

function result(stdout: string): Record<string, unknown> {
  return jsonLines(stdout).at(-1) ?? {};
}

interface Plan {
  readonly removals: { asset: string; converted: string; inPublicDir: boolean }[];
  readonly declined: { path: string; line: number | null; reason: string }[];
  readonly conversions: unknown[];
  readonly rewrites: unknown[];
}

/**
 * A copy of plain-html, committed, into which an image arrived and was converted with its
 * original kept, as an editor does for an image written from outside it.
 */
function arrived(): string {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-removal-'));
  commitAll(root);
  copyFileSync(join(FIXTURES, 'plain-html/images/logo.png'), join(root, PNG));
  const converted = upfly([
    'optimize',
    root,
    '--apply',
    '--allow-dirty',
    '--no-undo',
    '--keep-originals',
    '--public',
    '.',
    '--image',
    join(root, PNG),
    '--json',
  ]);
  expect(converted.status, converted.stderr).toBe(0);
  expect(existsSync(join(root, WEBP))).toBe(true);
  return root;
}

function removal(root: string, ...flags: string[]) {
  return upfly([
    'optimize',
    root,
    '--public',
    '.',
    '--remove-originals',
    '--image',
    join(root, PNG),
    '--json',
    ...flags,
  ]);
}

describe('upfly optimize --remove-originals', () => {
  it('plans the removal on a dry run, once a page names the converted file, and writes nothing', () => {
    const root = arrived();
    write(root, 'page.html', `<img src="${WEBP}" alt="">\n`);
    const before = snapshot(root, ['.git']);

    const plan = removal(root);

    expect(plan.status, plan.stderr).toBe(0);
    const answer = result(plan.stdout);
    expect(answer.plan).toMatchObject({
      removals: [{ asset: PNG, converted: WEBP, inPublicDir: true }],
      declined: [],
      conversions: [],
      rewrites: [],
    });
    expect(answer.only).toEqual({ images: [PNG], unmatched: [] });
    expect(answer.run).toBeNull();
    expect(jsonLines(plan.stdout)).toContainEqual({
      type: 'progress',
      command: 'optimize',
      stage: 'planned',
      conversions: 0,
      rewrites: 0,
      removals: 1,
    });
    expect(snapshot(root, ['.git'])).toEqual(before);
  }, 120_000);

  it('removes it, the converted file and every other byte staying, and undo brings it back', () => {
    const root = arrived();
    write(root, 'page.html', `<img src="${WEBP}" alt="">\n`);
    const before = snapshot(root, NOT_THE_PROJECT);

    const applied = removal(root, '--apply', '--allow-dirty');

    expect(applied.status, applied.stderr).toBe(0);
    expect(result(applied.stdout).run).toMatchObject({ created: [], changed: [], removed: [PNG] });
    const after = snapshot(root, NOT_THE_PROJECT);
    expect(after).toEqual(
      Object.fromEntries(Object.entries(before).filter(([path]) => path !== PNG)),
    );

    const undone = upfly(['undo', root, '--json']);
    expect(undone.status, undone.stderr).toBe(0);
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 120_000);

  it("without undo, removes it and leaves the last run's record for undo as it was", () => {
    const root = arrived();
    const person = upfly(['optimize', root, '--apply', '--allow-dirty', '--public', '.', '--json']);
    expect(person.status, person.stderr).toBe(0);
    const last = (result(person.stdout).run as { id: string }).id;
    const record = readFileSync(join(root, '.upfly/manifest.json'));
    write(root, 'page.html', `<img src="${WEBP}" alt="">\n`);

    const applied = removal(root, '--apply', '--allow-dirty', '--no-undo');

    expect(applied.status, applied.stderr).toBe(0);
    expect(result(applied.stdout).run).toMatchObject({ removed: [PNG], undoable: false });
    expect(existsSync(join(root, PNG))).toBe(false);
    expect(readFileSync(join(root, '.upfly/manifest.json'))).toEqual(record);
    expect(existsSync(join(root, '.upfly/no-undo'))).toBe(false);
    const listed = upfly(['undo', root, '--list', '--json']);
    expect((result(listed.stdout).run as { id: string }).id).toBe(last);
  }, 120_000);

  it('keeps it while a page names it, saying where, and changes no file', () => {
    const root = arrived();
    write(root, 'page.html', `<img src="${WEBP}" alt="">\n<img src="${PNG}" alt="">\n`);
    const before = snapshot(root, NOT_THE_PROJECT);

    const applied = removal(root, '--apply', '--allow-dirty');

    expect(applied.status, applied.stderr).toBe(0);
    const answer = result(applied.stdout);
    expect((answer.plan as Plan).removals).toEqual([]);
    expect((answer.plan as Plan).declined).toEqual([
      {
        path: PNG,
        line: null,
        reason: '`page.html` names it as `images/arrived.png`, so a page still uses it',
      },
    ]);
    expect(answer.run).toBeNull();
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 120_000);

  it('keeps it while a comment names it, rewriting no line', () => {
    const root = arrived();
    write(root, 'page.html', `<!-- was ${PNG} -->\n<img src="${WEBP}" alt="">\n`);
    const before = snapshot(root, NOT_THE_PROJECT);

    const applied = removal(root, '--apply', '--allow-dirty');

    expect(applied.status, applied.stderr).toBe(0);
    const { declined } = result(applied.stdout).plan as Plan;
    expect(declined.map((entry) => [entry.path, entry.reason])).toEqual([
      [PNG, 'page.html:1 names it in a comment, which no page loads'],
    ]);
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 120_000);

  it('keeps an image with no converted file beside it, and one beside another picture', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-removal-'));
    commitAll(root);
    copyFileSync(join(FIXTURES, 'plain-html/images/logo.png'), join(root, 'images/lone.png'));
    // texture.png's own conversion, put beside a copy of the logo under the logo's name.
    const texture = upfly([
      'optimize',
      root,
      '--apply',
      '--allow-dirty',
      '--keep-originals',
      '--public',
      '.',
      '--image',
      join(root, 'images/texture.png'),
    ]);
    expect(texture.status, texture.stderr).toBe(0);
    copyFileSync(join(FIXTURES, 'plain-html/images/logo.png'), join(root, 'images/other.png'));
    copyFileSync(join(root, 'images/texture.webp'), join(root, 'images/other.webp'));
    const before = snapshot(root, NOT_THE_PROJECT);

    const applied = upfly([
      'optimize',
      root,
      '--public',
      '.',
      '--remove-originals',
      '--image',
      join(root, 'images/lone.png'),
      '--image',
      join(root, 'images/other.png'),
      '--apply',
      '--allow-dirty',
      '--json',
    ]);

    expect(applied.status, applied.stderr).toBe(0);
    const { declined, removals } = result(applied.stdout).plan as Plan;
    expect(removals).toEqual([]);
    expect(declined.map((entry) => entry.path)).toEqual(['images/lone.png', 'images/other.png']);
    expect(declined[0]?.reason).toBe(
      'no images/lone.webp stands beside it, so nothing has replaced it',
    );
    expect(declined[1]?.reason).toMatch(
      /^images\/other\.webp is \d+×\d+ where this image is \d+×\d+, so it is not this image converted$/,
    );
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 120_000);

  it('writes only the plan --expect-plan names, refusing one a page changed since', () => {
    const root = arrived();
    write(root, 'page.html', `<img src="${WEBP}" alt="">\n`);
    const planned = result(removal(root).stdout);
    write(root, 'agent.html', `<img src="${PNG}" alt="">\n`);

    const refused = removal(
      root,
      '--apply',
      '--allow-dirty',
      '--expect-plan',
      String(planned.planHash),
    );

    expect(refused.status).toBe(3);
    const answer = result(refused.stdout);
    expect(answer).toMatchObject({ reason: 'PLAN_CHANGED' });
    expect(String(answer.message)).toContain('nothing was written: it now removes 0 originals.');
    expect(existsSync(join(root, PNG))).toBe(true);
  }, 120_000);

  it('removes it in one commit with --commit, once the arrival and its page are committed', () => {
    const root = arrived();
    write(root, 'page.html', `<img src="${WEBP}" alt="">\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'the arrival and its page');

    const applied = removal(root, '--apply', '--commit');

    expect(applied.status, applied.stderr).toBe(0);
    const commit = String(result(applied.stdout).commit);
    expect(git(root, 'show', '--name-status', '--format=%s', commit).trim().split('\n')).toEqual([
      'Remove originals kept beside their converted images, with Upfly',
      '',
      `D\t${PNG}`,
    ]);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, 120_000);

  it('says so when a path named is not an image in the project, and removes nothing', () => {
    const root = arrived();
    write(root, 'page.html', `<img src="${WEBP}" alt="">\n`);
    const before = snapshot(root, NOT_THE_PROJECT);

    const applied = upfly([
      'optimize',
      root,
      '--public',
      '.',
      '--remove-originals',
      '--image',
      join(root, 'images/nothing-here.png'),
      '--apply',
      '--allow-dirty',
      '--json',
    ]);

    expect(applied.status, applied.stderr).toBe(0);
    const answer = result(applied.stdout);
    expect(answer.only).toEqual({ images: [], unmatched: ['images/nothing-here.png'] });
    expect(answer.notes).toContain(
      '--image images/nothing-here.png is not an image in the project, so nothing was removed for it.',
    );
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 120_000);

  it('prints the plan in words: what goes, what stays and why', () => {
    const root = arrived();
    write(root, 'page.html', `<img src="${WEBP}" alt="">\n`);

    const plan = upfly([
      'optimize',
      root,
      '--public',
      '.',
      '--remove-originals',
      '--image',
      join(root, PNG),
      '--image',
      join(root, 'images/logo.png'),
    ]);

    expect(plan.status, plan.stderr).toBe(0);
    const words = plan.stdout.replace(/\s+/g, ' ');
    expect(words).toContain('Remove 1 original');
    expect(words).toContain('Keep 1 original, for the reason below');
    expect(words).toContain(
      'images/logo.png: no images/logo.webp stands beside it, so nothing has replaced it',
    );
    expect(words).toContain('With --apply, npx upfly optimize would remove 1 original');
  }, 120_000);
});
