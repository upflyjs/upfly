# Using Upfly from a coding agent

Upfly finds every image in a project and the places the project refers to one in the files
it reads, converts images to WebP or AVIF, and rewrites the references, reporting each one it
cannot rewrite safely. It never deletes an image that nothing uses. By default it removes a converted
image's original once no file it reads still names it, wherever the image sits;
`--keep-originals` keeps every original. It makes no network calls and sends nothing
anywhere.

In a project that has Upfly installed, run it as `npx upfly <command>`. Every command
reads the folder given after it, or the current folder, and prints plain text; add
`--json` for output a program can read.

## Where to start

- One image: `npx upfly refs <image> --json`. It lists every reference to that image
  (file, line, the path as written, whether a run could rewrite it), then in `unfollowed`
  every other line that names its path, which Upfly does not follow, each with `reason`
  and `why` (a full address, a path built at runtime, a value in data or props, a file type
  Upfly does not read, a comment), and a verdict: what `upfly optimize` would do with it,
  or that it is unused. It is the small answer, and the right one for a question such as
  "is it safe to delete this image?". Read both lists before changing an image: Upfly
  leaves each line in `unfollowed` as written, so a move or a rename has to change those
  by hand, and a `full-address` line may be the site's own address.
- The whole project: `npx upfly audit --json`. It changes nothing. The report can run to
  megabytes on a large project; `--no-probe` skips measuring the images and is much
  faster when only the references matter. Its `savings` is what `upfly optimize` would
  convert and save with the same folder, options and config: `savedBytes` across `images`,
  each listed in `conversions`. When `unmeasured` is above 0, the run measured only the
  largest of the images optimize could convert, so optimize converts and saves at least
  that much; `--probe-all` measures them all. `report.summary.potentialSavingBytes` is a
  different number: every image measured smaller, including ones optimize would not
  convert. Quote `savings`.

## Converting images, safely

1. Check that the project folder has no uncommitted changes (`git status --porcelain`
   prints nothing). Upfly refuses to write otherwise, so that its changes are the only
   ones to review. If there are changes, ask the user to commit or stash them.
2. Run `npx upfly optimize`. It changes no project file and prints a short summary of the
   plan: how many images convert and how much smaller they get, how many references
   change, and how many images are left alone, counted by reason. Show the user that
   summary, and its notes. The full plan is then in `.upfly/optimize.txt`: the same rows,
   each with its complete list, such as each image and reference left alone and the
   reason for each (`--show leave` prints that row alone); `--json` holds the whole plan. The
   plan leaves alone an image that a browser, a phone or another site reads outside the
   page (an icon, a web app manifest's images, a link preview's image), since some of them
   show no WebP. It cannot tell which images an email uses, and Outlook shows no WebP: if
   the project holds email templates, offer to leave their folder out with
   `--exclude <path>`.
3. Only when the user says yes: `npx upfly optimize --apply`. A go-ahead in the task, such
   as "convert the images, you can change the files", is that yes: apply without asking
   again, and say in your answer which originals were removed (`.upfly/optimize.txt` lists
   them). Without one, ask, and say how many originals the summary says are removed, that
   a link to one from outside the project (an email, another site, a CMS) then stops
   working, and that `npx upfly optimize --apply --keep-originals` keeps every original
   beside its converted file. Add `--commit` only when the user asks for a commit: the
   run's files then go into one commit, which `git revert` undoes.
4. Check the result: run the project's own build if it has one, then `npx upfly check`,
   which fails if any reference names an image that does not exist.
5. To go back: `npx upfly undo` puts back every file the last run changed. After
   `--commit`, the commit stays in the history and the restored files show as uncommitted
   changes; `git revert <commit>` is the other way back.

Leave these to the user: `--allow-dirty` (writing over uncommitted changes),
`--keep-originals` (keeping each original beside its converted file), and `--format avif`.
Never edit `.upfly/`: it is the record `upfly undo` follows.

## Moving or renaming an image

Use `npx upfly move <from> <to>` rather than moving the file yourself: it moves an image,
or each image in a folder, and points every reference Upfly can rewrite at the new place,
in the form it was written. A destination that is a folder, or ends in a slash, takes the
image in under its own name. It changes no project file unless run with `--apply`; read
the plan first, which `--json` holds:

- `plan.refused`: each move Upfly will not make, with its reason, such as a destination
  that already holds a file. When every move is refused it exits 3, `reason` `MOVE_REFUSED`.
- `plan.declined`: references to the image that cannot follow it, each with `why`. The
  image still moves, so each of these breaks unless changed by hand.
- `plan.unfollowed`: every other line that names the old path, such as a full address or
  a comment, each with `reason` and `why`. Upfly leaves them as written.

Show the user those lists, and only with their yes run
`npx upfly move <from> <to> --apply`. As with `optimize`, a go-ahead in the task is that
yes, and `--commit` is added only when the user asks for a commit. Then run the project's
build and `npx upfly check`; `npx upfly undo` puts every file back. It deletes no image.

## Is it safe to delete an image?

Run `npx upfly refs <image> --json` and read the verdict.

- Any entry in `references` means it is used: each names the file and line.
- An entry in `unfollowed` names its path where Upfly does not follow it, such as a full
  address in a page's metadata. Treat it as a use until a person has looked.
- `possibly-unused`: no reference Upfly can follow reaches it, but its name appears
  somewhere, listed in `mentions`. Read them before calling it unused.
- `unused`: no reference Upfly can read names it. That is not proof. A path built at
  runtime can still produce its name (the audit report lists those under
  `references.unsafe`), and an image in a folder the site is served from, such as
  `public`, may be linked from outside the repository, by an email or another site.

Upfly never deletes an image that nothing uses. The decision, and the deletion, are the
user's.

## What the words mean

- `broken`: a path written as an image's that points at no file.
- `possibly-broken`, listed by `check`: a string in code or data that starts with `/` as a
  path on the site does and names no file, such as an image in a component's list of
  people. Upfly does not read it as a reference, so whether a page shows it is unknown; a
  page that does shows no image there. A `note` names the image it names in another letter
  case, which loads on Windows and macOS and not on a Linux server.
- `dead`, shown as unreferenced images: nothing references the image, and its name
  appears nowhere Upfly looked.
- `possibly-dead`, shown as possibly unreferenced: nothing Upfly can follow references
  the image, but its file name appears somewhere, such as a file no reader handles or a
  path Upfly could not resolve. The finding's `evidence` says where. Treat it as used
  until a person has looked.
- `dynamic`: a path built at runtime, such as `url($hero)` in a stylesheet. Upfly cannot
  know which file it names.
- `unsafe`: a reference Upfly never rewrites and always reports. The report lists each one
  under `references.unsafe` with its reason: `dynamic` paths, aliases no config Upfly
  reads maps (`unresolved-alias`), and paths into files Upfly leaves alone, such as those
  in `node_modules` (`out-of-scope`). A path into a file the run was told to leave out,
  with `--exclude` or the config's `exclude`, is listed under `references.leftOut`
  instead: nothing is wrong with it.

## Exit codes

| code | meaning |
|---|---|
| 0 | The command ran. What `audit` and `optimize` find does not change it. |
| 1 | `check` found something that fails it. |
| 2 | The command line or the config file is wrong. The message says what. |
| 3 | Upfly refused to act, for safety. The message says why and what to do. |
| 4 | Something failed that Upfly did not anticipate. |

With `--json`, a command that stops prints an error line with `exitCode`, `message`, and
often a `reason` to branch on:

- `UNCOMMITTED_CHANGES`: ask the user to commit or stash, then run again.
- `NO_REPOSITORY`: git does not track the folder. `--commit` needs it; ask the user.
- `NO_GIT_IDENTITY`: git has no name and email to commit with. Ask the user to set them
  with `git config`, or run without `--commit`.
- `GIT_OPERATION_IN_PROGRESS`: the repository is part way through a merge, a rebase, a
  cherry-pick or a revert, and a commit would become part of it. Ask the user to finish or
  abort it, or run without `--commit`.
- `IGNORED_BY_GIT`: git ignores some of the files the run would write, so one commit could
  not hold the run, and nothing was written. When the message names a build's output
  folder, run again with the `--exclude` it gives; otherwise ask the user.
- `IN_SUBMODULE`: some files the run would write are inside a git submodule, which a commit
  of the project holds only as the commit it points at, so nothing was written. Run again
  with the `--exclude` the message gives, or without `--commit`.
- `GIT_COMMIT_FAILED`: the run was applied but git did not commit it, and its files stay
  written. Ask the user whether to commit them, or run `npx upfly undo` to put every file
  back.
- `SERVING_ROOT_UNKNOWN`: Upfly could not tell which folder the site is served from. Ask
  the user, then pass it with `--public <dir>`, or run `npx upfly init` and correct
  `publicDirs` in the file it writes.
- `TRANSACTION_INTERRUPTED`: an earlier run stopped part way. Run `npx upfly undo` first.
- `TRANSACTION_LOCKED`: another run is in progress. Wait for it.
- `TRANSACTION_FOREIGN_CHANGE`: a file changed after Upfly read it, so Upfly will not
  touch it. Tell the user; after a committed run, `git revert` is the other way back.
- `TRANSACTION_PLAN_INVALID`: a check of the run's plan failed, such as a file it would
  create already existing, or a file to edit that is not UTF-8; the message names the file.
  Nothing was written, unless the message says the run stopped part way: then
  `npx upfly undo` puts back what it wrote. Tell the user.
- `MOVE_REFUSED`: `move` refused every move it was asked for; the message names what is in
  the way. Tell the user.
- `CONFIG_EXISTS`: `init` found a config file. Edit that file instead.
- `UPFLY_BLOCK_UNCLOSED`: `npx upfly init --agents` found an instruction file holding
  Upfly's start line with no end line, so it cannot tell where its block ends, and wrote
  nothing. The message names the file; ask the user to remove that line or add the end
  line.
- `V2_EXTENSION_CONFIG`: `upfly.config.json` belongs to the Upfly VS Code extension (v2).
  Leave it alone; this CLI reads `upfly.config.ts` instead, or a JSON config that carries
  the `$schema` line `npx upfly init` writes.
- `MANIFEST_VERSION_UNSUPPORTED`: the last run's record was written by another version of
  Upfly, which `undo` cannot follow. Nothing was changed; undo it with the version that
  wrote it.
- `MANIFEST_UNREADABLE`: `.upfly/manifest.json`, the record `undo` follows, cannot be read,
  so nothing was changed. Tell the user.

## The JSON

With `--json`, stdout carries one JSON object per line and nothing else: progress lines,
then the result, whose `type` is `result`, or an error line, whose `type` is `error`.
The package ships a JSON Schema for each, in `node_modules/upfly/schema/`: one per
command's result (`audit.json`, `optimize.json`, `undo.json`, `check.json`, `refs.json`,
`dedupe.json`, `move.json`, `init.json`), `report.json` for the report inside audit's and optimize's
result, `events.json` for every other line, and `config.json` for `upfly.config.json`.

## In continuous integration

`npx upfly check` is an optional guard. By default it exits 1 when a reference names an
image that does not exist, and, when `check.maxImageBytes` is set in `upfly.config.json`,
when an image in use is larger. It also lists, apart from those findings, image paths in
code or data that name no file (`possiblyBroken` in its `--json`): strings Upfly does not
read as references, so it cannot tell whether a page shows them. `check.failOn` in the
config, or `--fail-on` in a workflow, chooses what fails it, from `broken`, `too-large` and
`possibly-broken`; `--warn` lists everything and exits 0. An unused image never fails it.
On a pull request, `npx upfly check --changed origin/main` keeps only what the change could
have caused (the checkout needs that branch's history).

## Identical copies

`npx upfly dedupe` finds sets of images with the same bytes and plans to point every
reference at one copy of each; `--keep <path>` chooses the copy. It deletes nothing: a
copy no reference names afterwards stays on disk, and `upfly audit` then lists it as
unused. Apply it the way `optimize` is applied: with the user's yes, which a go-ahead in
the task gives, `npx upfly dedupe --apply`, adding `--commit` only when the user asks for a
commit.

## Config

`npx upfly init` writes `upfly.config.json` with the folders the site is served from, as
Upfly works them out, and says why it chose each. Show the user the file: a wrong folder
is the likeliest reason for a wrong result.

## The Agent Skill

The package also ships a short form of this file as an Agent Skill, which an agent loads
when a task involves the project's images. `npx upfly init --agents` puts it in the
project's `.agents/skills/upfly` and `.claude/skills/upfly` folders, where most coding
agents look for a project's skills, and adds a short marked block pointing at Upfly to
`AGENTS.md` (created when there is none) and to a `CLAUDE.md` or `GEMINI.md` already there.
It changes nothing outside that block and asks nothing. The files it names reach the rest
of the team once committed; commit them only when the user asks for a commit.

## Through MCP

For an app that reaches tools only through MCP, such as Claude Desktop, the package
upfly-mcp serves the same commands as an MCP server over standard input and output:
`npx -y upfly-mcp <folder>`. There is one tool for each of `audit`, `check`, `refs`,
`optimize`, `dedupe`, `move` and `undo`, and each runs its command with this CLI as
installed with the server, in the same version. Each takes the command's options as
arguments, as its schema lists them, and answers with the line the command prints last with
`--json`: the same result, or the same error line with its `reason`. `audit`, `check` and
`refs` change no file. `optimize`, `dedupe` and `move` write only when a call sets `apply`
to true, and then refuse what the command refuses; `undo` needs `apply` set to true. No tool
runs `init`, and none takes `--allow-dirty`. A tool reads the folder its call names, and
otherwise the folder the server was started with.

Register it as a server the client starts, giving it the project's folder. In Claude
Desktop's config, and in that of most clients:

```json
{
  "mcpServers": {
    "upfly": { "command": "npx", "args": ["-y", "upfly-mcp", "/path/to/project"] }
  }
}
```

With Claude Code: `claude mcp add upfly -- npx -y upfly-mcp /path/to/project`. On Windows,
a client that cannot start npx itself takes `"command": "cmd"` with `"/c", "npx"` before the
same arguments.
