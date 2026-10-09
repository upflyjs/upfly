import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_ENCODES, parseCommandLine } from './args.js';

describe('parseCommandLine', () => {
  it('runs an audit of the current directory with the measured defaults', () => {
    expect(parseCommandLine(['audit'])).toEqual({
      kind: 'run',
      options: {
        command: 'audit',
        dir: '.',
        json: false,
        noColor: false,
        probe: true,
        maxEncodes: DEFAULT_MAX_ENCODES,
        full: false,
        show: null,
        includeDiscarded: false,
        includeUnusedSvg: false,
        publicDirs: null,
        exclude: [],
      },
    });
  });

  it('reads every audit flag', () => {
    const parsed = parseCommandLine([
      'audit',
      'site',
      '--json',
      '--no-color',
      '--max-encodes',
      '12',
      '--include-discarded',
      '--include-unused-svg',
      '--public',
      '.',
      '--public',
      'apps/web/public/',
      '--exclude',
      'legacy/',
    ]);
    expect(parsed).toEqual({
      kind: 'run',
      options: {
        command: 'audit',
        dir: 'site',
        json: true,
        noColor: true,
        probe: true,
        maxEncodes: 12,
        full: false,
        show: null,
        includeDiscarded: true,
        includeUnusedSvg: true,
        publicDirs: ['', 'apps/web/public'],
        exclude: ['legacy/'],
      },
    });
  });

  it('lifts the cap with --probe-all and skips probing with --no-probe', () => {
    expect(parseCommandLine(['audit', '--probe-all'])).toMatchObject({
      options: { maxEncodes: null },
    });
    expect(parseCommandLine(['audit', '--no-probe'])).toMatchObject({ options: { probe: false } });
  });

  it('plans an optimize of the current directory without writing, by default', () => {
    expect(parseCommandLine(['optimize'])).toEqual({
      kind: 'run',
      options: {
        command: 'optimize',
        dir: '.',
        json: false,
        noColor: false,
        show: null,
        apply: false,
        commit: false,
        policy: null,
        format: null,
        allowDirty: false,
        full: false,
        includeDeclined: false,
        includeDiscarded: false,
        includeUnusedSvg: false,
        only: null,
        publicDirs: null,
        exclude: [],
      },
    });
  });

  it('reads every optimize flag', () => {
    expect(
      parseCommandLine([
        'optimize',
        'site',
        '--apply',
        '--commit',
        '--replace',
        '--format',
        'avif',
        '--public',
        'public',
        '--exclude',
        'drafts/',
        '--include-declined',
        '--include-discarded',
        '--include-unused-svg',
        '--only',
        'images/logo.png',
        '--only',
        '*.jpg',
        '--json',
        '--no-color',
      ]),
    ).toEqual({
      kind: 'run',
      options: {
        command: 'optimize',
        dir: 'site',
        json: true,
        noColor: true,
        show: null,
        apply: true,
        commit: true,
        policy: 'replace',
        format: 'avif',
        allowDirty: false,
        full: false,
        includeDeclined: true,
        includeDiscarded: true,
        includeUnusedSvg: true,
        only: ['images/logo.png', '*.jpg'],
        publicDirs: ['public'],
        exclude: ['drafts/'],
      },
    });
    expect(parseCommandLine(['optimize', '--apply', '--allow-dirty'])).toMatchObject({
      options: { apply: true, allowDirty: true },
    });
  });

  it('keeps originals with --keep-originals, and reads --dry-run as the preview it already is', () => {
    expect(parseCommandLine(['optimize', '--keep-originals'])).toMatchObject({
      options: { policy: 'keep-original', apply: false },
    });
    expect(parseCommandLine(['optimize', '--dry-run'])).toMatchObject({
      options: { policy: null, apply: false },
    });
    expect(parseCommandLine(['dedupe', '--dry-run'])).toMatchObject({
      options: { command: 'dedupe', apply: false },
    });
  });

  it('reads a move as the path to move, where it goes, then the project', () => {
    expect(
      parseCommandLine(['move', 'public/a.png', 'public/img/a.png', 'site', '--apply', '--commit']),
    ).toEqual({
      kind: 'run',
      options: {
        command: 'move',
        from: 'public/a.png',
        to: 'public/img/a.png',
        dir: 'site',
        json: false,
        noColor: false,
        full: false,
        show: null,
        apply: true,
        commit: true,
        allowDirty: false,
        publicDirs: null,
        exclude: [],
      },
    });
  });

  it('reads what fails a check from --fail-on, repeated or split by commas, in one order', () => {
    const check = (argv: string[]) => {
      const parsed = parseCommandLine(argv);
      return parsed.kind === 'run' && parsed.options.command === 'check' ? parsed.options : null;
    };

    expect(check(['check'])).toMatchObject({ failOn: null, warn: false });
    expect(
      check(['check', '--fail-on', 'possibly-broken, broken', '--fail-on', 'broken']),
    ).toMatchObject({ failOn: ['broken', 'possibly-broken'], warn: false });
    expect(check(['check', 'site', '--warn'])).toMatchObject({
      dir: 'site',
      failOn: null,
      warn: true,
    });
  });

  it('runs an undo, which takes only a directory and the output flags', () => {
    expect(parseCommandLine(['undo', 'site', '--json'])).toEqual({
      kind: 'run',
      options: { command: 'undo', dir: 'site', json: true, noColor: false },
    });
  });

  it('has no mcp command: the MCP server is the upfly-mcp package', () => {
    for (const argv of [['mcp'], ['mcp', 'site'], ['mcp', '--help']]) {
      expect(parseCommandLine(argv)).toEqual({
        kind: 'usage-error',
        command: null,
        message: 'unknown command `mcp`',
      });
    }
  });

  it.each([
    [['audit', '--probe-all', '--no-probe'], '--no-probe and --probe-all cannot be used together'],
    [
      ['audit', '--probe-all', '--no-probe', '--max-encodes', '5'],
      '--no-probe, --max-encodes and --probe-all cannot be used together',
    ],
    [['audit', '--max-encodes', 'ten'], '--max-encodes takes a whole number of images, got `ten`'],
    [['audit', '--max-encodes=-1'], '--max-encodes takes a whole number of images, got `-1`'],
    [
      ['audit', '--max-encodes', '-1'],
      '`--max-encodes` needs a value; one that starts with a dash is written `--max-encodes=<value>`',
    ],
    [['audit', '--nope'], 'unknown option `--nope`'],
    [['audit', 'a', 'b'], 'expected one directory, got 2: a b'],
    [
      ['audit', '--public', '../site'],
      '--public takes a folder inside the project, such as `public`, or `.` for the project root; got `../site`',
    ],
    [['audity'], 'unknown command `audity`'],
    [['--json'], '--json needs a command before it, such as `npx upfly audit --json`'],
    [['optimize', '--commit'], '--commit commits what --apply writes; add --apply'],
    [['optimize', '--allow-dirty'], '--allow-dirty only changes what --apply does; add --apply'],
    [
      ['optimize', '--apply', '--commit', '--allow-dirty'],
      '--commit and --allow-dirty cannot be used together: the commit must hold only what this run wrote, so --commit needs a folder with no uncommitted changes',
    ],
    [['optimize', '--format', 'png'], '--format takes webp or avif, got `png`'],
    [
      ['optimize', '--replace', '--keep-originals'],
      '--replace and --keep-originals cannot be used together: --replace removes each original once its references have moved, which is the default, and --keep-originals keeps them',
    ],
    [
      ['optimize', '--dry-run', '--apply'],
      '--dry-run and --apply cannot be used together: --dry-run shows the plan and changes nothing, and --apply writes it',
    ],
    [
      ['dedupe', '--apply', '--dry-run'],
      '--dry-run and --apply cannot be used together: --dry-run shows the plan and changes nothing, and --apply writes it',
    ],
    [['audit', '--dry-run'], 'unknown option `--dry-run`'],
    [
      ['audit', '--show', 'images'],
      '--show takes one of references, savings, broken, unused, oversized, copies or skipped, got `images`',
    ],
    [
      ['optimize', '--show', 'leave', '--json'],
      '--show and --json cannot be used together: --show prints one row of the summary as text, and --json prints JSON instead',
    ],
    [
      ['dedupe', '--show', 'sets', '--full'],
      '--show and --full cannot be used together: --show prints one row of the full text, and --full prints all of it',
    ],
    [['check', '--show', 'broken'], 'unknown option `--show`'],
    [['dedupe', '--keep-originals'], 'unknown option `--keep-originals`'],
    [['optimize', '--max-encodes', '5'], 'unknown option `--max-encodes`'],
    [['optimize', 'a', 'b'], 'expected one directory, got 2: a b'],
    [
      ['optimize', '--full', '--json'],
      '--full and --json cannot be used together: --full prints the full text, and --json prints JSON instead',
    ],
    [['check', '--full'], 'unknown option `--full`'],
    [
      ['check', '--fail-on', 'broken,unused'],
      '--fail-on takes broken, too-large or possibly-broken, separated by commas; got `unused`, and an unused image never fails the check',
    ],
    [
      ['check', '--fail-on', 'size'],
      '--fail-on takes broken, too-large or possibly-broken, separated by commas; got `size`',
    ],
    [
      ['check', '--fail-on', ' , '],
      '--fail-on needs at least one of broken, too-large and possibly-broken; --warn makes nothing fail',
    ],
    [
      ['check', '--warn', '--fail-on', 'broken'],
      '--warn and --fail-on cannot be used together: --warn makes nothing fail',
    ],
    [
      ['move', 'a.png'],
      'move needs the image or folder to move and where it goes, such as `npx upfly move public/hero.png public/img/hero.png`',
    ],
    [['move', 'a.png', 'b.png', 'site', 'extra'], 'expected one directory, got 2: site extra'],
    [['move', 'a.png', 'b.png', '--commit'], '--commit commits what --apply writes; add --apply'],
    [
      ['move', 'a.png', 'b.png', '--show', 'sets'],
      '--show takes one of move, update, leave, unfollowed or refused, got `sets`',
    ],
    [['move', 'a.png', 'b.png', '--keep', 'a.png'], 'unknown option `--keep`'],
    [['undo', '--apply'], 'unknown option `--apply`'],
    [['undo', 'a', 'b'], 'expected one directory, got 2: a b'],
  ])('rejects %j as a usage error', (argv, message) => {
    expect(parseCommandLine(argv)).toEqual(
      expect.objectContaining({ kind: 'usage-error', message }),
    );
  });

  it('answers help and version before anything else', () => {
    expect(parseCommandLine([])).toEqual({ kind: 'help', command: null });
    expect(parseCommandLine(['--help'])).toEqual({ kind: 'help', command: null });
    expect(parseCommandLine(['audit', '--help'])).toEqual({ kind: 'help', command: 'audit' });
    expect(parseCommandLine(['optimize', '-h'])).toEqual({ kind: 'help', command: 'optimize' });
    expect(parseCommandLine(['undo', '--help'])).toEqual({ kind: 'help', command: 'undo' });
    expect(parseCommandLine(['--version'])).toEqual({ kind: 'version' });
  });
});
