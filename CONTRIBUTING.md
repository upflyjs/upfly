# Contributing

Thanks for looking. This project is small and I read everything: you will get a first reply
from me within three days.

## Before you write code

**Open an issue first** for anything beyond a typo or an obvious one-line bug. It is much
cheaper to disagree about an approach in an issue than in a 400-line diff, and it means your
time is not spent on something that will not be merged. The issue forms ask for what a
report needs: a bug with the smallest project that shows it, a file type you want read, or a
wrong result, such as an image called unused that a page uses.

A straightforward bug fix with a failing test can go straight to a pull request.

## Setup

Node.js 22.18 or later (on Node.js 24, 24.11 or later), and pnpm.

```bash
pnpm install
pnpm check        # what CI runs, on Linux, macOS and Windows
pnpm test:watch   # while developing
```

`pnpm check` runs, in order:

1. `pnpm lint`: Biome, for lint and formatting (`pnpm lint:fix` fixes most of it).
2. `pnpm comments:check`: the comment standard below, on every source file.
3. `pnpm typecheck`: the whole build and every test file, TypeScript strict.
4. `pnpm test`: every test.

If it passes on your machine it passes in CI. The accuracy suite runs in CI too:
`pnpm accuracy:measure` builds the engine and runs it twice over `accuracy-suite/tree/`, and
exits non-zero on any reference that does not get the answer written down for it.

## How a change is made: the test first

- **A bug:** first the smallest input that shows it, as a test, and watch it fail. Then the
  fix. Then check that the fix covers the whole family, not only your example: if a
  percent-encoded path was lost, try an entity-encoded one too. Every bug fix adds the test
  that would have failed.
- **Something new:** its tests first, watched failing, then the code.
- A test name says the behaviour in words: `keeps the original when a pattern still builds
  its path`, not `fix #123`.

## The best first contribution: a reader for a file type

Upfly finds references by reading each file type with an adapter. Some file types have no
reader yet (Vue, Svelte, PHP, ERB, Liquid, Nunjucks, YAML frontmatter), and each has an open
issue labelled `good first issue`. The tests for each already exist: the accuracy suite holds
real files of that type, and every reference in them is written down with the answer a
correct engine gives. Today each is marked as a known gap. Adding a reader takes about half
an hour for the code, most of it reading one existing adapter:

1. **Read** "Adapters: the contribution surface" in [ARCHITECTURE.md](ARCHITECTURE.md), and
   the adapter closest to yours in `packages/core/src/adapters/`: `astro.ts` hands a
   component's script to the JavaScript reader and its markup to the HTML reader, which is
   the model for Vue and Svelte; `html.ts` is the model for a template language.
2. **Key the suite's entries first.** In `accuracy-suite/key/answer-key.json`, find the
   entries whose `shape` is your type's gap (for example `unread.vue`). Give each the shape
   your reader will emit for it, and remove its `knownGap`. Declare each new shape in the
   key's `shapes` list and in `SHAPES` (`packages/core/src/adapters/shapes.ts`); a test holds
   the two lists equal. Retire the gap shape once no entry uses it.
3. **Watch them fail:** `pnpm accuracy:measure` now reports each of those entries as missed.
4. **Build the reader** in `packages/core/src/adapters/`, with `defineAdapter`, a
   table-driven unit test beside it (input text in, references out, at exact offsets), and a
   small real fixture in `packages/core/fixtures/<type>/`. Register it in
   `default-adapters.ts`.
5. **Watch them pass:** `pnpm accuracy:measure` reports every entry met in both runs, and
   `pnpm check` is green.

The rules an adapter keeps, each learned from a bug: it never touches the filesystem, never
resolves a path (it reports the path as written), is pure, and reports the offsets of the
path text only. A real parser where one exists, never a regular expression over JavaScript.
When a path is built at run time, `unsafe` is the right answer; a guess is not.

## Comments

Write each comment for a stranger opening the file for the first time:

- Comment the why, and only where the code cannot say it: a reason, a trap, a consequence of
  something elsewhere.
- Document every exported function or type in one plain sentence, with `@param`, `@returns`
  and `@throws` where the types do not already say it.
- Nothing a stranger cannot look up: no issue numbers, no internal names. Where a fact came
  from belongs in the commit message.
- Plain text: no bold, emoji or em dashes. Most comments are one to three lines.
- Text a user reads (a report reason, an error, CLI output) is held to the same rules.

`pnpm comments:check` enforces the mechanical half.

## Pull requests

- **One concern per pull request.** A bug fix or a feature, not both. Aim for under 500
  lines and under 10 files: small ones get reviewed quickly.
- Link the issue: `Fixes #123`.
- Use conventional commits (`fix:`, `feat:`, `docs:`, `refactor:`, `test:`), and say why in
  the body.
- Run `pnpm changeset` if a user would notice the change, and describe it the way a user
  would experience it.

## Using AI

AI-assisted work is welcome; I use AI too. Three things I ask of you:

1. **The description is in your own words.** The pull request, the issue and the commit
   messages. A generated wall of text tells a reviewer nothing.
2. **You can discuss your diff:** why this approach, what the edge cases are, what the test
   proves, without going back to the tool.
3. **You reviewed the code before sending it.**

A pull request that reads as unreviewed generated code is closed. This is not hostility to
the tools: reviewing code nobody understands costs more than writing it.

## Reporting bugs

The most useful bug report holds the **smallest project that shows it**: a few files and the
command you ran, plus what you expected. If Upfly missed a reference or rewrote one it should
not have, that project becomes a permanent test, which is the most valuable thing you can
contribute.
