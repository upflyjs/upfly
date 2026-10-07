/**
 * The files a text search of a project reads, and the lines naming an image that Upfly does
 * not follow, over a project on disk. `optimize` searches before it removes an original, and
 * `refs` and `move` list every line that names an image.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listExcludedFiles } from './discover/discover.js';
import { isBinaryExtension } from './graph/unscanned.js';
import { extensionOf } from './paths.js';
import type { PipelineOutput } from './pipeline.js';
import type { Unsearchable } from './plan/old-path-search.js';
import {
  type FolderLinesInput,
  type UnfollowedLine,
  type UnfollowedResult,
  findUnfollowedLines,
  linesNamingFolders,
} from './plan/unfollowed.js';
import type { DiscoveryResult } from './types.js';

/** What a text search reads, from one walk. */
export interface SearchScope {
  /** Every file the walk found, read or not, and those `excluded` names, POSIX-relative. */
  readonly files: readonly string[];
  /** The files in `files` that the run's ignore rules excluded. */
  readonly excludedFiles: readonly string[];
  /** What could not be listed, so a line inside it cannot be ruled out. */
  readonly unread: readonly { readonly file: string; readonly reason: string }[];
}

/**
 * The files a search for references the graph missed reads: every file the walk found, not
 * only those holding a reference, since the search is for references the graph missed, and,
 * when asked, the files the run's ignore rules excluded, which a page can still be.
 *
 * @param discovery the walk
 * @param excluded whether to read past the run's exclusions, which limit what a run changes
 * and, for a search that decides a delete or a move, never what it reads
 */
export async function searchScope(
  discovery: DiscoveryResult,
  excluded: boolean,
): Promise<SearchScope> {
  const outside = excluded ? await listExcludedFiles(discovery) : { files: [], unread: [] };
  return {
    files: [
      ...[...discovery.sourceFiles, ...discovery.unscannedFiles].map((file) => file.relative),
      ...outside.files,
    ],
    excludedFiles: outside.files,
    // A directory the walk could not list reached no search.
    unread: discovery.skipped
      .filter((entry) => entry.reason === 'unreadable-directory')
      .map((entry) => ({ file: entry.relative, reason: entry.detail }))
      .concat(outside.unread),
  };
}

/**
 * Every line of the project that names one of the images and is not one of its references,
 * with why Upfly does not follow it. The search reads the files the run excluded too, and no
 * binary file, which holds no text a path could be written in.
 *
 * @param pipeline the project as `runPipeline` read it
 * @param images the images, POSIX-relative to the project
 * @returns the lines, and what the search could not read
 */
/**
 * Every line of the project that names one of the moved folders itself, over the same files
 * as `unfollowedLines`, less the lines a move already rewrites or lists.
 *
 * @param pipeline the project as `runPipeline` read it
 * @param folders the folders being moved, POSIX-relative to the project
 * @param covered the lines the move already lists, and where its edits sit
 */
export async function folderLines(
  pipeline: PipelineOutput,
  folders: readonly string[],
  covered: Pick<FolderLinesInput, 'listed' | 'rewritten'>,
): Promise<{
  readonly lines: readonly UnfollowedLine[];
  readonly unsearchable: readonly Unsearchable[];
}> {
  if (folders.length === 0) return { lines: [], unsearchable: [] };
  const scope = await searchScope(pipeline.discovery, true);
  const root = pipeline.graph.root;
  return await linesNamingFolders({
    folders,
    files: scope.files.filter((file) => !isBinaryExtension(extensionOf(file))),
    readFile: (relative) => readFile(join(root, relative), 'utf8'),
    servingRoots: pipeline.servingRoots,
    listed: covered.listed,
    rewritten: covered.rewritten,
  });
}

export async function unfollowedLines(
  pipeline: PipelineOutput,
  images: readonly string[],
): Promise<UnfollowedResult> {
  const scope = await searchScope(pipeline.discovery, true);
  const root = pipeline.graph.root;
  const result = await findUnfollowedLines({
    graph: pipeline.graph,
    images,
    files: scope.files.filter((file) => !isBinaryExtension(extensionOf(file))),
    excludedFiles: scope.excludedFiles,
    readFile: (relative) => readFile(join(root, relative), 'utf8'),
    servingRoots: pipeline.servingRoots,
    aliases: pipeline.aliases,
    excludedRoots: pipeline.discovery.excludedRoots,
  });
  return { ...result, unsearchable: [...scope.unread, ...result.unsearchable] };
}
