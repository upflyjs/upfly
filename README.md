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
Upfly converts your images to WebP and updates the code that points at them, as one change you can review and
undo. Anything it cannot prove, it leaves alone and tells you why.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/upfly"><img src="https://img.shields.io/npm/v/upfly" alt="npm version"></a>
  <a href="https://github.com/upflyjs/upfly/actions/workflows/ci.yml"><img src="https://github.com/upflyjs/upfly/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/upfly" alt="MIT license"></a>
</p>

Converting an image takes one command. The real work is every place the old file is named: an `import` in a
component, a `src` or `srcset` in a page, a `url()` in a stylesheet, a path in a Markdown post or a JSON file. Miss
one and the image breaks on your site.

Upfly does that work. It finds the images in your repository and the lines that use them, converts each image that
comes out smaller, and rewrites those lines. With `--commit`, the whole change is one commit you can review, and
`npx upfly undo` puts it back. Where it cannot prove what a path points at, it leaves the path alone, and its full
plan lists each such path with the reason.

Moving or renaming an image is the same job, and `npx upfly move` does it the same way.

## Highlights

- **It knows where your images are used.** It reads HTML, CSS with SCSS and Less, JavaScript and TypeScript with
  JSX, Astro, Markdown, MDX and JSON, and resolves each path the way your site serves it: through your website
  folders, `tsconfig` and `jsconfig` paths, and Vite aliases.
- **It changes only what it can prove.** A path built at runtime, or one that only happens to match a file, stays as
  written, and the plan lists it with the reason.
- **It converts only what gets smaller,** and keeps what other software needs: link previews, icons and app
  manifests keep their format, and a photo keeps its orientation and colour profile.
- **Nothing happens without your say.** No image or line of code changes until you add `--apply`; it will not run
  over uncommitted work; `npx upfly undo` puts every file back. It never deletes an image just because nothing uses
  it.
- **It works with your coding agent.** `npx upfly init --agents` tells the agent to use Upfly for image tasks, and
  the `upfly-mcp` package offers the same commands to apps that use MCP.
- **It is measured.** 453 of 453 cases in its [accuracy suite](accuracy-suite/), with configuration and without; the
  open-source websites of [Eleventy, Rails Girls and Scratch](EVIDENCE.md#three-real-projects-converted-and-built),
  each converted on a fresh clone, with none of their 18,922 image references broken by the run.
- **It stays on your machine.** No network calls and no telemetry, enforced by a test.

## Install

Node.js 22 or later.

```bash
npm install --save-dev upfly
```

Or run it once without installing: `npx upfly audit`. On a Node.js 22 before 22.18, npm prints a warning about
`upfly-core`, the engine package, which asks for 22.18; Upfly runs all the same.

## Quick start

```bash
npx upfly init --agents               # set up once: upfly.config.json, and your coding agents pointed at Upfly
npx upfly audit                       # the images, the references to them, what optimize would save; changes nothing
npx upfly optimize                    # the plan, as a dry run; changes nothing
npx upfly optimize --apply --commit   # carry out the plan as one commit
npx upfly undo                        # put back every file the last run changed
npx upfly refs public/hero.png        # every line that names one image; changes nothing
npx upfly --help                      # every command; npx upfly <command> --help for its options
```

**`init` sets a project up once.** It writes `upfly.config.json` with the folders your site is served from, as Upfly
works them out, each with its reason, for you to check. With `--agents`, it also points your coding agents at Upfly
([what it adds](#pointing-your-coding-agents-at-upfly)); leave `--agents` out if you do not use one. Commit what
`init` writes before `npx upfly optimize --apply`, which will not run over uncommitted work.

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
list, such as every image left alone with its reason. `npx upfly optimize --full` prints it, and
`npx upfly optimize --show leave` prints one row of it. `npx upfly audit` keeps its own report in
`.upfly/audit.txt`, and its savings are the ones this plan converts. Then:

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

## Commands

| command | what it does |
|---|---|
| `npx upfly init` | Writes `upfly.config.json` with the folders your site is served from, and why. `--agents` also points your coding agents at Upfly. |
| `npx upfly audit` | Reports your images, the references to them, the references that point at nothing, the images nothing uses, and what `optimize` would save, measured by encoding each image it could convert. Changes no project file. |
| `npx upfly optimize` | Converts each image that comes out smaller, updates the references it can rewrite safely, and removes each original they replace (`--keep-originals` keeps them). Shows the plan until you add `--apply`. |
| `npx upfly undo` | Puts back every file the last `optimize`, `move` or `dedupe` run with `--apply` changed. |
| `npx upfly refs <image>` | Lists every line that names one image, whether Upfly can rewrite each, and what `optimize` would do with it. Changes nothing. |
| `npx upfly move <from> <to>` | Moves an image, or the images in a folder, updates the references Upfly can rewrite, and lists every other line that still names the old path. Shows the plan until you add `--apply`. |
| `npx upfly dedupe` | Keeps one copy of each image stored more than once and points the references at it. Deletes nothing. |
| `npx upfly check` | Fails when a reference names an image that does not exist, as a step in continuous integration. Changes nothing. |

`npx upfly <command> --help` lists every option and exit code. The ones you will reach for most:

- `--public <dir>`: a folder your site is served from, when Upfly cannot work it out:
  `npx upfly audit --public .` for a plain HTML site.
- `--exclude <pattern>`: paths to leave out, in `.gitignore` syntax: `npx upfly optimize --exclude "legacy/**"`.
  Repeat it for more; a `.upflyignore` file holds them for every run.
- `--keep-originals`: keep each original beside its converted file: `npx upfly optimize --apply --keep-originals`.
- `--format avif`: convert to AVIF instead of WebP: `npx upfly optimize --format avif`.
- `--only <pattern>`: convert only the matching images: `npx upfly optimize --only "*.jpg"`.
- `--commit`: with `--apply`, make the run one commit holding exactly the files it wrote:
  `npx upfly optimize --apply --commit`.
- `--show <row>` and `--full`: one row of the summary with its complete list, or the whole report:
  `npx upfly optimize --show leave`.

## Moving an image

`npx upfly move <from> <to>` moves an image, or a whole folder of images, and updates every reference Upfly can
rewrite to name the new place. Give a folder as `<to>` to keep each file's name. Like `optimize`, it shows the plan
first: `--apply` makes the move, `--commit` makes it one commit that git shows as a rename, and `npx upfly undo` moves
everything back.

A real run on a fresh clone of the [Rails Girls website](https://github.com/railsgirls/railsgirls.com), at commit
`fa2b63c`, moving the photos of its events in Japan into a new folder:

```
$ npx upfly move images/japan images/events/japan

Upfly move · dry run

  Move         45 images
  Update       161 references in 25 files
                 7 paths inside a comment move with them, so no comment is left
                 naming a file that has gone

  Full plan    .upfly/move.txt
  Next         npx upfly move images/japan images/events/japan --apply

  Dry run: no project file was changed. With --apply, 45 images would move and
  161 references in 25 files would name the new place.
```

`npx upfly move images/japan images/events/japan --show update` lists the 25 files and how many references each
holds.

When a line names the image in a way Upfly cannot rewrite, such as a full web address, a path in a file type it does
not read yet, or a build tool's rule that names the folder, the plan adds a **Not followed** row: each such line with its file, its reason, and
whether a page still loads the image through it, so you know what to change by hand. This move had none. `move`
refuses a move it cannot make safely, such as one that would leave a path built at runtime pointing at nothing, and
says why. It moves images only, and deletes nothing.

Before you move or delete an image by hand, `npx upfly refs <image>` shows every line that names it. A real run on a
fresh clone of [shadcn/ui](https://github.com/shadcn-ui/ui), at commit `3ba91b1`:

```
$ npx upfly refs apps/v4/public/avatars/02.png

Upfly refs

apps/v4/public/avatars/02.png  15.3 KB

References (13)
    apps/v4/components/cards/chat.tsx:67  /avatars/02.png
    apps/v4/components/cards/team-members.tsx:50  /avatars/02.png
    apps/v4/examples/aria/item-dropdown.tsx:33  /avatars/02.png
    apps/v4/examples/aria/item-group.tsx:29  /avatars/02.png
    apps/v4/examples/aria/message-demo.tsx:39  /avatars/02.png
    apps/v4/examples/aria/message-demo.tsx:66  /avatars/02.png
    apps/v4/examples/aria/message-group.tsx:29  /avatars/02.png
    apps/v4/examples/base/message-demo.tsx:39  /avatars/02.png
    apps/v4/examples/base/message-demo.tsx:66  /avatars/02.png
    apps/v4/examples/base/message-group.tsx:29  /avatars/02.png
    apps/v4/examples/radix/message-demo.tsx:39  /avatars/02.png
    apps/v4/examples/radix/message-demo.tsx:66  /avatars/02.png
    apps/v4/examples/radix/message-group.tsx:29  /avatars/02.png

Verdict: converts to apps/v4/public/avatars/02.webp, 15.3 KB to 4.6 KB. All 13 of its references move to the new file; the original is removed, since every reference to it moves.
```

Lines Upfly would leave as written are listed after the references, under **Not followed**, each with the reason.

## With coding agents and scripts

### Pointing your coding agents at Upfly

Renaming, moving or deleting an image starts with finding every line that uses it. `npx upfly init --agents` points
the coding agents in your project at Upfly for that. It adds a short block, marked `<!-- upfly:start -->` and
`<!-- upfly:end -->`, to `AGENTS.md` (created when there is none) and to a `CLAUDE.md` or `GEMINI.md` already there,
and puts the Upfly skill in `.agents/skills/upfly` and `.claude/skills/upfly`. The block asks the agent to start with
`npx upfly refs <image> --json`, and says Upfly changes no file without `--apply`. On a committed copy of
`fixtures/vite-react`, after `npx upfly init`:

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

It changes nothing outside its block, keeps a config file that exists, and a second run changes nothing.

<details>
<summary>Which agents read which file</summary>

From each agent's own documentation, October 2026:

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

</details>

### JSON, exit codes and the engine

- **`--json`** on every command prints one JSON object per line: progress first, the result last. Each command's
  result, the report inside it, every other line and the config file have a published JSON Schema in
  [`packages/cli/schema/`](packages/cli/schema).
- **Exit codes:** 0 the command ran, including when there was nothing to do; 1 `check` failed; 2 a usage or
  configuration error; 3 Upfly refused to write, and the message says why and what to do; 4 a failure Upfly did not
  anticipate.
- **`npx upfly refs <image> --json`** is the small answer: every line that names one image, and what `optimize`
  would do with it, without the whole report. Each line Upfly does not follow carries `loads`, whether a page can
  still load the image through it.
- **[`AGENTS.md`](packages/cli/AGENTS.md)** is a guide for coding agents, and
  **[`skill/upfly`](packages/cli/skill/upfly/SKILL.md)** is the Agent Skill. Both ship in the package.
- **[`upfly-core`](packages/core)** is the engine as a library, for building on it.

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

## Configuration

`npx upfly init` writes `upfly.config.json` from what it detects, and says why. On `fixtures/vite-react` it writes:

```json
{
  "$schema": "./node_modules/upfly/schema/config.json",
  "publicDirs": [
    "public"
  ],
  "format": "webp"
}
```

In a JavaScript project, Upfly works out the folders your site is served from by itself. For any other site,
`npx upfly init` tests the site's own image paths against each folder and writes the one they resolve under: on the
plain HTML site of Rails Girls it writes `"publicDirs": ["."]`, since 1,268 of its 1,268 root-relative image paths
resolve there. Check what it wrote, or set it yourself.

The same file with every key set:

```json
{
  "$schema": "./node_modules/upfly/schema/config.json",
  "publicDirs": ["public"],
  "publicPolicy": "keep-original",
  "format": "avif",
  "exclude": ["public/legacy/**", "*.min.css"],
  "check": {
    "maxImageBytes": 500000,
    "failOn": ["broken", "too-large"]
  }
}
```

| key | what it sets | set it when |
|---|---|---|
| `publicDirs` | The folders the site is served from, relative to the file; `["."]` for a plain HTML site. | Upfly works out the wrong folder, or none. |
| `publicPolicy` | `"replace"`, the default, removes an original once every reference to it has moved to the new file; `"keep-original"` keeps it. | Other sites, emails or apps link to your image files directly. |
| `format` | `"webp"`, the default, or `"avif"`. | You want smaller files still, and your visitors' browsers show AVIF. |
| `exclude` | Paths to leave out of every run, in `.gitignore` syntax. | Some images must never change, such as a vendored theme. |
| `check.maxImageBytes` | The largest an image in use may be, in bytes; `npx upfly check` fails above it. | You want CI to stop a heavy image before it ships. |
| `check.failOn` | What fails `npx upfly check`: any of `"broken"`, `"too-large"` and `"possibly-broken"`; `[]` for nothing. Unset, it is `broken`, and `too-large` when `check.maxImageBytes` is set. | You want `check` stricter, or to report without failing. |

Every command reads the file from then on. Its JSON Schema is
[`packages/cli/schema/config.json`](packages/cli/schema/config.json), so an editor checks it as you type.
`upfly.config.ts`, or `.js` and `.mjs`, works too.

## Checking image paths in CI

`npx upfly check` fails (exit 1) when a reference names an image that does not exist, and, with
`check.maxImageBytes` set, when an image in use is larger. It reads no pixels and changes nothing, so it is quick to
run on every push:

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

On a pull request, `npx upfly check --changed origin/main` fails only on what the change could have caused, so a
missing image already on the main branch does not fail it; it needs the history (`fetch-depth: 0` on the checkout
step). `--warn` lists everything and exits 0. Image paths in code or data that name no file, which Upfly cannot tell
a page shows, are listed apart as possibly broken, and fail the check only when `check.failOn` or `--fail-on` names
`possibly-broken`. An unused image never fails it.

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
4. **Plan.** Each image that could convert is encoded to measure it. It converts when it saves at least 1 KB and
   either 10% of the file or 100 KB, and at least one of its references will point at the new file; otherwise it is
   left, with the reason. A photo keeps its orientation and wide-gamut colour profile, an animation is never
   flattened to one frame, and a PNG becomes lossless WebP when that is the smaller file. Link previews, icons and a
   web app manifest's images keep their format, because what reads them outside the page may not read a converted
   one. A path written inside a comment moves with the references, so no comment is left naming a file that has
   gone, but a comment never makes an image convert on its own.
5. **Write.** Every image is encoded into `.upfly/runs/`, and every edit is computed and checked, before any project
   file changes; a failure there leaves the tree untouched. A manifest is written first, then the new files, then
   the edits, then the removals, so a run stopped at any point can still be undone, and `npx upfly undo` works from
   that manifest.

`refs` and `move` add one more step: a search of the project's files for the image's path, in any letter case, so
that the lines no reader follows are listed too, each with the reason.

[ARCHITECTURE.md](ARCHITECTURE.md) explains each stage and the decisions behind it.

## Safety

- **Nothing is written without `--apply`.** `audit`, `check` and `refs` never write a project file, and `optimize`,
  `dedupe` and `move` only show their plan until you add `--apply`.
- **`--apply` refuses to run over uncommitted changes**, or in a folder git does not track, so the run's changes are
  the only ones to review. `--allow-dirty` writes anyway, and `npx upfly undo` still puts the files back.
- **`--commit` makes one commit** holding exactly the files the run wrote, which `git revert` undoes. While a merge,
  a rebase, a cherry-pick or a revert is in progress, it refuses before writing anything, since its commit would
  become part of that operation.
- **`npx upfly undo` puts back every file** the last `optimize`, `dedupe` or `move` run with `--apply` changed. It
  checks each file first and changes nothing if any of them was edited since that run.
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

> Upfly's reference accuracy suite is a purpose-built project of 453 keyed cases, image references and the decoys
> beside them, across 74 shapes in HTML, CSS (with SCSS and Less), JavaScript and TypeScript (with JSX), Astro,
> Markdown, MDX and JSON, each with its expected answer written down before the engine ran. With the suite's own
> settings, the engine meets all 453. With no configuration at all, it also meets all 453. It claims none of the 93
> cases that look like a path but are not one.

> What the suite does not show: it is ours, not a sample of real code, and a shape that is not in it is not
> measured. Files Upfly does not read yet (Vue, Svelte, PHP, ERB, Liquid, Nunjucks and YAML frontmatter) are listed
> as unread, not counted. A path assembled at runtime with no file extension written anywhere is not claimed,
> because its text cannot be told from a page route. Detection without a config file is tested on JavaScript
> projects; another site may need its website folder named once, which `npx upfly init` can work out from the
> site's own image paths. Run it yourself: one command, `pnpm accuracy:measure`.

The suite is [`accuracy-suite/`](accuracy-suite/); its README says how each case is keyed.

**On real projects.** I ran Upfly on fresh clones of three public websites, Eleventy's documentation, Rails Girls and
Scratch, converting each twice: once keeping every original, and once removing originals as their references moved.
Each run converted between 15 and 3,412 images. After every run the site's build still passed (Rails Girls has no
build), the link check found none of the 18,922 image references it read across the three sites broken by the run,
and a second run found nothing left to do.

**When Upfly calls an image unused.** Upfly never deletes an unused image, but it tells you which ones nothing uses,
so that list has to be right. A search of the five repositories Upfly is tested on, for every image's file name,
found 3,485 mentions the engine had not linked to an image. 684 of them were checked one by one: all 384 in the four
smaller repositories, and 300 picked at random from Rails Girls' 3,101. None of them was a real use of an image
Upfly calls unused.

[EVIDENCE.md](EVIDENCE.md) has each run's table, how it was measured, and what each result does not show.

## Limits

- **Not read yet:** Vue, Svelte, PHP, ERB, Liquid, Nunjucks and YAML frontmatter. An image named only there is
  reported as possibly unused, never as unused. `refs` and `move` list each such line, and `move` leaves it as
  written: a page that loads an image through one breaks unless you change it by hand.
- **A full address is never rewritten,** even one on your own site, such as `https://example.com/img/logo.png`:
  Upfly cannot tell which host is the site's own. `refs` and `move` list each one.
- **Images a build loads convert only under Vite, Next.js and Astro;** under other bundlers they keep their format.
- **Removing originals breaks references Upfly cannot see**, such as an email already sent;
  `--keep-originals` keeps them.
- **`check` lists only the possibly broken paths that start with `/`;** it counts the others, and
  `npx upfly audit --include-discarded` lists them.
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
