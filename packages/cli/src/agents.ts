/**
 * `upfly init --agents`: points a project's coding agents at Upfly. It writes one marked block
 * into the instruction files the agents read and puts the Agent Skill where they look for a
 * project's skills, all committed with the project. It writes only between its own markers, so
 * every other line of a file stays as it was, and a second run changes nothing. Which agent
 * reads which file is in "Pointing agents at Upfly" in ARCHITECTURE.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The line that opens Upfly's block in an instruction file. */
export const BLOCK_START = '<!-- upfly:start -->';
/** The line that closes it. */
export const BLOCK_END = '<!-- upfly:end -->';

const BLOCK_BODY = [
  '## Images',
  '',
  'Use Upfly for any task that moves, renames, converts, optimizes or deletes an image, or asks',
  'where one is used: it finds the references to an image and rewrites them with the file.',
  'Start with `npx upfly refs <image> --json` for one image, or `npx upfly audit --json` for the',
  'whole project, and follow the Upfly skill in `.agents/skills/upfly/SKILL.md`. Upfly changes',
  'no file without `--apply`.',
];

/** The Skill's two copies: most agents read `.agents/skills`, Claude Code and Cline `.claude/skills`. */
const SKILL_FILES = ['.agents/skills/upfly/SKILL.md', '.claude/skills/upfly/SKILL.md'];

/** What happened to one instruction file. */
export interface InstructionFile {
  /** Relative to the project. */
  readonly file: string;
  readonly action: 'created' | 'added' | 'updated' | 'unchanged' | 'skipped';
  /** Why a file was skipped. */
  readonly why?: string;
}

/** What happened to one copy of the Skill. */
export interface SkillFile {
  /** Relative to the project. */
  readonly file: string;
  readonly action: 'created' | 'updated' | 'unchanged';
}

/** Every file `--agents` looked at, and what it did with each. */
export interface AgentFiles {
  readonly instructions: readonly InstructionFile[];
  readonly skills: readonly SkillFile[];
}

/** What a run would write, or the file whose block has no end, which stops it. */
export type AgentPlan =
  | {
      readonly kind: 'ready';
      readonly files: AgentFiles;
      readonly writes: readonly { readonly path: string; readonly text: string }[];
    }
  | { readonly kind: 'unclosed'; readonly file: string };

/**
 * Works out every file `--agents` would write, reading only, so that a file it cannot change
 * safely stops the run before anything is written.
 *
 * @param root the project directory
 * @param skill the Skill's text, as the package ships it
 */
export function planAgentFiles(root: string, skill: string): AgentPlan {
  const instructions: InstructionFile[] = [];
  const writes: { path: string; text: string }[] = [];

  for (const file of instructionFiles(root)) {
    const before = read(root, file);
    if (before === null) {
      instructions.push({ file, action: 'created' });
      writes.push({ path: file, text: `${block('\n')}\n` });
      continue;
    }
    if (file.endsWith('CLAUDE.md') && importsAgentsMd(before)) {
      instructions.push({
        file,
        action: 'skipped',
        why: 'it imports AGENTS.md, which holds the block',
      });
      continue;
    }
    const after = withBlock(before);
    if (after === null) return { kind: 'unclosed', file };
    const action = after.added ? 'added' : after.text === before ? 'unchanged' : 'updated';
    instructions.push({ file, action });
    if (action !== 'unchanged') writes.push({ path: file, text: after.text });
  }

  const skills = SKILL_FILES.map((file): SkillFile => {
    const before = read(root, file);
    const action = before === null ? 'created' : sameText(before, skill) ? 'unchanged' : 'updated';
    if (action !== 'unchanged') writes.push({ path: file, text: skill });
    return { file, action };
  });

  return { kind: 'ready', files: { instructions, skills }, writes };
}

/**
 * Writes what `planAgentFiles` planned, making folders as needed.
 *
 * @param root the project directory
 * @param plan a plan that is ready
 */
export function writeAgentFiles(root: string, plan: Extract<AgentPlan, { kind: 'ready' }>): void {
  for (const { path, text } of plan.writes) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** `AGENTS.md` always; a `CLAUDE.md` and a `GEMINI.md` only where the project has one. */
function instructionFiles(root: string): string[] {
  const claude = ['CLAUDE.md', '.claude/CLAUDE.md'].find((file) => existsSync(join(root, file)));
  return [
    'AGENTS.md',
    ...(claude === undefined ? [] : [claude]),
    ...(existsSync(join(root, 'GEMINI.md')) ? ['GEMINI.md'] : []),
  ];
}

/** The block, its lines joined as the file it goes into joins them. */
function block(eol: string): string {
  return [BLOCK_START, ...BLOCK_BODY, BLOCK_END].join(eol);
}

/**
 * The file's text with the current block: in place of the one between its markers, or added
 * at the end. `null` when a start marker has no end after it, since where that block ends is
 * then unknown.
 */
function withBlock(text: string): { readonly text: string; readonly added: boolean } | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const start = text.indexOf(BLOCK_START);
  if (start === -1) {
    const separated =
      text === '' ? '' : text.endsWith(eol) ? `${text}${eol}` : `${text}${eol}${eol}`;
    return { text: `${separated}${block(eol)}${eol}`, added: true };
  }
  const end = text.indexOf(BLOCK_END, start);
  if (end === -1) return null;
  return {
    text: `${text.slice(0, start)}${block(eol)}${text.slice(end + BLOCK_END.length)}`,
    added: false,
  };
}

/** Whether a `CLAUDE.md` pulls `AGENTS.md` in with an `@` import, so the block reaches it. */
function importsAgentsMd(text: string): boolean {
  return /^@(?:\.\/)?AGENTS\.md\s*$/m.test(text);
}

function sameText(a: string, b: string): boolean {
  return a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');
}

function read(root: string, file: string): string | null {
  const path = join(root, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
