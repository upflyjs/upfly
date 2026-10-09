---
name: upfly
description: Convert a project's images to WebP or AVIF and rewrite the references to them without breaking the site; move or rename an image with its references updated; find every line that names an image; tell whether an image is safe to delete; find broken image paths and identical copies. Use when a task touches the project's image files, such as optimizing, converting, moving or renaming images, or finding unused, missing or duplicate images.
---

# Upfly

Upfly knows where a project's images are used. It converts them and rewrites the
references in one step that can be undone, reports every reference it cannot follow, and
never deletes an image that nothing uses. By default it removes a converted image's
original once no file it reads still names it, wherever the image sits; `--keep-originals`
keeps every original. It makes no network calls.

Run it as `npx upfly <command>` in the project folder. When Upfly is installed in the
project, the full guide is `node_modules/upfly/AGENTS.md`.

## One image: where is it used, and can it go?

Run `npx upfly refs <image> --json`. It lists each reference (`file`, `line`, the path as
written), every other line that names its path in `unfollowed`, each with `why` Upfly does
not follow it, and gives a `verdict`. Read both lists before changing the image: Upfly
leaves the lines in `unfollowed` as written.

- Any entry in `references` means the image is used.
- An entry in `unfollowed`, such as a full address, may be a use too.
- `possibly-unused`: its name appears in the places listed in `mentions`. Read them.
- `unused`: no reference Upfly can read names it. That is not proof: a path built at
  runtime, or a link from outside the repository, can still reach it.

Upfly never deletes an image that nothing uses; deleting one is the user's decision.

## Converting images

1. `git status --porcelain` must print nothing. If it does, ask the user to commit or
   stash first; Upfly refuses to write over uncommitted changes.
2. `npx upfly optimize` changes no project file and prints a summary of the plan. Show it
   to the user; the full plan is then in `.upfly/optimize.txt`. Icons, a web app manifest's
   images and link previews keep their format on their own. An image in an email does
   not, and Outlook shows no WebP: offer to leave a folder of email templates out with
   `--exclude <path>`.
3. Only with the user's yes: `npx upfly optimize --apply`, adding `--commit` only when the
   user asks for a commit. A go-ahead in the task is that yes: apply without asking again,
   and say in your answer which originals were removed (`.upfly/optimize.txt` lists them).
   Without one, ask, and say that the originals the summary counts are removed, so a link
   to one from outside the project (an email, another site, a CMS) stops working, and that
   `--keep-originals` keeps them.
4. Run the project's own build, then `npx upfly check`.
5. If anything is wrong: `npx upfly undo` puts every file back.

Do not add `--allow-dirty` or `--keep-originals` unless the user asks for it.

## Moving or renaming an image

Use `npx upfly move <from> <to>` rather than moving the file yourself: it updates the
references too. Without `--apply` it only shows the plan. In its `--json`, read
`plan.refused`, `plan.declined` (references that will break) and `plan.unfollowed` (lines
it leaves as written), show them to the user, and only with their yes run
`npx upfly move <from> <to> --apply`, then the build and `npx upfly check`. As for
converting, a go-ahead in the task is that yes, and `--commit` is added only when the user
asks for a commit.

## When Upfly stops

Exit code 3 means Upfly refused to act, for safety. Read its `message`, which says what
to do; with `--json`, `reason` names the case. For `SERVING_ROOT_UNKNOWN`, ask the user
which folder the site is served from and pass it with `--public <dir>`.

## Other commands

- `npx upfly audit --json`: the whole project's report, which can be large.
- `npx upfly check`: an optional guard. It exits 1 when a reference names an image that
  does not exist, and lists apart, without failing, image paths in code or data that name
  no file; `check.failOn` in the config chooses what fails it.
- `npx upfly dedupe`: plans pointing references to identical copies at one copy. Apply
  it only with the user's yes, which a go-ahead in the task gives, as
  `npx upfly dedupe --apply`, adding `--commit` only when the user asks for a commit; it
  deletes nothing.
- `npx upfly init`: writes `upfly.config.json` with the folders the site is served from.
  Show the user the file. `npx upfly init --agents` also points the project's agents at
  Upfly; it keeps a config that exists.
