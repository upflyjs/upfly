# Changelog

## 3.4.0

A way to remove an original kept beside its converted file once nothing needs it, which the Upfly VS Code extension
uses for an image that arrives from outside the editor. No command, option or JSON field of 3.3.0 was removed or
renamed.

### What is new

- `optimize --remove-originals --image <path>` removes an original that an earlier run kept beside its converted
  file, with `--keep-originals` or as the extension does. I made it for the extension: an image an agent writes from
  a terminal is converted with its original kept, since the agent may name the original next, and the original can
  go once nothing needs it. It converts nothing and rewrites no line. An original goes only when its converted file
  stands beside it as the same picture (the same size and frames), no line in the project names it, a comment
  included, and the search Upfly makes before every delete finds nothing; otherwise it stays, and the plan says why,
  such as the page that still names it. The removal is backed up like any run's, so `upfly undo` brings it back, and
  it takes `--no-undo`, `--commit` and `--expect-plan` as a conversion does. With `--json`, the plan lists what goes
  in `removals`, each with `inPublicDir`, and what stays in `declined`, and the `planned` progress line counts what
  goes in `removals` too; every plan now carries `removals`, empty when it converts, and a plan that converts keeps
  the `planHash` it had.

What the Upfly VS Code extension needs from the CLI to convert new images as they arrive, a way to name an image by
its exact path, and fields for what a program reading the JSON had to take from sentences. No command, option or JSON
field of 3.2.0 was removed or renamed.

### What is new

- `optimize --apply --no-undo` writes without a record for `upfly undo`. I made it for the extension, which converts an
  image as it arrives: such a conversion must never replace the last run you started, so `upfly undo`, `--list`,
  `--file` and `--line` still act on that run. While it writes, a run with `--no-undo` takes the same steps as any run
  (its own record, the staged files and backups, then the changes) under the same lock, and once it finishes it
  removes all of them. Cut off part way, by a crash or a closed editor, it is put back by the next command that
  writes, before anything else; a dry run says so. With `--json`, its `run` says `undoable: false`. When such a run
  rewrites a file your last run also changed, `upfly undo` refuses that file as changed since, as after any edit.
- `optimize --image <path>` converts only that image, named by its exact path, whatever characters it holds, such as
  `app/blog/[slug]/og.png` or a folder with a space in its name. `--only` still takes a `.gitignore` pattern, so
  `--only logo.png` names every `logo.png` in the project. The MCP server's `optimize` tool takes `images` too.
- An image named with `--image` converts even when no line names it yet, as a new image the extension converts
  the moment it arrives: its original goes once no file names it, as any other's, and stays with `--keep-originals`.
  One that a file names in a way Upfly cannot rewrite is still left as it is. A run over the whole project, or one
  `--only` names, still converts only images whose references move.
- An error line about one file names it in `file`: the config written as code with `CODE_CONFIG_NOT_RUN`, the config
  found with `CONFIG_EXISTS` or `V2_EXTENSION_CONFIG`, the instruction file with `UPFLY_BLOCK_UNCLOSED`.
- A dry run of `optimize`, `dedupe` or `move` lists in `applyRefusals` each of its notes that says what `--apply`
  would refuse, with the reason it would stop with, such as `UNCOMMITTED_CHANGES`.
- `undo --list --json` gives each changed line's whole `text`, before the run and as the run left it.
- `optimize --json` gives `planHash`, a hash of the plan's conversions and rewrites, and `optimize --apply
  --expect-plan <hash>` writes only that plan: when a file changed after the dry run and the plan differs, it
  refuses (`PLAN_CHANGED`) and writes nothing.

### Fixed

- `undo` said "1 file(s) changed since this run" and "The backup of 1 removed original(s) is gone"; it counts in
  words now.
- The audit report's own text, in `.upfly/audit.txt` and in `--include-text`, said ".upfly/audit.txt lists them" of
  the unused images, though `--include-text` writes no file; it says "this report lists them".
- On a project of about 40,000 files, the progress dots stopped for about 1.8 s while Upfly matched each reference to
  its file. That work now runs in pieces, and I measured the pause at about 0.55 s; the plan `audit` and `optimize`
  make afterwards still pauses for about 1.3 s. A run there also peaks about 180 MB lower in memory, since a
  reference found no longer keeps its file's whole text.

## 3.2.0

Undoing part of a run, and what the Upfly VS Code extension, which I am rebuilding on Upfly 3, needs from the CLI;
and fixes to 3.1.0. No command, option or JSON field of 3.1.0 was removed or renamed.

### What is new

- `upfly undo --file <path>` puts back only what the last run did to one file, and adding `--line <n>` only the
  changes on that line, leaving the rest of the run in place. An original that a put-back line names again comes
  back from the run's backup, and a moved image is copied back. What the run created stays until the whole run is
  undone, since other lines may still name it, and `upfly undo` afterwards still puts back every byte. A file changed
  since the run, or since its last partial undo, is refused as the whole undo refuses it.
- `upfly undo --list` shows what the last run changed, line by line, what of it is undone, and whether each removed
  original is back; with `--json`, in `run`. It changes nothing.
- `audit --json --include-images` lists every image with its size, each reference to it at its file and line, and
  the findings that name it. `--include-text` adds the report as text, as `.upfly/audit.txt` holds it, without
  writing the file.
- `--no-code-config`, on every command, runs no `upfly.config.ts` or `.js`: a command that would have to stops and
  names the file. `upfly.config.json` is still read.
- `upfly.config.json` takes a `watch` part, the settings of the Upfly VS Code extension (`folders`, `skip`,
  `keepOriginals`, `outside`). The commands check it and act on none of it.
- `optimize --json`, and the savings in `audit --json`, say for each conversion whether its original is in a folder
  the site is served from (`inPublicDir`), the originals a link from outside the project can name. Each edit says
  which image it names (`asset`).

### Fixed

- On Windows, `optimize --apply` stopped with "unable to open for write" when the copy of a converted image staged
  under `.upfly/runs/` passed 259 characters, as it can in a project several folders deep. The encode is now written
  by Node, which handles such a path.
- `check --changed` kept a broken path in a file the change never touched when only its file name matched a file the
  change deleted. It now keeps such a path only when it named the deleted file.
- `audit` called an image unused when only a database or a compiled file (`.db`, `.sqlite`, `.wasm`, `.node`, `.bin`,
  `.swf`) named it, though the search before `optimize` removes an original reads those files. It reads them too
  now, and `move`'s caveat counts them among the files that may name an image.
- A Python environment (`venv`, `.venv`, `site-packages`, `__pycache__`) is left out of the walk, as `node_modules`
  is, so its packages' images and files are no longer read as the project's.
- `__MACOSX`, the folder of macOS metadata a zip can hold, is left out of the walk.
- A reason in the full plan that holds more than one sentence now ends with a full stop.
- The README's command for adding the MCP server to Claude Code failed in PowerShell, which drops a bare `--`. It now
  gives the form PowerShell passes whole.
- The test that runs every command with the network cut off now runs `move` as well.

### Changed

- A run's record, `.upfly/manifest.json`, stays at version 1, which 3.1.0 reads, until part of a file is undone on
  its own; it then says version 2, which 3.1.0 refuses to undo rather than misread. Undo such a run with 3.2.0.

## 3.1.0

Moving images with their references, every line that names an image, and pointing a project's coding agents at
Upfly; and fixes to 3.0.0, among them two cases where it removed an original a page still used. No command or option
of 3.0.0 was removed.

### What is new

- `upfly move <from> <to> [dir]`: moves an image, or each image in a folder, and rewrites every reference Upfly can
  rewrite to name the new place, in the form it was written in. A `<to>` that is a folder, or ends in a slash, takes
  the image in under its own name. Like `optimize`, it shows the plan unless run with `--apply`, takes `--commit`,
  and `upfly undo` puts every file back. Every other line that still names an old path is listed with the reason
  Upfly leaves it as written, and the plan counts the lines a page still loads the image through: those break unless
  you change them by hand. A folder move also lists the lines that name the folder itself, such as a build rule that
  copies it. A move Upfly cannot make safely is refused with the reason, such as an image that a path built at
  runtime also matches; when every move asked for is refused, it exits 3. It deletes no image.
- `upfly refs <image>` lists every line that names the image, not only its references. After the references comes
  "Not followed": each other line a search for the image's path finds, in any letter case, with why Upfly does not
  follow it (a full address, a path built at runtime, a value in data or a component's props, a file type Upfly does
  not read, a comment). A line that names another file of the same name is in neither list. The search reads the
  files `--exclude` and `.upflyignore` leave out too. An image named only in such lines is possibly unused, not
  unused.
- `upfly init --agents` points a project's coding agents at Upfly. It adds a short marked block to `AGENTS.md`
  (created when there is none) and to a `CLAUDE.md` or `GEMINI.md` already there, and puts the Upfly Agent Skill in
  `.agents/skills/upfly` and `.claude/skills/upfly`. It changes nothing outside its block, keeps a config file that
  exists, asks nothing, and a second run changes nothing. A plain `upfly init` now ends with a line saying how to run
  it.
- `upfly-mcp`, a package of its own: an MCP server for apps that reach tools only through MCP, such as Claude
  Desktop. `npx -y upfly-mcp <folder>` serves seven tools, one for each of `audit`, `check`, `refs`, `optimize`,
  `dedupe`, `move` and `undo`; each runs its command with `--json` and answers with the line the command prints
  last. A tool that writes does so only when a call sets `apply`, and refuses what the command refuses. No tool runs
  `init` or takes `--allow-dirty`. Installing `upfly` does not bring the MCP server with it.
- `upfly check` is a guard you set up: `check.failOn` in the config, or `--fail-on` in a workflow, chooses what fails
  it, from `broken`, `too-large` and `possibly-broken`; `--warn` lists everything and exits 0. Unset, it fails on
  what 3.0.0 failed on. It also lists, apart from its findings, image paths in code or data that name no file, such
  as a photo in a component's list of people: strings Upfly does not read as references, so it cannot tell whether a
  page shows them. Where one names an image in another letter case, it says so: that path loads on Windows and macOS
  and breaks on a Linux server. An unused image never fails the check.

### Fixed

- `optimize` no longer removes an original that a file Upfly does not read names percent-encoded or with HTML
  character references, such as `/img/a%20b.png` in a Vue template: the page lost its image while the run reported
  success. It also keeps every original such a line names, where 3.0.0 could remove some of the images named on one
  line, such as a `srcset`'s. (3.0.0 too.)
- `optimize` keeps an original that a site's database names, such as `<img src="/img/a.png">` in a page stored in
  a `.db` or `.sqlite` file: 3.0.0 never read those files, and removed it. Any file that is not text, a database or
  a compiled module among them, is now searched for an image's path as its bytes; `refs` lists such a line under
  "Not followed", and `move` as one a page may load the image through. Video, audio, fonts, icons, PDFs, office and
  design documents and archives are still left unread.
- `audit` and `optimize` no longer run out of memory on a project that holds large compiled files, such as a Python
  environment's libraries: a file that is not text is read a megabyte at a time. (3.0.0 too.)
- On Windows, `audit` and `optimize` no longer stop without a word (exit code `0xC0000409`) on a project holding an
  empty file, a Git LFS pointer or other text under an image's name. (3.0.0 too.)
- `--commit` commits every file the run wrote: a tracked file inside a folder git ignores made the commit fail after
  the run had written (3.0.0 too), and a page renamed only in letter case, which 3.0.0 refused, is now committed under
  the name git records. Upfly checks the commit before it reports it.
- With `--commit`, a run that would write inside a git submodule is refused before anything is written (exit 3,
  `IN_SUBMODULE`, naming the `--exclude` that leaves it out), where it used to write and then fail with git's own
  message (exit 4).
- `npm install upfly` and `npx upfly` install Upfly 3 on every Node.js: on Node.js 18 to 22.17, or 23 to 24.10,
  npm picked Upfly 2, the Express middleware, since 3.0.0 declared a Node.js range they were outside. Upfly runs on
  Node.js 22 or later; an older one gets one line naming the version it needs, and exit code 2.

### What changed

- On a terminal, the progress line names the stage at work, such as "reading 52557 files" or "working out what
  optimize would save", where 3.0.0 named the stage just finished, and one to three dots move beside it, so a long
  stage shows the run is alive. Piped, in CI and with `--json`, the output is the same as before. When `audit`,
  `check`, `init` or `refs` fails unexpectedly, its message starts on a line of its own.
- Measuring starts the next image as soon as any finishes, four at a time as before, where it waited for the
  slowest of each group of four. The terminal's measuring line counts every image.
- `optimize --apply` converts up to four images at a time, as measuring does. When more than one conversion fails,
  the error reported is the one for the image that comes first in the plan, whichever failed first.
- `optimize` measures only the images it could convert. An image no conversion of would be used, such as one nothing
  links to, is no longer encoded: its reason needs no measurement. The full plan's "What Upfly could not check"
  counts these images, as `audit` does.
- A path written inside a comment is rewritten with the references, by `optimize` and `move`, so no comment is left
  naming a file that has gone. A comment never by itself makes an image convert or move. The plan shows each such
  edit beside its file and counts them apart from the references. A path a comment writes percent-encoded or with
  character references keeps its spelling: `/img/a%20b.png` becomes `/img/a%20b.webp`.
- A reason that cites a line naming an image says what kind of place it is: a comment, a code example, a page's
  text, a file type Upfly does not read, a path built at runtime. An unused image that something names says where:
  "nothing links to it, and index.html:17 names it in a comment, which no page loads", where 3.0.0 said "something
  we could not read mentions it".
- An image whose name ends in the target format while its bytes are another format, such as a `.webp` file that
  holds a PNG, says so, where 3.0.0 gave "another reason, in the full plan".
- `optimize`'s Leave row counts unused images the way `audit` does, so both commands give the same number.
- When the folder the site is served from is named, with `--public` or `publicDirs`, and few root-relative
  references resolve there, Upfly no longer asks for the folder: `check` lists each reference that names no file
  there and exits 1, `audit` lists them as broken, and `optimize` still refuses, pointing at `check`.
- With `--commit`, a run in a repository part way through a merge, a rebase, a cherry-pick or a revert is refused
  before anything is written (exit 3), since its commit would become part of that operation. 3.0.0 wrote the run,
  then failed to commit it (exit 4).
- Printed commands read as you run Upfly: `npx upfly …` from a project install, `upfly …` for a global install.
- References to images that do not exist are listed by file, then line, in `check`, `audit` and the report file.
- `upfly undo` also puts moved images back, and says how many.
- `AGENTS.md` says what to do for every `reason` an error line can carry, and covers `move`, `check` as an optional
  guard, `init --agents` and `upfly-mcp`. The Agent Skill no longer assumes Upfly is installed in the project. Both
  say that a go-ahead in the task is the user's yes to apply, after which the agent names the originals removed, and
  that an agent commits Upfly's changes only when asked for a commit.

### What a script reading `--json` must know

- `move.json` is new, for `upfly move`.
- `refs.json` requires `unfollowed`: each line with `file`, `line`, `text`, `reason`, `why` and `loads`, and `host`
  for a full address. `unsearchable` lists the files the search could not read, when there are any.
- `loads`, on each unfollowed line of `refs` and `move`: whether a page can still load the image through the line,
  so a move breaks it unless it is changed by hand. It is false only where Upfly read the place and found that
  nothing loads it: a comment, a code example, a page's text.
- An unfollowed line's `reason` can be `folder`: a line that names a moved folder, or a path inside it, rather than
  an image.
- An edit in `optimize.json`, and so in `move.json`, can carry `inComment: true`: a path inside a comment, which is
  not a reference.
- `check.json` requires `failOn` and `possiblyBroken` (`paths`, each with an optional `note`, then `leftOut` and
  `unlisted`). `fewResolved` is present when a named folder resolves few references.
- `init.json` gains `agents` with `--agents`; `file` and `config` are null when a config file was kept.
- `undo.json` requires `moved`, the images a run had moved, put back.
- `config.json` accepts `check.failOn`. `events.json`'s command names gain `move`.
- New error `reason`s: `MOVE_REFUSED`, `GIT_OPERATION_IN_PROGRESS` and `UPFLY_BLOCK_UNCLOSED`.
- The report's broken findings within one file come in line order; they came in the order of the paths as written.

### For the library

- `runPipeline`'s `onProgress` gets a `measuring` event for every image, where it got one for every twentieth.
- `optimizeProject` measures only the images it could convert; the plan is the same.
- `Edit` gains `inComment`, and an `OptimizationPlan`'s rewrites can hold edits inside comments.
- `FileStore` gains `readForSearch(path)`, the read the search before a delete makes: a file's text, or the bytes of
  a file that is not text, a chunk at a time. A store you wrote yourself must add it; answering with the file's text,
  as `readText` does, satisfies it. `createNodeFileStore` has it.

## 3.0.0

**3.0.0 is a different product from 2.x, under the same name.**

- **2.x** is an Express and Multer middleware: it converts images as a server receives them in an upload.
- **3.0.0** is a command-line tool, `upfly`, and the library under it, `upfly-core`. They work on a repository:
  they find the images and the references to them in the files they can read, convert the images to WebP or AVIF,
  and update every reference they can prove, naming each one they cannot. Nothing is written without `--apply`.

Nothing from 2.x carries over: no option, no API, no code. If you use the middleware, stay on 2.x:

```bash
npm i upfly@2
```

### What 3.0.0 holds

The commands:

- `upfly audit`: the images, the references to them, the references that point at nothing, the images nothing
  references, and what `upfly optimize` would convert and save with the same options, measured by encoding the
  images it could convert. It changes no file in the project.
- `upfly optimize`: the plan for converting images and updating their references, which `--apply` carries out.
  `--apply` refuses to write over uncommitted changes, so the run's changes are the only ones to review, and
  `--commit` makes them one commit. Each original is removed once every reference to it has moved and no file Upfly
  reads still names it; the dry run says how many go. `--keep-originals`, or `publicPolicy` in the
  config file, keeps them beside the converted files.
- `upfly undo`: puts back every file the last applied run changed, after checking that none was edited since.
- `upfly check`: for continuous integration. It fails when a reference names an image that does not exist, or,
  with a limit in the config, an image in use is larger than it. `--changed [ref]` keeps only what a change
  could have caused.
- `upfly refs <image>`: every reference to one image, whether `optimize` could rewrite each, and what it would do
  with the image.
- `upfly dedupe`: for each set of identical images, keeps one copy and points the references to the others at it.
  It deletes no file.
- `upfly init`: writes `upfly.config.json` with the folders the site is served from, as Upfly works them out, and
  why.

`audit`, `optimize` and `dedupe` print a short summary and keep it, with every list in full, in a file named after
the command (`.upfly/audit.txt`, `.upfly/optimize.txt`, `.upfly/dedupe.txt`), which git is told to ignore: each
image to convert, each reference left alone and each original kept with its reason, each unused image, each broken
reference. `--full` prints the file, and `--show <row>` prints one row of it with its list.

For programs and coding agents:

- `--json` on every command: one JSON object per line, progress first and the result last. The package ships a
  JSON Schema for each command's result, for the report inside it, for every other line, and for the config file,
  in `schema/`.
- `AGENTS.md`, a guide for coding agents, and an Agent Skill in `skill/upfly`, which an agent loads when a task
  touches the project's images.

And:

- The accuracy suite, in `accuracy-suite/` in the repository: a project of image references and the decoys
  beside them, each with its expected answer written down before the engine ran. `pnpm accuracy:measure` runs it.
- No network calls and no telemetry, in the library and the command-line tool alike.
- Node.js 22.18 or later (on Node.js 24, 24.11 or later), as ES modules.
