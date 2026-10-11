# Evidence

What Upfly's accuracy and safety claims rest on: how each was measured, the full results and what each result does
not show, then every limit in full. The [README](README.md) quotes them.

## The accuracy suite

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

## Three real projects, converted and built

Fresh clones of three public repositories, each at a pinned commit, run once under each policy: keeping every
original (keep-original, `--keep-originals`) and removing each original once its references moved (replace, the
default).

| repository | policy | converted | references rewritten | originals deleted | build | image references (broken by the run) | second run |
|---|---|---|---|---|---|---|---|
| eleventy-docs | keep-original | 17 | 17 in 12 files | 0 | passes | 7,067 (0) | nothing to do |
| eleventy-docs | replace | 15 | 15 in 10 files | 15 | passes | 7,067 (0) | nothing to do |
| railsgirls-com | keep-original | 3,412 | 5,995 in 575 files | 0 | no build | 10,655, 119 already broken (0) | nothing to do |
| railsgirls-com | replace | 3,208 | 5,348 in 570 files, and 862 paths inside comments | 3,203 (5 kept, with reasons) | no build | 10,655, 119 already broken (0) | nothing to do |
| scratch-www | keep-original | 183 | 214 in 56 files | 0 | passes, no file put back | 750, 52 already broken (0) | nothing to do |
| scratch-www | replace | 182 | 213 in 55 files | 182 | passes, no file put back | 750, 52 already broken (0) | nothing to do |

Every applied run made exactly one commit, no run broke a single image reference (18,472 checked across the three,
comments aside), and every second run found nothing to convert, rewrite or delete.

- **What was run:** for keep-original, `upfly optimize --apply --commit --keep-originals`; for replace, `upfly
  optimize --apply --commit` on a second fresh clone; then the project's own build, where it has one; then a second
  `upfly optimize` on the committed tree. The repositories and their pinned commits are in
  [`bench/src/repos.ts`](bench/src/repos.ts), and [`bench/README.md`](bench/README.md) says how to set them up.
  Measured with Upfly 3.1's code, at commit `91a9cc3`, on 2026-10-11.
- **What moved since the first measurement, with 3.0.0's code (commit `9b71d22`):** under replace, railsgirls-com
  converts 302 more images. 3.0.0 left an image unconverted there while a line it could not rewrite, a path inside a
  comment, still named it; 3.1 updates the comment too (the 862 above), and each of the 302 also has its live
  references rewritten. eleventy-docs' built pages hold 450 fewer image references: 225 of them show the site's
  sponsors, whose avatars the build fetches live from Open Collective, and there is one sponsor fewer now (two
  references a page, a PNG and an AVIF), the same before and after every run. The other figures are unchanged.
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
  possibly unused, never as unused. `refs` and `move` list every line in such a file that names the image, and
  `move` leaves each as written: a page that loads the image through one breaks unless it is changed by hand, which
  `move` says. `check` does not read those files either, so it does not see such a line.
- **A full address is never rewritten, even one on the site's own host,** such as
  `https://example.com/img/logo.png`: Upfly cannot tell which host is the site's own, and an address on another site
  can end in the same path. `refs` and `move` list each one that names the image, and `move` says when a page loads
  the image through it.
- **Detection without a config file is tested on JavaScript projects only.** For any other site, `npx upfly init`
  tests the site's own root-relative image paths against each folder and writes the one they resolve under: on
  railsgirls-com, a plain HTML site, it writes `"publicDirs": ["."]`, from 1,268 of 1,268 paths. Any site can also
  name its website folder with `--public <dir>`, or in `upfly.config.json`.
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
- **`check` lists only the possibly broken paths that start with `/`:** a string in code or data that ends in an
  image extension and names no file is listed when it starts with `/`, as a path on the site does. The others are
  counted in one sentence, and `npx upfly audit --include-discarded` lists them. Of 27 such strings read one by one across
  seven projects, 14 of the 15 that start with `/` were image paths a page could load, against 1 of the 12 that do
  not; so a missing image written without the `/` is counted, not listed.
- **The first `optimize` on a large site takes a while:** it measures each image it could convert before converting
  it. An image it would not convert, such as a vector, an icon that keeps its format or an image nothing links to,
  is not measured.
