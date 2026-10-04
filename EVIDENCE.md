# Evidence

What Upfly's accuracy and safety claims rest on: how each was measured, the full results and what each result does
not show, then every limit in full. The [README](README.md) quotes them.

## The accuracy suite

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

## Three real projects, converted and built

Fresh clones of three public repositories, each at a pinned commit, run once under each policy: keeping every
original (keep-original, today's `--keep-originals`) and removing each original once its references moved (replace,
today's default).

| repository | policy | converted | references rewritten | originals deleted | build | image references (broken by the run) | second run |
|---|---|---|---|---|---|---|---|
| eleventy-docs | keep-original | 17 | 17 in 12 files | 0 | passes | 7,517 (0) | nothing to do |
| eleventy-docs | replace | 15 | 15 in 10 files | 15 | passes | 7,517 (0) | nothing to do |
| railsgirls-com | keep-original | 3,412 | 5,995 in 575 files | 0 | no build | 10,655, 119 already broken (0) | nothing to do |
| railsgirls-com | replace | 2,906 | 4,413 in 560 files | 2,900 (6 kept, with reasons) | no build | 10,655, 119 already broken (0) | nothing to do |
| scratch-www | keep-original | 183 | 214 in 56 files | 0 | passes, no file put back | 750, 52 already broken (0) | nothing to do |
| scratch-www | replace | 182 | 213 in 55 files | 182 | passes, no file put back | 750, 52 already broken (0) | nothing to do |

Every applied run made exactly one commit, no run broke a single image reference (18,922 checked across the three,
comments aside), and every second run found nothing to convert, rewrite or delete.

- **What was run:** for keep-original, `upfly optimize --apply --commit`, which kept every original at commit
  `9b71d22` (today, `upfly optimize --apply --commit --keep-originals`); for replace, `upfly optimize --apply
  --commit --replace` on a second fresh clone (today's default, which `--replace` still names); then the project's
  own build, where it has one; then a second `upfly optimize` on the committed tree. The repositories and their
  pinned commits are in [`bench/src/repos.ts`](bench/src/repos.ts), and [`bench/README.md`](bench/README.md) says how
  to set them up. Measured with the CLI at commit `9b71d22`; the commits since change how some reasons are worded,
  what the terminal and the report files print, which policy runs when none is named, which images `audit` measures,
  which folder of a built Hugo, Gatsby or Hexo site is read, and that the original of an image a build loads is
  removed too. None of the three projects has such a folder or converts such an image (every original converted in
  them sits in a folder the site is served from), and none of the rest changes what `optimize` converts, rewrites or
  removes under a named policy.
- **The link check** reads every HTML, CSS and JavaScript file of the built site (or of the source, for a site with
  no build) and asks whether each image path names a file that exists, letter case included, as a Linux server
  would. It skips external URLs and anything inside an HTML or CSS comment, which no browser loads. "Broken by the
  run" is every reference broken after the run that was not broken before it. This check is a script outside this
  repository, not yet published.
- **railsgirls-com ran with its website folder named, `--public .`.** A plain HTML site has no project file, so
  Upfly finds no website folder by itself, and it then removes no original.
- **The builds ran on the Node.js version each project needs:** eleventy-docs on 22.23.3, scratch-www on 20.20.2.
  Upfly itself ran on Node.js 22.14.
- **Two of the five repositories Upfly is tested on were left out:** astro-docs cannot install at its pinned commit
  (its lockfile pins a preview build that is no longer served), and shadcn-ui's build rewrites tracked source files,
  so before and after would not compare like with like.
- **What this does not show:** three projects, at these commits, under these conditions; it does not certify a
  fourth. The link check does not read JSON or Markdown. A passing build is a weaker check than the link check, since
  most image paths are not resolved by a build; both are reported.

## Images Upfly might call unused when they are not

> Across five repositories, an independent search for every image file name found 3,485 mentions the engine did
> not link. 684 were adjudicated, all 384 in the four smaller repositories and a random 300 of railsgirls-com's
> 3,101, and none was an image Upfly would call unused.

Its blind spots, which go with it:

1. **It searches file names.** An image alive with no string naming it (a framework's file convention, a
   build-config glob, a path assembled at runtime) is invisible to it exactly as to the engine.
2. **0 of 300 is not 0 of 3,101.** A zero in a random 300 is consistent with up to 29 of railsgirls-com's 3,101 being
   misses, at 95% confidence (exact, for a sample drawn without replacement).
3. **It matches base names,** so it over-reports (a hit for each copy sharing a name) and cannot hide a miss.
4. **The verdict is about the image, not the line.** 456 of the 684 name an image the engine links from elsewhere, so
   a line naming a linked image is not a miss by this measure; whether each line still loads after a run is what
   the link check above measures. 278 of the 684 name SVGs, which Upfly neither converts nor deletes.

`pnpm validate` over the five pinned repositories produces the mentions; the 300 were drawn with seed `20261001`.
The two scripts that drew the sample and judged each mention are outside this repository, not yet published.

## Limits in full

- **File types Upfly does not read yet:** Vue, Svelte, PHP, ERB, Liquid, Nunjucks and YAML frontmatter. A reference
  only they hold is not seen. The audit names each file it could not read, and an image named in one is reported as
  possibly unused, never as unused.
- **Zero configuration is tested on JavaScript projects only.** Any site can name its website folder with
  `--public <dir>`, or in `upfly.config.json`.
- **An image the build loads converts only for Vite, Next.js and Astro**, which load WebP and AVIF by themselves.
  Under any other build (webpack, Rollup, esbuild, Parcel, or one Upfly cannot name), such an image keeps its format,
  and the plan says why: fewer conversions, never a broken build.
- **A stylesheet with a syntax error is not read.** A browser skips the one declaration it cannot read and reads the
  rest; Upfly reads none of that file, so an image only it names is reported as possibly unused, never as unused, and
  the report names the error and its line.
- **A site already built by a tool Upfly does not know may have its output read as source.** Upfly skips the folders
  only a tool writes (`dist`, `build`, `_site` and others) and `public/` beside Hugo's, Gatsby's or Hexo's own
  settings file. For anything else, run Upfly before building, or leave the output out with `--exclude <folder>/`.
- **A reference Upfly cannot read keeps working only while the original stays**: one in a file type it does not
  read, such as an email template, or outside the repository, such as an email already sent or another site.
  Removing originals, the default, breaks those references; `--keep-originals` keeps every original.
- **`optimize` measures every image before converting it**, so the first run on a large site takes a while.
