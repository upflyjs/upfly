---
name: upfly
description: Convert a project's images to WebP or AVIF and rewrite the references to them without breaking the site; find where an image is used; tell whether an image is safe to delete; find broken image paths and identical copies. Use when a task touches the project's image files, such as optimizing or converting images, or finding unused, missing or duplicate images.
---

# Upfly

Upfly knows where a project's images are used. It converts them and rewrites the
references in one step that can be undone, reports every reference it cannot follow, and
never deletes an image that nothing uses. By default it removes a converted image's
original once no file it reads still names it, wherever the image sits; `--keep-originals`
keeps every original. It makes no network calls.

Run it as `npx upfly <command>` in the project folder. The full guide is
`node_modules/upfly/AGENTS.md`.

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
3. Only with the user's yes: `npx upfly optimize --apply --commit`. When asking, say that
   the originals the summary counts are removed, so a link to one from outside the project
   (an email, another site, a CMS) stops working, and that `--keep-originals` keeps them.
4. Run the project's own build, then `npx upfly check`.
5. If anything is wrong: `npx upfly undo` puts every file back.

Do not add `--allow-dirty` or `--keep-originals` unless the user asks for it.

## When Upfly stops

Exit code 3 means Upfly refused to act, for safety. Read its `message`, which says what
to do; with `--json`, `reason` names the case. For `SERVING_ROOT_UNKNOWN`, ask the user
which folder the site is served from and pass it with `--public <dir>`.

## Other commands

- `npx upfly audit --json`: the whole project's report, which can be large.
- `npx upfly check`: exits 1 when a reference names an image that does not exist.
- `npx upfly dedupe`: plans pointing references to identical copies at one copy. Apply
  it only with the user's yes, as `npx upfly dedupe --apply --commit`; it deletes nothing.
- `npx upfly init`: writes `upfly.config.json` with the folders the site is served from.
  Show the user the file.
