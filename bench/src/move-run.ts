/**
 * Move a real repository's images and check the tree still resolves.
 *
 * `relocate`'s tests use fixtures, where the graph finds every reference because the
 * fixtures were written for it. A move acts on what the graph knows, so a reference the
 * graph misses becomes a broken reference the move caused, and only a repository nobody
 * wrote for this engine has those. So this counts broken references before and after the
 * move, and searches the text for old paths that survived. See "Moving an asset" in
 * ARCHITECTURE.md.
 *
 * Every run works on a copy: `relocateTree` refuses the pinned validation corpus, which
 * every measurement in this project is stated against.
 *
 * Usage: `pnpm --filter upfly-bench run move-run -- --repo=<name> [--keep]`
 */

import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import sharp from 'sharp';
import { type Move, checkMoveRegression, findSurvivingPaths } from 'upfly-core/internal';
import { filesAfterMove, relocateTree, runEngine } from './engine-run.js';
import { REPOS, VALIDATION_ROOT, refuseValidationCorpus } from './repos.js';

/**
 * Beside the corpus, outside the workspace: the v2 extension converts the images in any
 * `public/` folder there and deletes the originals.
 */
const RUN_ROOT = join(VALIDATION_ROOT, '..', 'upfly-move-runs');

/** Never copied: they are large, and nothing the engine reads lives in them. */
const SKIP = new Set(['.git', 'node_modules']);

async function copyRepository(name: string): Promise<string> {
  const source = join(VALIDATION_ROOT, name);
  await mkdir(RUN_ROOT, { recursive: true });
  const destination = await mkdtemp(join(RUN_ROOT, `${name}-`));

  await cp(source, destination, {
    recursive: true,
    filter: (entry) => !SKIP.has(entry.slice(entry.lastIndexOf(sep) + 1)),
  });

  // Belt and braces, as `corpus-run` does it: the destination is built from a constant
  // that cannot point inside the corpus, and this says so rather than trusting that.
  refuseValidationCorpus(destination);
  return destination;
}

async function removeTree(root: string): Promise<void> {
  // libvips holds a handle on every file it has read for the life of the process, which
  // on Windows makes them undeletable by that process. Dropping the cache releases them;
  // a longer retry would not.
  sharp.cache(false);
  try {
    await rm(root, { recursive: true, force: true });
  } catch (cause) {
    stdout.write(`  cleanup   left ${root} behind: ${(cause as Error).message}\n`);
  }
}

/**
 * The moves to try, chosen from what the repository actually contains.
 *
 * Derived from the tree rather than written down: a hardcoded path would go stale with the
 * pinned commit, and a missing one would print a clean `not-an-asset` refusal that looks
 * like a run.
 *
 * Two moves, of different assets, one for each outcome of the serving boundary check:
 *   1. one within its own world, which must proceed and repoint every reference
 *   2. one across the serving boundary, which must be refused as `crosses-serving-boundary`
 *
 * Moving one asset twice would be refused as `source-claimed-twice` instead, and would test
 * nothing about the boundary.
 */
function movesFor(assets: readonly string[], servingDirs: readonly string[]): Move[] {
  const served = (path: string) =>
    servingDirs.some((dir) => dir === '' || path === dir || path.startsWith(`${dir}/`));

  const inside = assets.find(served);
  const outside = assets.find((path) => !served(path));
  const moves: Move[] = [];

  // Within its own world: deeper into the directory it already sits in.
  const nearby = inside ?? outside;
  if (nearby !== undefined) moves.push({ from: nearby, to: deeper(nearby) });

  // Across the boundary, in whichever direction this repository makes available.
  const crossing = inside !== undefined && outside !== undefined ? outside : undefined;
  if (crossing !== undefined && inside !== undefined) {
    const target = servingDirs.find((dir) => dir !== '') ?? '';
    const name = crossing.slice(crossing.lastIndexOf('/') + 1);
    moves.push({ from: crossing, to: target === '' ? name : `${target}/upfly-crossed/${name}` });
  }

  return moves;
}

/** The same file, one directory deeper. A move that cannot change how it is referenced. */
function deeper(relative: string): string {
  const cut = relative.lastIndexOf('/');
  const directory = cut === -1 ? '' : relative.slice(0, cut);
  const name = relative.slice(cut + 1);
  return directory === '' ? `upfly-moved/${name}` : `${directory}/upfly-moved/${name}`;
}

async function run(name: string, keep: boolean): Promise<boolean> {
  stdout.write(`\n${name}\n`);
  const root = await copyRepository(name);
  stdout.write(`  copy      ${root}\n`);

  try {
    // Measured before anything is written, so "no new broken references" is a
    // comparison rather than a claim about a number nobody recorded.
    // No probes: this run reads the graph and the serving roots, never a measurement.
    const before = await runEngine(root, undefined, false);
    const linked = new Set(
      before.graph.references
        .filter((reference) => reference.resolution === 'resolved')
        .map((reference) => reference.resolvedPath),
    );
    const assets = before.graph.assets
      .filter((node) => linked.has(node.asset.path))
      .map((node) => node.asset.relative)
      .sort();

    const moves = movesFor(assets, before.servingRoots.dirs);
    if (moves.length === 0) {
      stdout.write('  skipped   no linked asset to move\n');
      return true;
    }
    for (const move of moves) stdout.write(`  move      ${move.from} -> ${move.to}\n`);

    const { plan, manifest } = await relocateTree(root, moves);

    stdout.write(
      // No noun after any count, so a count of 1 never reads `1 files`.
      `  plan      ${plan.moves.length} moved, ${plan.rewrites.length} rewritten, ${plan.refused.length} refused, ${plan.declined.length} declined\n`,
    );
    stdout.write(`  manifest  ${manifest?.state ?? 'none written'}\n`);
    for (const refusal of plan.refused) {
      stdout.write(`    refused ${refusal.code}: ${refusal.reason.slice(0, 120)}\n`);
    }
    for (const rewrite of plan.rewrites.slice(0, 5)) {
      stdout.write(`    ${rewrite.file}  ${rewrite.edits.length} edit(s)\n`);
    }
    if (plan.rewrites.length > 5) {
      stdout.write(`    ... and ${plan.rewrites.length - 5} more files\n`);
    }
    for (const entry of plan.declined.slice(0, 5)) {
      stdout.write(`    declined ${entry.path}: ${entry.reason.slice(0, 100)}\n`);
    }
    if (plan.declined.length > 5) {
      stdout.write(`    ... and ${plan.declined.length - 5} more declined\n`);
    }

    // The same engine over the tree it just wrote, so a reference broken now is one this
    // run broke. But the graph doing the counting missed whatever it missed, so
    // `checkMoveRegression` returns its limits with the count, and both are printed.
    const after = await runEngine(root, undefined, false);
    const check = checkMoveRegression({
      before: before.graph,
      after: after.graph,
      excludedRoots: after.discovery.excludedRoots,
    });
    // A blank line stays blank, so the output carries no trailing whitespace.
    for (const line of check.lines) stdout.write(line === '' ? '\n' : `  ${line}\n`);

    // The check that reads no graph: a text search for each moved asset's old path. Only
    // accepted moves are searched, since a refused move's asset is still at its old path.
    // The files come from the walk, scanned, unscanned and excluded alike, not from the graph.
    stdout.write('\n');
    const survived = await findSurvivingPaths({
      moves: plan.moves,
      files: await filesAfterMove(after.discovery),
      readFile: (relative) => readFile(join(root, relative), 'utf8'),
      servingDirs: after.servingRoots.dirs,
    });
    for (const line of survived.lines) stdout.write(line === '' ? '\n' : `  ${line}\n`);

    return !check.regressed;
  } catch (cause) {
    stdout.write(`  failed    ${(cause as Error).message}\n`);
    return false;
  } finally {
    if (keep) stdout.write(`  kept      ${root}\n`);
    else await removeTree(root);
  }
}

async function main(): Promise<void> {
  const flags = argv.slice(2);
  const only = flags.find((flag) => flag.startsWith('--repo='))?.slice('--repo='.length);
  const keep = flags.includes('--keep');

  const names = [...new Set(REPOS.map((repo) => repo.name))].filter(
    (name) => only === undefined || name === only,
  );
  if (names.length === 0) {
    stdout.write(`No repository named ${only}.\n`);
    exit(2);
  }

  stdout.write('\nrelocate, on real repositories. Every run works on a copy.\n');

  let ok = true;
  for (const name of names) ok = (await run(name, keep)) && ok;

  stdout.write(ok ? '\nno regression\n' : '\nregression\n');
  exit(ok ? 0 : 1);
}

await main();
