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

## Highlights

- **It reads your code, not only your folders.** HTML, CSS with SCSS and Less, JavaScript and TypeScript with JSX,
  Astro, Markdown, MDX and JSON. A path resolves the way your site serves it: through the website folders Upfly
  detects or you name, `tsconfig` and `jsconfig` paths, and Vite aliases, read from their files without running them.
- **It rewrites only what it can prove.** A path assembled at runtime, such as `` `/img/${name}.png` ``, or one that
  only happens to match a file, stays as written, listed with the reason.
- **It converts only what gets smaller.** Each image is measured by encoding it, and converts when it saves at least
  1 KB and either 10% of the file or 100 KB. A photo keeps its orientation and a wide-gamut colour profile, an
  animation is never flattened to one frame, and a PNG becomes lossless WebP when that is the smaller file. Link
  previews, icons and a web app manifest's images keep their format, because what reads them outside the page may
  not read a converted one.
- **It is safe by default.** A dry run unless you pass `--apply`, a refusal to run over uncommitted changes, one
  commit per run, `upfly undo`, and no image deleted because nothing uses it.
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
npx upfly --help                      # every command; upfly <command> --help for its options
```

A real run, on a committed copy of [`fixtures/vite-react`](fixtures/vite-react) from this repository, at commit
`0bfa4e1`:

```
$ upfly optimize

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
                 1  nothing links to it

  Full plan    .upfly/optimize.txt
  Next         upfly optimize --apply

  Dry run: no project file was changed. With --apply, upfly optimize would
  convert 5 images and save 75.5 KB.
```

The full plan is in `.upfly/optimize.txt`, which git is told to ignore: the same rows, each followed by its complete
list, such as every image left alone with its reason. `--full` prints it, and `--show leave` prints one row of it.
`upfly audit` keeps its own in `.upfly/audit.txt`, and its savings are the ones this plan converts. Then:

```
$ upfly optimize --apply --commit

Upfly optimize · applied

  Converted    5 images to WebP, 124.2 KB → 48.8 KB
                 5 originals removed, 124.2 KB, since their references moved
  Updated      7 references in 2 files
  Left alone   7 images, 2.7 KB
                 3  would save too little
                 2  SVG, which Upfly does not convert
                 1  no reference would move to a new file
                 1  nothing links to it

  Run          20261004T095537-0270: 5 files created, 2 changed, 5 removed
  Commit       5be6a2174d6d, exactly the files the run wrote
  Full plan    .upfly/optimize.txt
  Next         run the project's build, if it has one, then upfly check
                 upfly undo puts every file back
                 git revert 5be6a2174d6d undoes the commit

  Upfly converted 5 images and saved 75.5 KB.
```

## Commands

| command | what it does |
|---|---|
| `upfly audit` | Reports the images, the references to them, the references that point at nothing, the images nothing references, and what `upfly optimize` would convert and save, measured by encoding each image it could convert. Changes no project file. |
| `upfly optimize` | Converts each image that measures smaller, updates the references it can rewrite safely, and removes each original they replace (`--keep-originals` keeps them). Shows the plan unless run with `--apply`. |
| `upfly undo` | Puts back every file the last `optimize --apply` or `dedupe --apply` changed. |
| `upfly check` | For continuous integration: fails when a reference names an image that does not exist, or, with a limit in the config, when an image in use is larger than it. `--changed [ref]` keeps only what a change could have caused. |
| `upfly refs <image>` | Lists where one image is referenced, whether Upfly could rewrite each reference, and what `optimize` would do with it. |
| `upfly dedupe` | Keeps one copy of each image stored more than once and points the references at it. Deletes nothing. |
| `upfly init` | Writes `upfly.config.json` with the folders the site is served from, as Upfly works them out, and why. |

`upfly <command> --help` lists every option and exit code. The ones you will reach for most:

- `--public <dir>`: a folder the site is served from, when Upfly cannot work it out; a plain HTML site uses
  `--public .`.
- `--exclude <pattern>`: paths to leave out, in `.gitignore` syntax. A `.upflyignore` file holds them for every run.
- `--keep-originals`, on `optimize`: keep each original beside its converted file.
- `--format avif`, on `optimize`: convert to AVIF instead of WebP.
- `--only <pattern>`, on `optimize`: convert only the matching images.
- `--show <row>` and `--full`: one row of the summary with its complete list, or the whole report.

## Configuration

`upfly init` writes `upfly.config.json` from what it detects, and says why. On the fixture above it writes:

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

Every command reads the file from then on. Its JSON Schema is
[`packages/cli/schema/config.json`](packages/cli/schema/config.json), so an editor checks it as you type.
`upfly.config.ts`, or `.js` and `.mjs`, works too.

## In continuous integration

`upfly check` exits 1 when a reference names an image that does not exist, and, with `check.maxImageBytes` set, when
an image in use is larger. It reads no pixels and encodes nothing.

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

On a pull request, `npx upfly check --changed origin/main` keeps only what the change could have caused: the findings
in the files it changed since it left `main`, and any reference to an image it deleted. A missing image already on
`main` does not fail it. This needs the history: `fetch-depth: 0` on the checkout.

## For coding agents and scripts

- **`--json`** on every command prints one JSON object per line: progress first, the result last. Each command's
  result, the report inside it, every other line and the config file have a published JSON Schema in
  [`packages/cli/schema/`](packages/cli/schema).
- **Exit codes:** 0 the command ran, including when there was nothing to do; 1 `check` failed; 2 a usage or
  configuration error; 3 Upfly refused to write, and the message says why and what to do; 4 a failure Upfly did not
  anticipate.
- **`upfly refs <image> --json`** is the small answer: one image's references and what `optimize` would do with it,
  without the whole report.
- **[`AGENTS.md`](packages/cli/AGENTS.md)** is a guide for coding agents, and
  **[`skill/upfly`](packages/cli/skill/upfly/SKILL.md)** is an Agent Skill an agent loads when a task touches a
  project's images. Both ship in the package.
- **[`upfly-core`](packages/core)** is the engine as a library, for building on it.

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
   at least one of its references will point at the new file; otherwise it is left, with the reason.
5. **Write.** Every image is encoded into `.upfly/runs/`, and every edit is computed and checked, before any project
   file changes; a failure there leaves the tree untouched. A manifest is written first, then the new files, then
   the edits, then the removals, so a run stopped at any point can still be undone, and `upfly undo` works from that
   manifest.

[ARCHITECTURE.md](ARCHITECTURE.md) explains each stage and the decisions behind it.

## Safety

- **Nothing is written without `--apply`.** `audit`, `check` and `refs` never write a project file, and `optimize`
  and `dedupe` only show their plan until you add `--apply`.
- **`--apply` refuses to run over uncommitted changes**, or in a folder git does not track, so the run's changes are
  the only ones to review. `--allow-dirty` writes anyway, and `upfly undo` still puts the files back.
- **`--commit` makes one commit** holding exactly the files the run wrote, which `git revert` undoes.
- **`upfly undo` puts back every file** the last `optimize --apply` or `dedupe --apply` changed. It checks each file
  first and changes nothing if any of them was edited since that run.
- **Upfly never deletes an image that nothing uses.** It lists each one with its size, and the decision is yours.
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
  reported as possibly unused, never as unused.
- **Zero configuration is tested on JavaScript projects;** any other site names its folder with `--public <dir>`.
- **Images a build loads convert only under Vite, Next.js and Astro;** under other bundlers they keep their format.
- **Removing originals breaks references Upfly cannot see**, such as an email already sent;
  `--keep-originals` keeps them.
- **The first `optimize` on a large site takes a while:** it measures every image before converting it.

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
