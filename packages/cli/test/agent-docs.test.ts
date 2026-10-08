/**
 * What the documents written for coding agents say about the CLI, checked against the built
 * binary and the package: every command they name is one `upfly --help` lists, every flag is
 * one the help of the command it follows lists, every exit code is the code's own, and every
 * refusal name, schema file and JSON field they name exists. An agent follows these to the
 * letter, so a flag that was renamed would send it into a usage error.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CODES, REFUSAL_REASONS } from '../src/exit-codes.js';
import { upfly } from './helpers.js';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const DOCS = ['AGENTS.md', 'skill/upfly/SKILL.md'];
const COMMANDS = ['audit', 'optimize', 'undo', 'check', 'init', 'refs', 'dedupe', 'move', 'mcp'];
/** Words written in code style that are not in the JSON: folder names and HTML. */
const NOT_JSON = new Set(['public', 'node_modules']);

type Schema = { readonly [keyword: string]: unknown };

const schemas: Record<string, Schema> = Object.fromEntries(
  readdirSync(join(PACKAGE, 'schema')).map((file) => [
    file,
    JSON.parse(readFileSync(join(PACKAGE, 'schema', file), 'utf8')),
  ]),
);

const help = new Map<string, string>();
beforeAll(() => {
  help.set('', upfly(['--help']).stdout);
  for (const command of COMMANDS) help.set(command, upfly([command, '--help']).stdout);
});

/** Every code span in a Markdown text, fenced blocks included. */
function codeSpans(text: string): string[] {
  const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
  const inline = [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map(
    (match) => match[1] ?? '',
  );
  return [...fenced, ...inline];
}

function flagsIn(text: string): string[] {
  return [...text.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((match) => match[0]);
}

function helpLists(helpText: string, flag: string): boolean {
  return new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(helpText);
}

/** Each schema node a property path reaches from `node`, through references and branches. */
function reach(node: Schema, path: readonly string[], file: string): boolean {
  const resolved = follow(node, file);
  if (path.length === 0) return true;
  const branches = ['oneOf', 'anyOf', 'allOf'].flatMap(
    (keyword) => (resolved.node[keyword] as Schema[] | undefined) ?? [],
  );
  if (branches.some((branch) => reach(branch, path, resolved.file))) return true;
  const [head, ...rest] = path;
  const properties = resolved.node.properties as Record<string, Schema> | undefined;
  const next = head === undefined ? undefined : properties?.[head];
  return next !== undefined && reach(next, rest, resolved.file);
}

function follow(node: Schema, file: string): { node: Schema; file: string } {
  if (typeof node.$ref !== 'string') return { node, file };
  const [target, fragment = ''] = node.$ref.split('#');
  const into = target === '' || target === undefined ? file : target;
  let resolved = schemas[into] as Schema;
  for (const segment of fragment.split('/').filter((part) => part !== '')) {
    resolved = resolved[segment] as Schema;
  }
  return follow(resolved, into);
}

/** Every property name, enum value and constant string in the schemas. */
function schemaWords(): Set<string> {
  const words = new Set<string>();
  const visit = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
    } else if (typeof value === 'object' && value !== null) {
      for (const [name, child] of Object.entries(value)) {
        if (key === 'properties') words.add(name);
        visit(child, name);
      }
    } else if (typeof value === 'string' && (key === 'const' || key === 'enum')) {
      words.add(value);
    }
  };
  for (const schema of Object.values(schemas)) visit(schema);
  return words;
}

/** The text of every JavaScript file the two packages build, to find the names the code gives. */
function builtCode(): string {
  const texts: string[] = [];
  for (const dist of ['../core/dist', 'dist']) {
    const root = join(PACKAGE, dist);
    for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (entry.endsWith('.js')) texts.push(readFileSync(join(root, entry), 'utf8'));
    }
  }
  return texts.join('\n');
}

describe.each(DOCS)('%s says only what the built CLI does', (doc) => {
  const text = readFileSync(join(PACKAGE, doc), 'utf8');
  const spans = codeSpans(text);

  it('names only commands the CLI has', () => {
    const named = [...text.matchAll(/\bupfly ([a-z][\w-]*)/g)].map((match) => match[1] ?? '');
    expect(named.length).toBeGreaterThan(0);
    for (const command of named) {
      expect(COMMANDS, `upfly ${command}`).toContain(command);
      expect(help.get(''), command).toMatch(new RegExp(`^ {2}${command} `, 'm'));
    }
  });

  it('gives each command only flags its own help lists', () => {
    for (const line of text.split('\n')) {
      for (const match of line.matchAll(/\bupfly ([a-z][\w-]*)([^`]*)/g)) {
        const command = match[1] ?? '';
        for (const flag of flagsIn(match[2] ?? '')) {
          expect(helpLists(help.get(command) ?? '', flag), `upfly ${command} ${flag}`).toBe(true);
        }
      }
    }
    // Any flag in code, bar a command line of another program such as git.
    const everyHelp = [...help.values()].join('\n');
    for (const span of spans.filter((span) => !/^(?:git|npm|pnpm|node)\b/.test(span))) {
      for (const flag of flagsIn(span)) expect(helpLists(everyHelp, flag), flag).toBe(true);
    }
  });

  it('gives the exit codes the CLI returns, in full where it lists them', () => {
    const rows = [...text.matchAll(/\n\| (\d+) \|/g)].map((match) => Number(match[1]));
    if (doc === 'AGENTS.md' || rows.length > 0) expect(rows).toEqual(Object.values(EXIT_CODES));
    for (const match of text.matchAll(/\bexit(?:s| code) (\d+)/gi)) {
      expect(Object.values(EXIT_CODES) as number[], match[0]).toContain(Number(match[1]));
    }
  });

  it('names only refusals the code gives, and only schemas the package ships', () => {
    const code = builtCode();
    for (const reason of spans.filter((span) => /^[A-Z][A-Z0-9_]{3,}$/.test(span))) {
      expect(code.includes(`'${reason}'`), reason).toBe(true);
    }
    for (const file of spans.filter((span) => /^[a-z]+\.json$/.test(span))) {
      expect(Object.keys(schemas), file).toContain(file);
    }
  });

  it('points only at files the package ships', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
    for (const span of spans.filter((span) => span.startsWith('node_modules/upfly/'))) {
      const inside = span.slice('node_modules/upfly/'.length).replace(/[/]$/, '');
      expect(existsSync(join(PACKAGE, inside)), span).toBe(true);
      const top = inside.split('/')[0];
      expect(
        (manifest.files as string[]).some((entry) => entry.replace(/[/]$/, '') === top),
        `${span} is not in the package's files`,
      ).toBe(true);
    }
  });

  it('names only JSON fields and values the schemas describe', () => {
    for (const path of spans.filter((span) => /^[a-z]\w*(?:\.[a-z]\w*)+$/i.test(span))) {
      if (/\.(?:json|md|ts|js)$/.test(path)) continue;
      const parts = path.split('.');
      const found = Object.entries(schemas).some(([file, schema]) => reach(schema, parts, file));
      expect(found, path).toBe(true);
    }
    const words = schemaWords();
    for (const word of spans.filter((span) => /^[a-z][A-Za-z-]*$/.test(span))) {
      if (COMMANDS.includes(word) || NOT_JSON.has(word)) continue;
      expect(words.has(word), word).toBe(true);
    }
  });
});

describe('AGENTS.md', () => {
  it('says what to do for every reason an error line can give', () => {
    const text = readFileSync(join(PACKAGE, 'AGENTS.md'), 'utf8');
    const listed = [...text.matchAll(/^- `([A-Z][A-Z0-9_]+)`: \S/gm)].map((match) => match[1]);
    expect([...listed].sort()).toEqual([...REFUSAL_REASONS].sort());
  });
});

describe('the Agent Skill', () => {
  it('is named for its folder and describes when to use it, within the format limits', () => {
    const text = readFileSync(join(PACKAGE, 'skill', 'upfly', 'SKILL.md'), 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1] ?? '';
    const field = (key: string) => new RegExp(`^${key}: (.+)$`, 'm').exec(front)?.[1]?.trim();

    // Agent Skills: a name of lowercase letters, digits and hyphens, at most 64 characters,
    // and a description of at most 1,024.
    expect(field('name')).toBe('upfly');
    expect(field('name')).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(field('description')?.length ?? 0).toBeGreaterThan(0);
    expect(field('description')?.length ?? 0).toBeLessThanOrEqual(1024);
  });
});
