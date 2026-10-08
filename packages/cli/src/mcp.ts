/**
 * `upfly mcp`: serves the commands to an MCP client, such as Claude Desktop or Antigravity, over
 * standard input and output. Each tool runs the command of its name as `upfly <command> --json`
 * does, in a process of its own whose working folder is the project, and answers with the line
 * that command prints last: its result, or its refusal with the reason. So a tool keeps every
 * rule its command keeps, and a run that crashes ends its own process rather than the server.
 *
 * Only `upfly mcp` imports this module, so no other command loads the MCP library.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { type CallToolResult, McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
import type { CommandName, McpOptions } from './args.js';
import { isDirectory } from './audit.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { type Io, stopWith } from './output.js';
import { version } from './version.js';

/** The CLI's own entry point, which every tool runs. */
const BIN = fileURLToPath(new URL('./bin.js', import.meta.url));

/** What a client is told about the tools when it connects. */
const INSTRUCTIONS =
  'Upfly finds the images in a project and the references to them in the files it can read, and names the files it could not read. Before changing an image, call refs and read both of its lists. optimize, dedupe and move write nothing unless apply is true: call them without it first, show the user the plan, and set apply only with their yes. Each answer is the JSON line the command prints with --json; an answer of type error carries a reason to branch on.';

const READS = { readOnlyHint: true, openWorldHint: false };
const WRITES = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const dir = z
  .string()
  .optional()
  .describe(
    "The project's folder, absolute or relative to the folder upfly mcp serves, which it is when left out. The other paths of a call are read from it.",
  );
const servedFrom = z
  .array(z.string())
  .optional()
  .describe(
    'Folders the site is served from, such as public, or . for the project root (--public). Worked out when left out.',
  );
const exclude = z
  .array(z.string())
  .optional()
  .describe('Paths to leave out, in .gitignore syntax (--exclude).');
const apply = z
  .boolean()
  .optional()
  .describe('Write the plan (--apply). Without it nothing is written, and the plan is the answer.');
const commit = z
  .boolean()
  .optional()
  .describe('Commit exactly the files the run writes, as one commit (--commit). Needs apply.');
const includeDiscarded = z
  .boolean()
  .optional()
  .describe('Also list the path-like strings that linked nothing (--include-discarded).');
const includeUnusedSvg = z
  .boolean()
  .optional()
  .describe(
    'Also list the unused SVG files, which are otherwise only counted (--include-unused-svg).',
  );

/**
 * Serves the tools over standard input and output until the client closes the connection.
 *
 * @param options the parsed command line: the folder a tool reads when a call names none
 * @param io where a usage error is written; the connection itself uses the process's streams
 * @returns 0 once the client has closed the connection; 2 when the folder does not exist
 */
export async function runMcp(options: McpOptions, io: Io): Promise<ExitCode> {
  const folder = resolve(options.dir);
  if (!isDirectory(folder)) {
    return stopWith(io, options, EXIT_CODES.USAGE, `${options.dir} is not a directory`);
  }
  const closed = finished(process.stdin).catch(() => undefined);
  serveStdio(() => serverFor(folder));
  await closed;
  return EXIT_CODES.OK;
}

/** The server one connection is given, each tool one command. */
function serverFor(folder: string): McpServer {
  const server = new McpServer(
    { name: 'upfly', version: version() },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'audit',
    {
      title: 'Audit the images',
      description:
        'Reports the images in the project, the references to them, the references that name no file, the images nothing references, and what optimize would convert and save. Changes no file. Answers with what `upfly audit --json` prints last.',
      inputSchema: z.strictObject({
        dir,
        public: servedFrom,
        exclude,
        probe: z
          .boolean()
          .optional()
          .describe('false reads no image, so sizes and savings are not measured (--no-probe).'),
        maxEncodes: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Measure the n largest images optimize could convert, 100 when left out (--max-encodes).',
          ),
        probeAll: z
          .boolean()
          .optional()
          .describe('Measure every image optimize could convert (--probe-all).'),
        includeDiscarded,
        includeUnusedSvg,
      }),
      annotations: READS,
    },
    (args, ctx) =>
      run(folder, 'audit', args.dir, ctx, [
        ...scopeFlags(args),
        ...flag(args.probe === false, '--no-probe'),
        ...(args.maxEncodes === undefined ? [] : [`--max-encodes=${args.maxEncodes}`]),
        ...flag(args.probeAll, '--probe-all'),
        ...flag(args.includeDiscarded, '--include-discarded'),
        ...flag(args.includeUnusedSvg, '--include-unused-svg'),
      ]),
  );

  server.registerTool(
    'check',
    {
      title: 'Check the references',
      description:
        'Fails, with exitCode 1 and passed false, when a reference names an image that does not exist, or on what the config or failOn names. Changes no file. Answers with what `upfly check --json` prints last.',
      inputSchema: z.strictObject({
        dir,
        public: servedFrom,
        exclude,
        changed: z
          .string()
          .optional()
          .describe(
            'Keep only what a change could have caused: the git ref it is measured from, such as origin/main, or an empty string for the uncommitted changes (--changed).',
          ),
        failOn: z
          .array(z.enum(['broken', 'too-large', 'possibly-broken']))
          .optional()
          .describe('What fails the check, over the config (--fail-on).'),
        warn: z
          .boolean()
          .optional()
          .describe('List everything, and pass whatever is found (--warn).'),
      }),
      annotations: READS,
    },
    (args, ctx) =>
      run(folder, 'check', args.dir, ctx, [
        ...scopeFlags(args),
        ...(args.changed === undefined ? [] : [`--changed=${args.changed}`]),
        ...(args.failOn === undefined ? [] : [`--fail-on=${args.failOn.join(',')}`]),
        ...flag(args.warn, '--warn'),
      ]),
  );

  server.registerTool(
    'refs',
    {
      title: 'Every line that names an image',
      description:
        'Lists every line that names one image: the references, whether Upfly could rewrite each, the lines it does not follow and why, and what optimize would do with the image. Changes no file. Answers with what `upfly refs <image> --json` prints last.',
      inputSchema: z.strictObject({
        image: z.string().describe("The image's path, read from the project's folder."),
        dir,
        public: servedFrom,
        exclude,
      }),
      annotations: READS,
    },
    (args, ctx) => run(folder, 'refs', args.dir, ctx, scopeFlags(args), [args.image]),
  );

  server.registerTool(
    'optimize',
    {
      title: 'Convert images and rewrite their references',
      description:
        'Converts each image that measures smaller as WebP or AVIF, rewrites the references Upfly can rewrite safely, and removes each original once nothing it reads still names it. Writes only when apply is true; without it, the answer is the plan. With apply it refuses, writing nothing, over uncommitted changes, after an earlier run that stopped part way, and during a merge or a rebase. Answers with what `upfly optimize --json` prints last.',
      inputSchema: z.strictObject({
        dir,
        public: servedFrom,
        exclude,
        apply,
        commit,
        keepOriginals: z
          .boolean()
          .optional()
          .describe('Keep each original beside its converted file (--keep-originals).'),
        replace: z
          .boolean()
          .optional()
          .describe(
            'Remove each original once its references have moved, over a config that keeps them (--replace).',
          ),
        format: z
          .enum(['webp', 'avif'])
          .optional()
          .describe('The format to convert to (--format).'),
        only: z
          .array(z.string())
          .optional()
          .describe('Convert only the images these patterns match, in .gitignore syntax (--only).'),
        includeDeclined: z
          .boolean()
          .optional()
          .describe('List each image examined and not converted (--include-declined).'),
        includeDiscarded,
        includeUnusedSvg,
      }),
      annotations: WRITES,
    },
    (args, ctx) =>
      run(folder, 'optimize', args.dir, ctx, [
        ...scopeFlags(args),
        ...flag(args.apply, '--apply'),
        ...flag(args.commit, '--commit'),
        ...flag(args.keepOriginals, '--keep-originals'),
        ...flag(args.replace, '--replace'),
        ...(args.format === undefined ? [] : [`--format=${args.format}`]),
        ...each('--only', args.only),
        ...flag(args.includeDeclined, '--include-declined'),
        ...flag(args.includeDiscarded, '--include-discarded'),
        ...flag(args.includeUnusedSvg, '--include-unused-svg'),
      ]),
  );

  server.registerTool(
    'dedupe',
    {
      title: 'Keep one copy of each duplicated image',
      description:
        'Finds sets of images with the same bytes and points every reference at one copy of each; deletes nothing. Writes only when apply is true; without it, the answer is the plan. With apply it refuses, writing nothing, over uncommitted changes, after an earlier run that stopped part way, and during a merge or a rebase. Answers with what `upfly dedupe --json` prints last.',
      inputSchema: z.strictObject({
        dir,
        public: servedFrom,
        exclude,
        apply,
        commit,
        keep: z
          .array(z.string())
          .optional()
          .describe('The copy to keep, as a path in the project, for each set it is in (--keep).'),
      }),
      annotations: WRITES,
    },
    (args, ctx) =>
      run(folder, 'dedupe', args.dir, ctx, [
        ...scopeFlags(args),
        ...flag(args.apply, '--apply'),
        ...flag(args.commit, '--commit'),
        ...each('--keep', args.keep),
      ]),
  );

  server.registerTool(
    'move',
    {
      title: 'Move an image or a folder of images',
      description:
        'Moves an image, or the images in a folder, rewrites the references Upfly can rewrite, and lists every other line that still names the old path; deletes nothing. Writes only when apply is true; without it, the answer is the plan. With apply it refuses, writing nothing, over uncommitted changes, after an earlier run that stopped part way, and during a merge or a rebase. Answers with what `upfly move <from> <to> --json` prints last.',
      inputSchema: z.strictObject({
        from: z.string().describe('The image or folder to move, read from the project folder.'),
        to: z
          .string()
          .describe(
            'Where it goes, read from the project folder; a folder, or a path ending in a slash, takes it in.',
          ),
        dir,
        public: servedFrom,
        exclude,
        apply,
        commit,
      }),
      annotations: WRITES,
    },
    (args, ctx) =>
      run(
        folder,
        'move',
        args.dir,
        ctx,
        [...scopeFlags(args), ...flag(args.apply, '--apply'), ...flag(args.commit, '--commit')],
        [args.from, args.to],
      ),
  );

  server.registerTool(
    'undo',
    {
      title: 'Undo the last run',
      description:
        'Puts back every file the last optimize, dedupe or move with apply changed, after checking each, and changes nothing if one was edited since. Writes, so a call sets apply to true. Answers with what `upfly undo --json` prints last.',
      inputSchema: z.strictObject({
        dir,
        apply: z.literal(true).describe('Must be true: undo writes.'),
      }),
      annotations: WRITES,
    },
    (args, ctx) => run(folder, 'undo', args.dir, ctx, []),
  );

  return server;
}

/** `--public` and `--exclude`, once for each value given. */
function scopeFlags(args: {
  readonly public?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
}): string[] {
  return [...each('--public', args.public), ...each('--exclude', args.exclude)];
}

/** `--name=value` for each value, so that a value starting with a dash is still a value. */
function each(name: string, values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => `${name}=${value}`);
}

function flag(set: boolean | undefined, name: string): string[] {
  return set === true ? [name] : [];
}

/**
 * Runs `upfly <command> --json` in the project's folder and answers with the line it printed
 * last, a result or an error. Each progress line goes to a client that asked for progress, and
 * a call the client cancels ends the command's process.
 *
 * @param folder the folder the server was started for, from which `dir` is read
 * @param positionals the command's own arguments, such as the image `refs` answers for
 */
async function run(
  folder: string,
  command: CommandName,
  dir: string | undefined,
  ctx: ServerContext,
  flags: readonly string[],
  positionals: readonly string[] = [],
): Promise<CallToolResult> {
  const project = resolve(folder, dir ?? '.');
  // A folder that is not there is handed to the command, which says so in its own words.
  const found = isDirectory(project);
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      BIN,
      command,
      ...flags,
      '--json',
      '--',
      ...positionals,
      ...(found ? [] : [project]),
    ],
    {
      cwd: found ? project : folder,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: ctx.mcpReq.signal,
      windowsHide: true,
    },
  );

  const token = ctx.mcpReq._meta?.progressToken;
  let answer: string | null = null;
  let progress = 0;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const type = typeOf(line);
    if (type === 'result' || type === 'error') answer = line;
    if (type !== 'progress' || token === undefined) return;
    progress += 1;
    ctx.mcpReq
      .notify({
        method: 'notifications/progress',
        params: { progressToken: token, progress, message: stageOf(line) },
      })
      .catch(() => undefined);
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });

  const ended = await new Promise<{ readonly code: number | null; readonly error?: Error }>(
    (done) => {
      child.once('error', (error) => done({ code: null, error }));
      child.once('close', (code) => done({ code }));
    },
  );
  if (answer !== null && ended.error === undefined) {
    const line: string = answer;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return {
      content: [{ type: 'text', text: line }],
      structuredContent: parsed,
      isError: parsed.type === 'error',
    };
  }
  const why = ended.error?.message ?? stderr.trim().split('\n').at(-1) ?? `exit code ${ended.code}`;
  return {
    content: [{ type: 'text', text: `upfly ${command} ended without an answer: ${why}` }],
    isError: true,
  };
}

/** A JSON line's `type`, or null for a line that is not JSON. */
function typeOf(line: string): unknown {
  try {
    return (JSON.parse(line) as { readonly type?: unknown }).type ?? null;
  } catch {
    return null;
  }
}

/** A progress line's stage, such as `measuring`. */
function stageOf(line: string): string {
  return String((JSON.parse(line) as { readonly stage?: unknown }).stage);
}
