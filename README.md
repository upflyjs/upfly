> **Looking for the Express upload middleware?** That is Upfly 2: `npm i upfly@2`. Its code is on the
> [`v2` branch](https://github.com/upflyjs/upfly/tree/v2) and its documentation at
> [upflyjs.github.io/upfly](https://upflyjs.github.io/upfly/). Upfly 3, below, is a different product: a
> command-line tool that optimizes the images in a codebase.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/upfly-readme-header-dark.svg">
    <img src="assets/upfly-readme-header-light.svg" alt="upfly" height="96">
  </picture>
</p>

<h3 align="center">Optimize your repo's images without breaking a reference.</h3>

<p align="center">
Built for coding agents to use: a dry run by default, <code>--json</code> output, exit codes to branch on, one
commit per run with <code>--commit</code>, and <code>upfly undo</code>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/upfly"><img src="https://img.shields.io/npm/v/upfly" alt="npm version"></a>
  <a href="https://github.com/upflyjs/upfly/actions/workflows/ci.yml"><img src="https://github.com/upflyjs/upfly/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/upfly" alt="MIT license"></a>
</p>

Converting an image to WebP takes one command. The work is everywhere the old file is named: the `import` in a
component, the `src` and `srcset` in a page, the `url()` in a stylesheet, the path in a Markdown post or a JSON
file. Build-time image tools leave your source alone. Conversion CLIs and the most-installed editor extensions write
the new file and leave the code that points at the old one for you to change.

Upfly does both halves. It finds the images in your repository and the places your code points at them, converts
each image that comes out smaller as WebP, and rewrites those references. With `--commit`, the whole change is one
commit you can review, and `upfly undo` puts it back. Where it cannot prove what a path points at, it leaves the path
alone, and its full plan lists each such path with the reason.

Moving or renaming an image is the same work, and `upfly move` does it the same way: it moves the file, rewrites the
references it can prove, and lists every other line that still names the old path.

## Highlights

- **It reads your code, not only your folders.** HTML, CSS with SCSS and Less, JavaScript and TypeScript with JSX,
  Astro, Markdown, MDX and JSON. A path resolves the way your site serves it: through the website folders Upfly
  detects or you name, `tsconfig` and `jsconfig` paths, and Vite aliases, read from their files without running them.
- **It rewrites only what it can prove, and lists the rest.** A path assembled at runtime, such as
  `` `/img/${name}.png` ``, or one that only happens to match a file, stays as written, listed with the reason.
  `upfly refs` and `upfly move` also list every other line that names the image, such as a full address or a line in
  a file type Upfly does not read, and say which of them a page still loads the image through.
- **It converts only what gets smaller.** Each image is measured by encoding it, and converts when it saves at least
  1 KB and either 10% of the file or 100 KB. A photo keeps its orientation and a wide-gamut colour profile, an
  animation is never flattened to one frame, and a PNG becomes lossless WebP when that is the smaller file. Link
  previews, icons and a web app manifest's images keep their format, because what reads them outside the page may
  not read a converted one.
- **It is safe by default.** A dry run unless you pass `--apply`, a refusal to run over uncommitted changes, one
  commit per run, `upfly undo`, and no image deleted because nothing uses it.
- **It works with coding agents.** `upfly init --agents` points a project's agents at Upfly, and the `upfly-mcp`
  package serves its commands to apps that reach tools only through MCP.
- **It is measured.** 451 of 451 cases in its accuracy suite, with configuration and without; three open-source
  projects converted, with none of their 18,922 image references broken by the run.
- **It stays on your machine.** No network calls and no telemetry, enforced by a test.

## Install

Node.js 22.18 or later; on Node.js 24, 24.11 or later.

```bash
npm install --save-dev upfly
```

Or run it once without installing: `npx upfly audit`.

## Quick start

```bash
npx upfly audit                       # the images, the references to them, what optimize would save; changes nothing
npx upfly optimize                    # the plan, as a dry run; changes nothing
npx upfly optimize --apply --commit   # carry out the plan as one commit
npx upfly undo                        # put back every file the last run changed
npx upfly refs public/hero.png        # every line that names one image; changes nothing
npx upfly --help                      # every command; upfly <command> --help for its options
```

A real run, on a committed copy of [`fixtures/vite-react`](fixtures/vite-react) from this repository, at commit
`4f30349`:

```
$ npx upfly optimize

Upfly optimize · dry run

  Convert      5 images to WebP, 124.2 KB → 48.8 KB
                 5 originals to remove, 124.2 KB, once their references move
                 3 of them are in a folder the site is served from, where a link
                 from outside the project (an email, another site, a CMS) then
                 stops working; --keep-originals keeps them
  Update       7 references in 2 files
  Leave        7 images, 2.7 KB
                 3  would save too little
                 2  SVG, which Upfly does not convert
                 1  no reference would move to a new file
                 1  unused

  Full plan    .upfly/optimize.txt
  Next         npx upfly optimize --apply

  Dry run: no project file was changed. With --apply, npx upfly optimize would
  convert 5 images and save 75.5 KB.
```

The full plan is in `.upfly/optimize.txt`, which git is told to ignore: the same rows, each followed by its complete
list, such as every image left alone with its reason. `--full` prints it, and `--show leave` prints one row of it.
`upfly audit` keeps its own in `.upfly/audit.txt`, and its savings are the ones this plan converts. Then:

```
$ npx upfly optimize --apply --commit

Upfly optimize · applied

  Converted    5 images to WebP, 124.2 KB → 48.8 KB
                 5 originals removed, 124.2 KB, since their references moved
  Updated      7 references in 2 files
  Left alone   7 images, 2.7 KB
                 3  would save too little
                 2  SVG, which Upfly does not convert
                 1  no reference would move to a new file
                 1  unused

  Run          20261009T030602-1650: 5 files created, 2 changed, 5 removed
  Commit       eb64c4900b19, exactly the files the run wrote
  Full plan    .upfly/optimize.txt
  Next         run the project's build, if it has one, then npx upfly check
                 npx upfly undo puts every file back
                 git revert eb64c4900b19 undoes the commit

  Upfly converted 5 images and saved 75.5 KB.
```

## Moving an image

`upfly move <from> <to>` moves an image, or each image in a folder, and rewrites every reference Upfly can rewrite to
name the new place, in the form it was written in. A `<to>` that is a folder, or ends in a slash, takes the image in
under its own name. It shows the plan unless you add `--apply`; with `--commit` the move is one commit, which git
shows as a rename, and `upfly undo` moves everything back.

Every other line that still names the old path is listed, with the reason Upfly leaves it as written. A real run on a
committed copy of [`fixtures/eleventy`](fixtures/eleventy), moving its whole image folder:

```
$ npx upfly move src/img src/images

Upfly move · dry run

  Move         8 images
  Update       10 references in 3 files
  Not followed 7 lines still name an old path
                 5 lines a page loads the image through: they break unless you
                 change them by hand
                 2 lines load nothing: prose, a code example, a comment Upfly
                 could not rewrite

  Full plan    .upfly/move.txt
  Next         npx upfly move src/img src/images --apply

  Dry run: no project file was changed. With --apply, 8 images would move and 10
  references in 3 files would name the new place. 7 lines still name an old path
  and stay as written: a page loads the image through 5 of them, so change those
  by hand or they break.
```

`--show unfollowed` lists each of the seven with its file, line and reason. The five a page loads an image through
are three paths in Nunjucks templates, a file type Upfly does not read yet; a path built from `{{ site.url }}`; and
the site's own `addPassthroughCopy('src/img')`, which copies the folder into the built site. The two that load nothing
are a comment in a stylesheet and a code example in a post.

What `move` does not do: it never rewrites a full address, a path built at runtime or a line in a file type it does
not read, and never rewrites a line that names the folder itself, since what a copy rule should become is yours to
decide. It refuses a move it cannot make safely, such as one that would leave a path built at runtime pointing at
nothing, and says why. It moves images only: other files in a moved folder stay where they are. It deletes no image.

Before moving or deleting an image, `upfly refs <image>` shows every line that names it. On the same fixture:

```
$ npx upfly refs src/img/logo.png

Upfly refs

src/img/logo.png  7.2 KB

No reference Upfly can read reaches it.

Not followed (1): other lines that name it, which Upfly leaves as written
  in a .njk file, a type Upfly does not read
    src/index.njk:5  /img/logo.png

Verdict: possibly unused. No reference Upfly can follow reaches it, but its name appears in src/index.njk:5.
```

## Commands

| command | what it does |
|---|---|
| `upfly audit` | Reports the images, the references to them, the references that point at nothing, the images nothing references, and what `upfly optimize` would convert and save, measured by encoding each image it could convert. Changes no project file. |
| `upfly optimize` | Converts each image that measures smaller, updates the references it can rewrite safely, and removes each original they replace (`--keep-originals` keeps them). Shows the plan unless run with `--apply`. |
| `upfly undo` | Puts back every file the last `optimize`, `dedupe` or `move` run with `--apply` changed. |
| `upfly check` | An optional guard for continuous integration: fails when a reference names an image that does not exist, or on what `check.failOn` or `--fail-on` names. `--warn` lists everything and exits 0; `--changed [ref]` keeps only what a change could have caused. Changes nothing. |
| `upfly refs <image>` | Lists every line that names one image: its references and whether Upfly could rewrite each, then every other line with why Upfly does not follow it, and what `optimize` would do with the image. Changes nothing. |
| `upfly move <from> <to>` | Moves an image, or the images in a folder, rewrites the references Upfly can, and lists every other line that still names the old path. Deletes nothing; shows the plan unless run with `--apply`. |
| `upfly dedupe` | Keeps one copy of each image stored more than once and points the references at it. Deletes nothing. |
| `upfly init` | Writes `upfly.config.json` with the folders the site is served from, as Upfly works them out, and why. `--agents` also points the project's coding agents at Upfly. |

`upfly <command> --help` lists every option and exit code. The ones you will reach for most:

- `--public <dir>`: a folder the site is served from, when Upfly cannot work it out; a plain HTML site uses
  `--public .`.
- `--exclude <pattern>`: paths to leave out, in `.gitignore` syntax. A `.upflyignore` file holds them for every run.
- `--keep-originals`, on `optimize`: keep each original beside its converted file.
- `--format avif`, on `optimize`: convert to AVIF instead of WebP.
- `--only <pattern>`, on `optimize`: convert only the matching images.
- `--commit`, with `--apply`: make the run one commit holding exactly the files it wrote.
- `--show <row>` and `--full`: one row of the summary with its complete list, or the whole report.

## Configuration

`upfly init` writes `upfly.config.json` from what it detects, and says why. On `fixtures/vite-react` it writes:

```json
{
  "$schema": "./node_modules/upfly/schema/config.json",
  "publicDirs": [
    "public"
  ],
  "format": "webp"
}
```

| key | what it sets |
|---|---|
| `publicDirs` | The folders the site is served from, relative to the file; `["."]` for a plain HTML site. |
| `publicPolicy` | `"replace"`, the default, removes an original once every reference to it has moved to the new file; `"keep-original"` keeps it. |
| `format` | `"webp"`, the default, or `"avif"`. |
| `exclude` | Paths to leave out of every run, in `.gitignore` syntax. |
| `check.maxImageBytes` | The largest an image in use may be; `upfly check` fails above it. |
| `check.failOn` | What fails `upfly check`: any of `"broken"`, `"too-large"` and `"possibly-broken"`; `[]` for nothing. Unset, it is `broken`, and `too-large` when `check.maxImageBytes` is set. |

Every command reads the file from then on. Its JSON Schema is
[`packages/cli/schema/config.json`](packages/cli/schema/config.json), so an editor checks it as you type.
`upfly.config.ts`, or `.js` and `.mjs`, works too.

## In continuous integration

`upfly check` is an optional guard. It reads no pixels and changes nothing. Unless you choose otherwise, it fails
(exit 1) when a reference names an image that does not exist, and, with `check.maxImageBytes` set, when an image in
use is larger. It also lists, apart from those, image paths in code or data that name no file: strings Upfly does not
read as references, so it cannot tell whether a page shows them. A real run on a small Vite and React demo site, with
a list of people in `src/data/crew.ts`:

```
$ npx upfly check

Upfly check

Failed: 1 reference names an image that does not exist.

References to images that do not exist (1)
    src/components/Team.tsx:5  /heor.png

Possibly broken: image paths in code or data that name no file (3)
    src/data/crew.ts:2  /crew/cernan.jpg
    src/data/crew.ts:3  /crew/schmitt.jpg
    src/data/crew.ts:4  /Hero-dark.png
      names `public/hero-dark.png` as `/Hero-dark.png`: it loads on Windows and macOS and breaks on a Linux server; fix the letter case

A possibly broken path is a string Upfly does not read as a reference: a page that shows it shows no image, but Upfly cannot tell whether a page does. Such paths fail the check only when check.failOn or --fail-on names possibly-broken.
```

What fails it is yours to choose: `check.failOn` in the config, or `--fail-on` for one run, from `broken`,
`too-large` and `possibly-broken`. On the site above, `--fail-on possibly-broken` fails on the three paths alone, and
`--warn` prints the same lists and exits 0, so a workflow can show them without failing. An unused image never fails
it.

```yaml
# .github/workflows/images.yml
name: images
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx upfly check
```

On a pull request, `--changed` keeps only what the change could have caused: the findings in the files it changed
since it left the base branch, and any reference to an image it deleted. A missing image already on the base branch
does not fail it. It needs the history, so in a workflow that runs on pull requests:

```yaml
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Check image references
        run: npx upfly check --changed origin/${{ github.base_ref }}
        # Show what it finds without failing the build:   npx upfly check --warn
        # Fail on paths in code or data that name no file too:
        #   npx upfly check --fail-on broken,possibly-broken
```

## For coding agents and scripts

- **`--json`** on every command prints one JSON object per line: progress first, the result last. Each command's
  result, the report inside it, every other line and the config file have a published JSON Schema in
  [`packages/cli/schema/`](packages/cli/schema).
- **Exit codes:** 0 the command ran, including when there was nothing to do; 1 `check` failed; 2 a usage or
  configuration error; 3 Upfly refused to write, and the message says why and what to do; 4 a failure Upfly did not
  anticipate.
- **`upfly refs <image> --json`** is the small answer: every line that names one image, and what `optimize` would do
  with it, without the whole report. Each line Upfly does not follow carries `loads`, whether a page can still load
  the image through it.
- **[`AGENTS.md`](packages/cli/AGENTS.md)** is a guide for coding agents, and
  **[`skill/upfly`](packages/cli/skill/upfly/SKILL.md)** is an Agent Skill an agent loads when a task touches a
  project's images. Both ship in the package, and `upfly init --agents` puts them where a project's agents look.
- **[`upfly-core`](packages/core)** is the engine as a library, for building on it.

### Pointing a project's agents at Upfly

`npx upfly init --agents` adds a short block, between `<!-- upfly:start -->` and `<!-- upfly:end -->`, to `AGENTS.md`
(created when there is none) and to a `CLAUDE.md` or `GEMINI.md` already there, and puts the Upfly Agent Skill in
`.agents/skills/upfly` and `.claude/skills/upfly`. The block tells an agent to use Upfly for any task that moves,
renames, converts, optimizes or deletes an image, starting with `npx upfly refs <image> --json`. On a committed copy
of `fixtures/vite-react`, after `npx upfly init`:

```
$ npx upfly init --agents

Upfly init

Kept upfly.config.json, which was already there.

Pointed this project's coding agents at Upfly:
  AGENTS.md  created, with the Upfly block
  .agents/skills/upfly/SKILL.md  the Upfly skill, created
  .claude/skills/upfly/SKILL.md  the Upfly skill, created

Commit these files, so the agent of everyone working on the project reads them.
```

It changes nothing outside its block, keeps a config file that exists, asks nothing, and a second run changes
nothing. Where each agent finds them, from its own documentation in October 2026:

| agent | reads the block in | loads the Skill from |
|---|---|---|
| Codex | `AGENTS.md` | `.agents/skills` |
| Cursor | `AGENTS.md` | `.agents/skills` and `.claude/skills` |
| GitHub Copilot | `AGENTS.md` | `.agents/skills` and `.claude/skills` |
| Claude Code | `CLAUDE.md`, or `AGENTS.md` when there is no `CLAUDE.md` | `.claude/skills` |
| Gemini CLI | `GEMINI.md` | `.agents/skills` |
| Antigravity | `AGENTS.md` or `GEMINI.md` | `.agents/skills` |
| Windsurf | `AGENTS.md` | `.agents/skills`, and `.claude/skills` when turned on |
| Cline | `AGENTS.md` | `.claude/skills` |
| OpenCode | `AGENTS.md` | `.agents/skills` and `.claude/skills` |
| Roo Code | `AGENTS.md` | none |
| Zed | the first file of its own list, `AGENTS.md` among them | none |

An agent that reads both folders sees the same Skill twice. The block does not reach Gemini CLI in a project with no
`GEMINI.md`, though the Skill does; Zed when the project holds a file Zed reads before `AGENTS.md`, such as `.rules`;
Aider, which reads only the files it is told to; or Claude Code in a project with a personal `CLAUDE.local.md` and no
`CLAUDE.md`, which `init --agents` leaves alone, though the Skill reaches it.

<!-- agent story: measured numbers -->

### Through MCP

For an app that reaches tools only through MCP, such as Claude Desktop, the `upfly-mcp` package serves the same
commands as an MCP server over standard input and output. I keep it in a package of its own, so installing `upfly`
does not bring an MCP server with it.

<!-- upfly-mcp: not run yet; check these commands against the package before the release -->

Register it as a server the client starts, giving it the project's folder. In Claude Desktop's config, and that of
most clients:

```json
{
  "mcpServers": {
    "upfly": { "command": "npx", "args": ["-y", "upfly-mcp", "/path/to/project"] }
  }
}
```

With Claude Code: `claude mcp add upfly -- npx -y upfly-mcp /path/to/project`. On Windows, a client that cannot start
`npx` itself takes `"command": "cmd"` with `"/c", "npx"` before the same arguments.

There is one tool for each of `audit`, `check`, `refs`, `optimize`, `dedupe`, `move` and `undo`. Each runs its
command with `--json` and answers with the line the command prints last: the same result, or the same error with its
`reason`. `audit`, `check` and `refs` change no file. `optimize`, `dedupe` and `move` write only when a call sets
`apply` to true, and then refuse what the command refuses; `undo` needs `apply` too. No tool runs `init`, and none
takes `--allow-dirty`, so a tool writes only in a project git tracks, with no uncommitted changes.

## How it works

Every image in your codebase, and every line that uses it:

1. **Find.** Upfly walks the repository for images and for the files that can name one, leaving out dependencies and
   build output (`node_modules`, `dist`, `build`, `_site` and others).
2. **Read.** Each file is parsed by a reader for its language, and each path in it is recorded with its file, its
   line and the syntax it sits in: an `import`, an `<img src>`, a `url()`, a Markdown image.
3. **Resolve.** Each path is resolved as the site or the bundler would resolve it: against the website folders, an
   alias, or the file's own folder. Only a path resolved on disk from a static `import` or a literal in a known
   position can be rewritten. A pattern or a path assembled at runtime never is, and an image it could name is
   reported as possibly unused, never as unused.
4. **Plan.** Each image that could convert is encoded to measure it. It converts when the saving is large enough and
   at least one of its references will point at the new file; otherwise it is left, with the reason. A path written
   inside a comment moves with the references, so no comment is left naming a file that has gone, but a comment
   never makes an image convert on its own.
5. **Write.** Every image is encoded into `.upfly/runs/`, and every edit is computed and checked, before any project
   file changes; a failure there leaves the tree untouched. A manifest is written first, then the new files, then
   the edits, then the removals, so a run stopped at any point can still be undone, and `upfly undo` works from that
   manifest.

`refs` and `move` add one more step: a search of the project's files for the image's path, in any letter case, so
that the lines no reader follows are listed too, each with the reason.

[ARCHITECTURE.md](ARCHITECTURE.md) explains each stage and the decisions behind it.

## Safety

- **Nothing is written without `--apply`.** `audit`, `check` and `refs` never write a project file, and `optimize`,
  `dedupe` and `move` only show their plan until you add `--apply`.
- **`--apply` refuses to run over uncommitted changes**, or in a folder git does not track, so the run's changes are
  the only ones to review. `--allow-dirty` writes anyway, and `upfly undo` still puts the files back.
- **`--commit` makes one commit** holding exactly the files the run wrote, which `git revert` undoes. While a merge,
  a rebase, a cherry-pick or a revert is in progress, it refuses before writing anything, since its commit would
  become part of that operation.
- **`upfly undo` puts back every file** the last `optimize`, `dedupe` or `move` run with `--apply` changed. It checks
  each file first and changes nothing if any of them was edited since that run.
- **Upfly never deletes an image that nothing uses.** It lists each one with its size, and the decision is yours.
  `move` and `dedupe` delete no image either.
- **An original is removed once no file Upfly reads still names it**, wherever it sits: in a folder the site is
  served from, or among the images a build loads. That is the default, so the dry run says how many originals go,
  and how many of them are in a folder the site is served from, where a link from outside the project, such as an
  email, another site or a CMS, then stops working. `--keep-originals`, or `"publicPolicy": "keep-original"` in the
  config file, keeps every original beside its converted file.
- **A path Upfly cannot prove is never rewritten**: one assembled at runtime, or one that only happens to match a
  file. The full plan lists each reference left as written, with the reason.

## Accuracy

> Upfly's reference accuracy suite is a purpose-built project of 451 keyed cases, image references and the decoys
> beside them, across 74 shapes in HTML, CSS (with SCSS and Less), JavaScript and TypeScript (with JSX), Astro,
> Markdown, MDX and JSON, each with its expected answer written down before the engine ran. With the suite's own
> settings, the engine meets all 451. With no configuration at all, it also meets all 451. It claims none of the 91
> cases that look like a path but are not one.

> What the suite does not show: it is ours, not a sample of real code, and a shape that is not in it is not
> measured. Files Upfly does not read yet (Vue, Svelte, PHP, ERB, Liquid, Nunjucks and YAML frontmatter) are listed
> as unread, not counted. A path assembled at runtime with no file extension written anywhere is not claimed,
> because its text cannot be told from a page route. Zero-configuration detection has been tested on JavaScript
> projects only; a Rails, Laravel, Hugo or plain-HTML site may need its website folder named in settings, as the
> plain-HTML site among the real projects below did. Run it yourself: one command, `pnpm accuracy:measure`.

The suite is [`accuracy-suite/`](accuracy-suite/); its README says how each case is keyed.

**On real projects.** Fresh clones of three public repositories, eleventy-docs, railsgirls-com and scratch-www, were
each converted at a pinned commit under both policies, keeping every original and removing originals once their
references moved. Between 15 and 3,412 images were converted per run; every applied run made exactly one commit;
every project build still passed (railsgirls-com has none); the link check found none of the 18,922 image references
it read broken by a run; and a second run found nothing to do.

**Images Upfly might call unused when they are not.** An independent search for every image file name across the
five repositories Upfly is tested on found 3,485 mentions the engine did not link. Of the 684 checked, all 384 in
the four smaller repositories and a random 300 of railsgirls-com's 3,101, none was an image Upfly would call unused.
A zero in a random 300 still allows up to 29 such misses among the 3,101, at 95% confidence.

[EVIDENCE.md](EVIDENCE.md) has each run's table, how it was measured, and what each result does not show.

## Limits

- **Not read yet:** Vue, Svelte, PHP, ERB, Liquid, Nunjucks and YAML frontmatter. An image named only there is
  reported as possibly unused, never as unused. `refs` and `move` list each such line, and `move` leaves it as
  written: a page that loads an image through one breaks unless you change it by hand.
- **A full address is never rewritten,** even one on your own site, such as `https://example.com/img/logo.png`:
  Upfly cannot tell which host is the site's own. `refs` and `move` list each one.
- **Zero configuration is tested on JavaScript projects;** any other site names its folder with `--public <dir>`.
- **Images a build loads convert only under Vite, Next.js and Astro;** under other bundlers they keep their format.
- **Removing originals breaks references Upfly cannot see**, such as an email already sent;
  `--keep-originals` keeps them.
- **`check` lists only the possibly broken paths that start with `/`;** it counts the others, and
  `upfly audit --include-discarded` lists them.
- **The first `optimize` on a large site takes a while:** it measures every image it could convert before
  converting it.

Each limit in full is in [EVIDENCE.md](EVIDENCE.md#limits-in-full).

## No network, no telemetry

Upfly makes no network calls and sends nothing anywhere. A test runs every command with each way Node.js offers to
reach the network replaced by one that records the attempt, and fails on any
([`packages/cli/test/no-network.test.ts`](packages/cli/test/no-network.test.ts)). Upfly runs git for local work
only.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) says how to set up, how a change is made (the test first), and how to add a reader
for a file type, the best first contribution. [ARCHITECTURE.md](ARCHITECTURE.md) describes the design, and
[CHANGELOG.md](CHANGELOG.md) what changed in each version.

```bash
pnpm install
pnpm check              # lint, the comment check, typecheck and the tests: the gate CI runs
pnpm accuracy:measure   # the accuracy suite, both runs
```

## License

MIT © [Rinkal Kumar](https://github.com/ramin-010)
