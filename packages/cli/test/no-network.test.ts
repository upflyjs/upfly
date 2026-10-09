/**
 * The README promises no network, ever. Each command a user runs is run here on a fixture
 * copy with every way Node offers to reach the network replaced by one that throws and
 * writes down the attempt: each must succeed with nothing written down. Git, which some
 * commands run for local work only, is its own program and outside the replacement's reach.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { NO_NETWORK, commitAll, copyFixture, git, tempFolder, upfly } from './helpers.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** What a script run with the replacement tried, one name per line, or '' for nothing. */
function attempted(script: string): string {
  const log = join(tempFolder(roots, 'upfly-net-control-'), 'attempts.log');
  spawnSync(process.execPath, ['--import', pathToFileURL(NO_NETWORK).href, '-e', script], {
    env: { ...process.env, UPFLY_NETWORK_LOG: log },
  });
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
}

describe('no command reaches the network', () => {
  it.each([
    ['net.connect', "require('node:net').connect(80, 'example.com')"],
    ['net.connect', "import('node:net').then(({ connect }) => connect(80, 'example.com'))"],
    ['tls.connect', "require('node:tls').connect(443, 'example.com')"],
    ['dns.lookup', "require('node:dns').lookup('example.com', () => {})"],
    ['dns.resolve', "require('node:dns').resolve('example.com', () => {})"],
    ['dns.promises.lookup', "require('node:dns').promises.lookup('example.com').catch(() => {})"],
    ['http.request', "require('node:http').request('http://example.com')"],
    ['https.request', "require('node:https').request('https://example.com')"],
    ['fetch', "fetch('https://example.com').catch(() => {})"],
  ])('the replacement catches %s when a script does call it', (api, script) => {
    expect(attempted(script)).toBe(`${api}\n`);
  });

  it('init, audit, optimize --apply --commit, undo, check, refs and dedupe', () => {
    const root = copyFixture('vite-react', tempFolder(roots, 'upfly-net-'));
    commitAll(root);
    const log = join(tempFolder(roots, 'upfly-net-log-'), 'attempts.log');
    const run = (...args: string[]) => {
      const result = upfly(args, { env: { UPFLY_NETWORK_LOG: log }, preload: NO_NETWORK });
      expect(result.status, `upfly ${args.join(' ')}: ${result.stderr}`).toBe(0);
      expect(existsSync(log), `upfly ${args.join(' ')} tried the network`).toBe(false);
      return result;
    };

    run('init', root);
    git(root, 'add', 'upfly.config.json');
    git(root, 'commit', '--quiet', '-m', 'the config init wrote');
    run('audit', root);
    expect(run('optimize', root, '--apply', '--commit').stdout).toMatch(
      /\n {2}Commit {7}[0-9a-f]{12},/,
    );
    expect(run('undo', root).stdout).toContain('Undid run');
    expect(run('check', root).stdout).toContain('Passed');
    run('refs', join(root, 'src/assets/logo.png'), root);
    run('dedupe', root);
  }, 120_000);
});
