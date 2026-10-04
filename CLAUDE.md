# Upfly

Instructions for an AI coding assistant working in this repository. A person contributing should start with
[CONTRIBUTING.md](CONTRIBUTING.md); everything here is in it or follows from it.

Upfly builds a graph of every image in a repository and every place its files refer to one, then optimizes the images
and rewrites the references in one transaction that can be undone. Converting an image is the easy part; knowing where
it is referenced is the product. [ARCHITECTURE.md](ARCHITECTURE.md) describes the design and is kept true.

## The rules

**Quality**
- TypeScript `strict`, no `any` in the public API. Exported types are the API and are documented.
- ES modules only, Node.js 22.18 or later (on Node.js 24, 24.11 or later): the range `@babel/parser` 8 declares.
- Every module has tests and every adapter has fixtures. **Every bug fix adds the test that would have failed.** The
  coverage floor is 90% on `upfly-core`, enforced in CI.
- Biome for lint and format. Conventional commits whose body carries the reasoning. One concern per pull request.
- CI runs Ubuntu, Windows and macOS on Node.js 22 and 24. **Windows is a first-class target.**
- The public JSON schemas (the report, the manifest, the config) are versioned and snapshot-tested.
- `ARCHITECTURE.md` is brought current as the design changes, in the same change.

**Safety**
- A dry run by default: nothing writes without `--apply`. **An `unsafe` reference is never rewritten.**
- **A silent skip is a bug.** Every declined item reaches the report with its reason.
- No network calls and no telemetry, in the library and the CLI alike.
- Deterministic output: the same inputs give a byte-identical report. Sort on POSIX-relative paths, never on native
  absolute ones: `/` (0x2F) and `\` (0x5C) fall either side of the alphanumerics.

**Correctness**
- **Never a regular expression over JavaScript.** Real parsers: `@babel/parser` for JavaScript and TypeScript, `parse5`
  for HTML, `postcss` for CSS. A regular expression is acceptable for Markdown only, and Markdown's raw HTML goes to
  the HTML adapter.
- **When a path cannot be proved, say so; never guess.** A false `broken` or a false "unused" costs more than a missed
  saving, so a path Upfly cannot resolve widens the "cannot be sure" findings instead.
- Performance claims are only ever numbers `bench/` produces in CI.

**Tests and comments**
- Tests are typechecked: `tsconfig.test.json` covers every test file and runs in `pnpm typecheck`.
- Comments are written for a stranger. Comment the why, only where the code cannot say it, and document every public
  export in one plain sentence, with `@param`, `@returns`, `@throws` and `@example` where they help. Nothing a stranger
  cannot look up: no issue numbers or internal names; where a fact came from belongs in the commit message. Plain text:
  no bold, italics, emoji or em dashes. A comment over about ten lines is a design note for `ARCHITECTURE.md`. Text a
  user reads (report reasons, messages, CLI output) never carries an internal reference. `pnpm comments:check` runs
  inside `pnpm check` and fails on any finding in each package's `src` and `test`, `bench/src`,
  `accuracy-suite/tools`, `tools` and the source files at the repository's root; each package's `AGENTS.md`, `skill/`
  and `schema/` are held to the rules for output text.

## The gate

`pnpm check` runs lint, the comment check, typecheck and every test: it is what CI runs, and `pnpm test` alone is not
the gate. The accuracy suite is `pnpm accuracy:measure`, both runs; a change to how references are read or resolved
keys its suite entries first and watches them fail.

## Traps that have cost time here

- **Never generate a test project into a `public/` folder inside a workspace where the Upfly 2 VS Code extension
  runs.** It converts the images in such a folder and deletes the originals, and once destroyed 19 fixture files this
  way. Write generated projects outside the workspace, or put an `upfly.config.json` kill switch in the generated
  root (`fixtures/upfly.config.json` is the working example).
- **Code coverage is only meaningful on Linux.** Four `discover` tests need POSIX permission bits and are skipped on
  Windows, so `upfly-core` reads about 88% there against about 99% on Linux. Not a regression.
- **A green `fixtures.test.ts` says nothing about whether fixture references resolve.** Adapters never touch the disk
  by design, so a reference to a missing file looks the same as a good one at that layer; `fixture-integrity.test.ts`
  is the assertion that can see it.
- **Biome deliberately does not format `fixtures/`.** A tidied fixture stops standing in for what a person wrote.
