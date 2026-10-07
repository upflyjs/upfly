# Architecture

This document explains how Upfly works internally. It is written for someone who wants to
change the code: read it before opening a PR. If you find it out of date, that is a bug;
please say so in an issue.

## The problem

Converting an image is trivial: `sharp('hero.png').webp().toFile('hero.webp')`. Dozens of
tools do it.

The hard part is that `hero.png` is *referenced*: from an `import` in a React component, a
`src` attribute in an HTML file, a `url()` in a stylesheet, a `srcset` on a `<picture>`, a
path in a JSON manifest. Convert the file and every one of those references breaks. That is
why most tools either refuse to touch existing files or quietly break builds.

Upfly's job is the second half: **know every place an asset is referenced, and rewrite those
references safely, or refuse, loudly.**

## The pipeline

Everything is a pure function over data except the modules that meet the disk: `discover`
walks it, the `ImageProbe` implementation reads and encodes images, the transaction's file
store writes, and `runPipeline` (`pipeline.ts`) hands the other stages their ports on the real
filesystem. Even `audit` is pure: it takes the graph and the probe's measurements and returns
findings. That is what lets the whole engine be tested without a disk.

`runPipeline` is the one wiring of these stages: `bench/`'s validation and its fixture builds
both call it, so their numbers describe one engine. The accuracy suite resolves its scan under
the same `decideServingRoots` for its unconfigured run. The write path has one wiring too:
`optimizeProject` (`optimize-project.ts`) runs the pipeline with every image measured and hands
its output to `optimize`, and both `upfly optimize` and the fixture builds call it, so what the
builds prove is what users run.

Two stages need one filesystem fact each without being filesystem modules, and both take it as
an **injected port**: `scan` takes `readFile`, and `resolve` takes `exists`. The probe stage takes
the `ImageProbe` port the same way. A port keeps each stage off the disk and unit-testable
against an in-memory map.

```
discover(fs) ──► assets[], sourceFiles[]      images, plus files claimed by an adapter
        │        excludedRoots[]              each pruned directory + the rule that pruned it
        │        skipped[]                    symlinks, unreadable entries, with reasons
        │        unscannedFiles[]             files no adapter claimed, kept with their paths
        ▼
scanSources(sourceFiles, adapters, readFile) ──► rawReferences[], unscanned[]
        │  syntax only: { file, start, end, rawPath, kind, ceiling, asserted }
        │  a file that will not parse becomes a reported entry, never an exception
        ▼
resolveReferences(rawReferences, assets, excludedRoots, exists) ──► references[]
        │  an eight-rung ladder producing one of seven outcomes
        │  final confidence = ceiling if it resolved, otherwise `unsafe`
        ▼
buildGraph(assets, references, unscannedFiles) ──► asset ↔ refs, via isLinked()
        │  byResolution[]         every reference bucketed, so none can be lost
        │  unscannedFiles[]       both sources merged: unclaimed extensions and parse failures
        ▼
probeAssets(assets, probe, formats) ──► dimensions, pages, measured encoded sizes
        │  header reads are free, encodes are not, hence `formats`
        │  outside the 3 s graph budget (see "Performance budget"), reported as its own number
        ▼
audit(graph, probes) ──► findings    dead | possibly-dead / broken / oversized / opportunities
        ▼
planOptimization(graph, …) ──► conversions, rewrites, declined     rewrites `certain` and `high` only
        ▼
optimize(plan) ──► manifest    stage (encode), prepare (check it all), commit (write, edit, remove)
        ▼
buildReport(graph, audit, discovery, sweep, probes) ──► Report
        │  versioned JSON (public API) · every path POSIX-relative · no timestamps
        ▼
renderReport(report) ──► text     numbers, then the SKIPPED list, then findings
```

## Confidence tiers

Every reference carries a confidence, and the planner rewrites only the top two:

| Tier | Means | Rewritten? |
|---|---|---|
| `certain` | Static `import`/`require`, resolved on disk | yes |
| `high` | String literal in a known attribute or function, resolved on disk | yes |
| `medium` | A path with a static prefix and unknown parts (a template literal, a `+` chain), glob-matched against the assets | never: its text is a pattern, not a path |
| `unsafe` | Dynamic concatenation, variable-only paths, unresolvable | **never** |

Both rewritable tiers say *"resolved on disk"*, and an adapter is forbidden from touching a
disk. So confidence is assigned in **two steps**, by two different modules:

1. The **adapter** emits a `ceiling` on a `RawReference`: the best confidence this *syntax*
   could ever justify. A static `import` has a ceiling of `certain`; a runtime-concatenated
   path has a ceiling of `unsafe`.
2. The **resolver** produces a `Reference`, assigning the final `confidence`: the ceiling if
   the path resolved to an asset, `unsafe` if it did not.

Two types rather than one type with mutable fields, because it makes the illegal state
unrepresentable: an adapter cannot hand back something that claims to be resolved.

### Asserted versus speculative

An adapter also marks whether the syntax **asserts** that this is an asset reference.

An `import`, an `<img src>`, a `url()`: the author said so. If one of those does not resolve,
that is a **broken reference** and a real finding; it is how the engine catches a path an agent
hallucinated. But a path-shaped string inside a JSON file is a *guess*: the JSON adapter cannot
know whether `"icons/logo.png"` is an asset path or a translation key, because deciding that
would require resolving it. Those are emitted as **speculative**.

Unresolved speculative references are dropped from the graph rather than reported as broken.
Without that split, auditing any real repository drowns in false findings from `package.json`,
lockfiles and i18n bundles. They are still *counted* in the report, and listable in verbose and
JSON output, because a silent skip is a bug: if the JSON adapter ever eats a real reference, the
user needs a way to find it.

A third standing sits beside these: a path-shaped value an adapter examined and **declined** to
read, such as a tooltip that names an image. It travels as a guess does, marked `declined` with the
reason in its `note`, is never looked up (rung 0 below), and is counted in the report by reason.

### The resolver's seven outcomes

"Resolved or broken" is not enough, and every extra outcome below exists because some real
syntax would otherwise be reported as broken. Zero false `broken` findings is the engine's first
promise, so this is where most of the design pressure lands.

Five cases refuse to fit:

- `import logo from '@/assets/logo.png'` is asserted and will not resolve, because alias
  resolution (tsconfig `paths`, Vite `resolve.alias`) only resolves it when the project actually
  declares that alias and the declaration can be read **statically**. That import is everywhere
  in Next and Vite projects, and what is left over still must not be called broken.
- `url($hero)` never had a static path at all. A literal path pointing at nothing is a real,
  actionable finding; a path the preprocessor builds is simply not knowable, and nobody typed a
  wrong path.
- `` `./images/${name}.png` `` is a *pattern*. Resolved literally it fails; treated as a glob it
  may name a dozen assets, and all of them must be linked.
- `url(inter.woff2)` points at a real file the engine does not track at all.
- A reference into a directory the walk pruned (the common case being a user who put `legacy/`
  in `.upflyignore` while `legacy/` is still referenced) points at a file that really is there.

So the resolver runs a numbered ladder, and **the order is load-bearing**:

| # | Test | Outcome | Example |
|---|---|---|---|
| 0 | declined by the adapter | `discarded` if it names an image, else *dropped* | `<img title="/img/team.jpg">` |
| 1 | `ceiling === 'unsafe'` | `dynamic` | `url($hero)` |
| 2 | `ceiling === 'medium'`, globbed as written, else through a declared alias | `resolved-pattern` / `dynamic` / `unresolved-alias` | `` `./img/${name}.png` ``, `` `@/img/${n}.png` `` |
| 3 | not a tracked extension | *dropped, no report line* | `./inter.woff2` |
| 4a | a `new URL` name the nearest Vite config's aliases map | `resolved` / `out-of-scope` / `unresolved-alias` | `new URL('assets/x.png', import.meta.url)` |
| 4 | resolves in the asset set | `resolved` | `./hero.png` |
| 4b | alias-shaped, and a declared alias, or for an import the tsconfig's `baseUrl`, finds it | `resolved` | `~/assets/logo.png` |
| 5 | under an excluded root, exists on disk, or a drive path outside the project, as written or through a declared alias | `out-of-scope` | `../legacy/old.png` |
| 5b | a `new URL` name a package holds in a `node_modules` at or above the module | `out-of-scope` | `new URL('some-pkg/flag.png', import.meta.url)` |
| 6 | alias-shaped, nothing matched | `unresolved-alias` | `@/assets/logo.png` |
| 6b | a package specifier | `out-of-scope` | `@11ty/logo/img/logo.png` |
| 6c | a bare module name with no path after it, which no alias maps | on to rung 7 | `import x from 'missing.png'` |
| 7 | asserted | `broken` | `./missing.png`, a real finding |
| 8 | otherwise | `discarded` | a path-shaped string in `package.json` |

Rung 0 settles a value an adapter examined and declined to read as a path (`RawReference.declined`,
see "The six that exist"). It is never looked up, whatever exists on disk, so it sits above the
ceiling tests: a declined template must not glob. It is `discarded` when a spelling of its path
shows an image extension, rung 3's test, and dropped otherwise. The ceiling tests come next because
if there is no static path, every later question is meaningless. **Rung 3's position is the subtle
one**, and moving it is wrong in both directions:
above the ceiling tests it silently swallows `url($hero)` and `` `/img/${file}` ``, real dynamic
references with no extension to test, and below the rungs that turn a miss into a finding it
reports every `url(inter.woff2)` as broken. There is a test for each failure mode, because the
placement is invisible otherwise. One path passes rung 3 without an image extension: a likely
typo where the element shows an image (`assertsAnImage`: an `<img>` source, a link preview, an
icon, a Markdown image), whose extension is one keystroke from an image's, as `/img/typo.pn` is
from `.png`. It goes on down the ladder, so it is `out-of-scope` if such a file exists and
otherwise `broken` at rung 7, noted as a likely typo, rather than vanish. The audit asks the
same test (`likelyTypoOf`) and gives the `broken` finding that sentence as its `note`, which the
report prints under the path; a reference's own note, which says why its adapter read it as it
did, stays off the finding. `/avatar.php`, a script that can serve an image, is further than
one keystroke and is dropped.

Letter case counts at every rung as a Linux server counts it, so `img/lvm.jpg` for the file
`img/LVM.jpg` is `broken` on every machine. Rung 7 then looks the path up again with case folded
and records the image it finds there (`namesIgnoringCase`), and the audit's finding notes that the
path loads on Windows and macOS and breaks on a Linux server.

Rung 1 drops an `unsafe` path whose text shows an extension that is not an image's, such as
`{{ page.data }}.json`. A construct an adapter could not read (`RawReference.unread`: a style
attribute or `<style>` block whose CSS does not parse, a CSS-in-JS template) is text rather than a
path, so what follows its last dot is no extension: it is always `dynamic`, which is how its
refusal reaches the report. So is a refused bundler's context: its text names a directory, whose
last dot rules out nothing.

Two outcomes deserve their own note.

**`resolved-pattern` links every match, not one.** A `medium` template becomes a glob, each
`${…}` becoming `[^/]*` so a hole cannot cross a directory boundary. One or more matches and it
resolves, carrying all of them; zero matches and it is `dynamic`, never `broken`. Linking only
the first would leave the rest looking unreferenced, which is a false `dead asset` finding
wearing a different costume. Such a reference is never rewritten, since its text is a pattern
rather than a path: the planner keeps every original it matches, and says so when only some of
them convert. A pattern that names nothing at the written path is expanded through a declared
alias, as rung 4b expands a literal one, and each expansion is globbed anchored, in the order
rung 4b tries them, until one names a file. Through an alias no rule covers, a pattern is
`unresolved-alias`, as a literal path is at rung 6; a package-shaped one stays `dynamic`.

A bundler's glob, each pattern given to `import.meta.glob`, reaches rung 2 the same way, but its
text is glob syntax rather than a path with holes, so `RawReference.glob` marks it and the resolver
reads it as picomatch, the matcher behind Vite's globbing, reads it: `*` and `?` stay in one
folder, a `**` segment crosses any number, `[...]` is a class and `{a,b}` offers alternatives, and
a wildcard skips a leading dot unless the call sets `exhaustive`. Its base is Vite's: `./` and `../`
from the module's folder, anything unrooted through a declared alias, and `/` from Vite's own root
(`posix.join(root, glob.slice(1))` in Vite's `toAbsoluteGlob`): the `root` the nearest Vite config
names, else its folder, which in a monorepo is the app's. A `/` pattern is then tried against the
serving roots and the project root, as any root-relative pattern is, since a glob keeps what it
links and a link missed would call a loaded image unused. The call's `!` patterns
remove what they match from every pattern in the call. A folder in the base is matched literally,
as Vite escapes it, so `[draft]/` is no class. Syntax this does not read (an extglob, a `{1..3}`
range) leaves the pattern `dynamic` rather than misread, and a glob that can name only non-images,
such as `./pages/*.vue`, is dropped as rung 3 drops a font. Where picomatch is inconsistent, a `**`
that is not a whole segment, the glob reads more rather than less: an extra link keeps an original,
a missing one calls a loaded image unused.

A bundler's context, the directory given to webpack's `require.context(directory, recursive,
filter)`, reaches rung 2 marked by `RawReference.bundlerContext`, which carries whether the call
recurses and its regular expression. webpack reads such a call only when it can work out each
argument as it builds, so the adapter reads it only when the directory is a string, the second
argument a boolean and the third a regular expression, each written as a literal; any other call
is `unsafe`, and its directory, when that is a literal, still travels for the sweep. The resolver
lists the directory from the module's folder, as webpack resolves a relative request, setting
aside any inline loaders and query as webpack does, and links every asset under it, in that
folder alone or in every folder below, whose path from it, written `./sub/a.png`, the expression
matches, skipping any name that starts with a dot, as webpack's
listing skips it. The expression is built once per reference: one that cannot be built here
leaves the reference `dynamic`, as does a context that takes nothing. A directory not written
from the module's folder goes through webpack's `resolve.alias` and `resolve.modules`, which
Upfly does not read, so it is `dynamic`, or `unresolved-alias` when it is alias-shaped and no
declared rule maps it. The links are `resolved-pattern`, so nothing rewrites them and `--replace`
keeps every original. webpack also offers the expression other spellings of a path, such as the
path without an extension that `resolve.extensions` lists, which its defaults never do for an
image; Upfly tests only the `./` spelling.

`import.meta.webpackContext(directory, options)`, the ES module form of the same call in webpack
5.70 and later, is read the same way under its own shape. Its `recursive` and `regExp` options
stand for the second and third arguments, and the options that change how the files load rather
than which, such as `mode` and `chunkName`, are ignored. webpack parses the options only as an
object literal of plain names and values, so options written any other way are refused and read
as none. It matches `include` against each file's absolute path and `exclude` against each file's
and folder's, as the system spells them, with backslashes on Windows, so what they keep changes
with where and on which system the project is built: a call that sets either is `unsafe`, and the
sweep reads it as if they were absent. Upfly reads a call with a third argument, or with an option name webpack does not know,
as if neither were there, though webpack loads nothing from such a call; that can only link more.

**Root-relative paths try every serving root that is an *ancestor* of the referencing file**,
nearest first, then the project root. A monorepo has one `public/` per app (shadcn-ui has twelve),
and a file under `apps/v4/` that writes `/images/hero.png` means `apps/v4/public/`. Resolving that
against a single serving root produced **93 false `broken` findings** on it.

The restraint matters as much as the list. Trying *every* configured root looks free ("more roots
can only turn a false `broken` into a correct link") and is not: measured, it linked 23 references
to **another app's asset**, which a rewrite would then point at a file that app does not serve.
The guarantee holds only when every root serves the same URL space, and a monorepo's do not, so
proximity filters rather than merely orders. A false `broken` costs five minutes; a false link
costs a broken build.

**`out-of-scope` is not `resolved`.** It carries a `resolvedPath` (for a file inside a package,
the specifier itself), but it is never rewritten: the target was never converted, so pointing the
reference at a `.webp` would break something that works today. It also carries the
`exclusionReason`, naming the actual rule (`the ignore rule 'legacy/'`) rather than a generic
"excluded", because that is the difference between a report line that explains a missing asset
and one that just mentions it.

**A Windows drive path names a place on one disk.** `C:/site/hero.png` and `C:\site\hero.png`
are read with Windows path rules on every platform, so a report made on Linux says what one made
on Windows does. Inside the project, which only a project on a Windows drive can contain, the
path is looked up like any other. Outside it, it is `out-of-scope` without a `stat`: whether this
machine holds the file says nothing about the project, and asking would make the report depend
on the machine that ran it. A browser reads `C:` as a URL scheme, so the path never loads from a
served site; the report line is how the author finds out.

### The resolver is pure, and its one filesystem need is a port

Resolution happens against the **asset set** `discover` returned, not against a disk. That is
what keeps the two-step confidence rule honest (the adapter knows syntax, the resolver knows
what exists) without adding another module that touches a filesystem.

The exception is rung 5's fallback: a file excluded by a *file-level* ignore rule such as
`*.png` leaves no pruned directory to match against, so the only way to tell "excluded" from
"missing" is to look. That is an injected `exists` port, the same shape as the `ImageProbe`, and
it is consulted only for references that did not resolve, once per candidate path of each
spelling (see "Percent-encoded and entity-encoded paths"). It is a required option rather than
an optional one, because a default would let a call site keep the false `broken` silently. The
pipeline's port, `existsAsSpelled`, also finds every name below the project root in its folder's
listing, letter case included: on Windows and macOS the disk alone finds `img/lvm.jpg` for
`img/LVM.jpg`, which would make that reference `out-of-scope` there and `broken` on Linux.

A second port, `unindexed`, is optional and the pipeline never passes it, so the audit resolves
against the walk alone. It answers for a file that exists but is not an asset, and the resolver
asks it wherever the index misses, in the order it looks, so the file a path reaches first is
found wherever it lies. The planner passes it when it checks where references would lead once a
plan is applied (see "The transaction"). A pattern is still matched against the assets only. For
the same check the resolver can fold case (`foldCase`), finding a file as Windows and macOS do;
the audit never asks it to.

### Ask `isLinked`, never `resolution === 'resolved'`

Two of the seven outcomes are linked into the graph, so:

```ts
export function isLinked(ref: Reference): ref is Extract<Reference, { resolution: 'resolved' | 'resolved-pattern' }>;
export function linkedPaths(ref: Reference): readonly string[];
```

This is not a convenience. `if (ref.resolution === 'resolved')` compiles, runs, and silently
ignores every pattern reference: a false negative the compiler cannot see, and precisely the
class the validation protocol exists to catch. The graph builder, the audit and the planner call
`isLinked`; nothing outside the resolver compares `resolution` by hand, and every `switch` over
it carries a `never`-typed default so an eighth outcome breaks the build instead of quietly
un-linking a whole category.

### A link says the asset is alive; `resolvedVia` says whether the text may be edited

Being linked and being rewritable are different questions, and conflating them is how a tool
breaks a build. Every linked reference records **how** it reached its target:

| `resolvedVia` | what happened | may the text be rewritten? |
|---|---|---|
| `file` | relative to the referencing file's directory | yes: the base is unambiguous |
| `serving-root` | root-relative, against a serving root, or through a declared alias | yes |
| `project-root` | root-relative, and no serving root held it | it depends on `RootLinkPolicy`, below |
| `speculative-root` | a speculative `./` path retried against the project root | no |

`speculative-root` is a guess at the base of a string that was already a guess: a path-shaped
literal in a data object may well be joined to some other directory at runtime, so the match is
evidence the asset is **alive** and nothing more. Rewriting it could point a working reference at
a file the code never loads.

`project-root` is kept apart from it because it is different evidence. The common case is
`<img src="/favicon.png">` in hand-written HTML on a site with no build step, where the project
root genuinely *is* the serving root. Treating that as the same evidence as a guess on a guess
would decline to rewrite most of such a repository, and repositories like it are the ones this
product is for. Measuring this class needs a repository with no configured serving root: once a
project declares its own root as a serving root (the validation harness does this for
`railsgirls-com` with `publicDirs: ['']`), the same references resolve as `serving-root`, and a
count of `project-root` reads zero for a reason that has nothing to do with how common it is.

`project-root` is also not unconditionally safe. If a serving root *is* configured and correct, a
root-relative path that misses it and happens to exist at the project root may be coincidence
rather than a link. The planner treats the two apart rather than guessing: it rewrites this class
when the project configures no serving root, and declines it when one is configured and the path
missed it. The policy is named (`RootLinkPolicy`) rather than implied, so overriding it is a
decision somebody makes on purpose.

The counts reach the JSON as `references.byResolvedVia`, so a consumer can tell a guess from an
ordinary resolution, and the planner has something to cite when it declines one: a silent decline
would be a skip nobody could see.

One more thing decides it, and it is the reference's shape rather than how it resolved. A shape
that declares `formatKept` in `SHAPES` is one `optimize` never repoints at a converted file: a
link preview's image or a Windows tile in `<meta content>`, an image in `<a href>`, an icon a
`<link rel>` names, in HTML and in JSX, and an image a web app manifest names. Each is read by
something other than the page, whether another site, a phone or a person following a link, and
not all of them read a converted format: iOS shows a home-screen icon only as PNG. The
reference is linked, so its asset is never reported dead; the planner declines to move it and says
why, and under `replace` the original it names is kept. An image no other reference names is not
converted at all. This is not one of `rewriteRefusal`'s
tests, which `relocate.ts` repeats, because a move keeps the format: `planRelocation` still
repoints such a reference to the file's new place.

### Serving roots

A root-relative `/hero.png` means nothing until you know which directory the site serves. The
engine works that out from the directories `discover` walked, by name, and this section holds the
measurements behind `serving-roots.ts`.

**Why it exists at all.** The headline claim, zero false `broken`, was measured across 53,154
references, and every measurement used serving roots somebody had typed in by hand. Run the way a
first-time user runs it, a single-entry convention guess (`['public']`) finds one of shadcn-ui's
twelve public directories: 159 resolved references become 3, and the run reports 116 `broken` and
125 `dead` findings, 44 of whose paths exist on disk. No rung misbehaved. The ladder was never the
defect; the input was.

**Detection is by directory name, over the recorded walk.** `DiscoveryResult.directories` is
recorded during the walk rather than derived afterwards from the paths in `assets` and
`sourceFiles`, because a directory holding only files nothing tracks leaves no trace in either
list. Deriving finds 11 of shadcn-ui's 12; `templates/next-app/public` holds a single `.gitkeep`.
A recorded list cannot disagree with the walk, because it is the walk.

**Depth is not the discriminator.** Those twelve range from two path segments to six, so any
depth-limited search is wrong on the repository that matters. A `-maxdepth 3` search finds six.

**It does not require the directory to hold an image**, and that was measured rather than assumed.
Six of shadcn-ui's twelve public directories hold no image the engine tracks, only `favicon.ico`,
`.gitkeep`, `robots.txt` and `manifest.json`. So an asset-bearing rule finds six, the same count as
the depth search, reached by a different route and failing in the same way. A `public/` directory
is a serving root whether or not it currently holds an image, because that is what the bundler
thinks.

**It never reads a framework config.** A serving root in `next.config.js` or `astro.config.mjs` is
more often computed JavaScript than a literal, so reading one means either executing a user's code
or statically reading a value that usually is not static, and a plain static site has no config to
read. The directory name is observable and static; the config is neither. Checking that a project
file *exists*, below, is not reading one: existence is as observable and static as a name.

**And only where the directory holding it is a project.** A folder called `public` inside a
tutorial is not a website folder, and no rule on the text of its references can tell it from
Create React App's `public/index.html`: both name a root-relative file that nothing outside the
folder mentions. What differs is ownership: a website folder belongs to a project. So a `public`
or `static` directory is claimed only when a project file sits beside it, in its parent:
`package.json`; Hugo's `hugo.toml`, `hugo.yaml`, `hugo.yml` or `hugo.json`, or its older
`config.toml`, `config.yaml` or `config.json`; a `Gemfile`;
`composer.json` or `artisan`; `angular.json`; or VitePress's `.vitepress/`, a config *directory*,
because VitePress keeps its `package.json` at the repository root. The list is `PROJECT_MARKERS`
and, like the names, an argument. Detection reads the whole walk for it, not only the files an
adapter claims: a `Gemfile` is an unscanned file. Measured on the five validation repositories, all
14 name-matched folders have a `package.json` beside them and all 14 are kept; the accuracy suite's
`docs-examples/public` has none and is rejected. **Every marker except `package.json` is untested
on a real repository**, because the corpus holds only JavaScript projects. A folder whose project
file sits further up is rejected: Phoenix's `priv/static`, Spring Boot's
`src/main/resources/static`, VuePress's `.vuepress/public`, and a plain HTML site with no project
file at all. That is the cheap direction: a rejected root leaves a reference `broken`, never linked
to the wrong file, and declaring the folder fixes it.

**The name set is `public` and `static`, and it is an argument rather than a constant.** It is still
a hardcoded convention list and it will be wrong for some framework, so a caller can supply its own.

**Measured against the hand-tuned corpus** (`pnpm --filter upfly-bench run detect-roots`):
detection reproduces the configured list exactly on `astro-docs`, `shadcn-ui` (all twelve),
`railsgirls-com` and `scratch-www`, and `--delta` shows zero change in every resolution bucket on
those four. It finds nothing on `eleventy-docs`, which serves from `src` via `addPassthroughCopy`.

**Eleventy is not special; it is merely in the test set.** Hugo, Jekyll, Gatsby, Nuxt, SvelteKit,
Rails, Django and WordPress are equally unresolvable out of the box. Special-casing the one
framework that happens to be in the corpus is letting the corpus decide the product, and the first
per-framework parser is a door the second and third requests come through. What eleventy gets
instead is inference, below, which finds `src/` from what its references resolve against. A
project whose references do not settle it is told plainly that the serving root could not be
determined, so one line of configuration fixes it.

**A missed root is survivable and a wrong one is not.** Detection finding nothing degrades to the
`project-root` rung, which is correct for a hand-written static site and measured at identical
findings on `railsgirls-com`. A wrongly detected root resolves a reference to the *wrong file*, and
a rewrite would then act on that false link. That asymmetry is why detection matches directory
names exactly rather than case-insensitively, and why `src` was measured and then rejected: adding
it fixes eleventy and costs zero delta and zero relinks on the other four repos, but `src` is a
source directory rather than a serving root, it is free here only because roots are filtered to
ancestors of the referencing file and `public` happens to sort before `src` on a tie, and the
corpus contains no repository of the shape where it would fail: a project with `src/` but no
`public/`, serving from its root. A measurement that cannot see a failure is not evidence that
there is none.

**Detected roots carry `declared: false`, and the report says so.** Detection is an inference, not
the project stating anything. The planner's root-link policy already branches on that flag; the
report discloses it in `coverage.servingRoots` and in a line of the human headline, because a guess
nobody is told about is precisely the defect above.

### Inference: what the references resolve against

Detection asks what a directory is called. Some sites serve from a directory no naming rule can
reach: Eleventy copies `src/` to the site root, and `src` is a source directory everywhere else.
So a run nobody configured also asks which directories its references actually resolve against,
and adds those. `decideServingRoots` (`serving-root-decision.ts`) makes that decision for every
caller; `inferServingRoots` does the scoring.

- **It runs after the scan**, because it needs references. Detection needs only the walk.
- **It only adds.** A detected root is never removed: the case inference exists for is a root
  detection cannot see, not one detection got wrong.
- **It scores only root-relative references that could name an image.** A documentation site's
  page links (`/en/guides/deploy/`) are references too, and counting them dragged real serving
  roots under 3%. Every candidate fell alike, so the ranking survived while the rates became
  meaningless, which is the kind of wrong number that passes a glance.
- **Volume first, then rate.** A candidate needs at least three such references
  (`MIN_ROOT_REFERENCES`) and must resolve at least 40% of them (`MIN_ROOT_RESOLUTION_RATE`). A
  folder named `public` that serves nothing can resolve two references out of two, so a rate alone
  would take it. Measured over 201 directories in the five validation repositories and the
  accuracy suite, true roots scored at least 45.8% once the volume floor applied, and wrong ones at
  most 0%.
- **A tie refuses.** A rejected root leaves every affected reference where it already was,
  `broken` or `discarded`, so a false reject costs nothing new. A false accept links a reference to
  the wrong file, and a rewrite would then act on that link.
- **The union is sorted for byte-identical output only.** The resolver orders roots by ancestor
  depth itself, so the order handed in cannot change what resolves.
- **The result is always `declared: false`.** Nobody stated these roots; the report says they were
  worked out.

### When the serving root cannot be found at all

Detection can come back with nothing, and for a hand-written static site that is the right
answer. For a framework whose convention the engine does not know, it is not: almost no
root-relative reference resolves, and the run fills with `broken` findings whose targets are
sitting on disk.

**In that state the finding is not "these references are broken". It is "we could not work out
where this project serves files from."** Reporting the first is stating a symptom as a diagnosis,
and it is the same class of mistake as calling a reference broken when it is not.

So two things happen below a floor:

1. **`planOptimization` refuses.** It returns a `PlanRefusal` rather than throwing: a throw leaves
   the caller holding nothing, while a returned refusal is a finding with a reason. The audit still
   reports; only the write path stops. `upfly optimize` prints no report when it stops, so its
   message names `upfly audit`, which lists every withheld reference with its file and line.
2. **`audit` replaces every root-relative `broken` finding with one `serving-root-unknown` finding**
   that names the real problem, says how many findings it replaced, and tells the user to declare a
   serving root. A broken relative path is not affected. Each replaced reference is listed under the
   finding, in `suppressed`, with its file, line and path as written, in the order its `broken`
   finding would have had (by file, then line, as a reader goes through a file:
   `byFileAndLine`), so none is set aside where a reader cannot see it. The human report
   prints each one as it prints a broken finding. Their target is unknown rather than missing, so
   an asset one of them names is `possibly-dead`, citing each, never `dead` (see "`possibly-dead`,
   and why "zero references" is usually a lie"). So is an asset a root-relative pattern could
   name from whichever directory the site serves, since the resolver had no serving root to glob
   the pattern against.

**A folder the project named is never asked for again.** When `--public` or `publicDirs` named
where the site is served from (`ServingRoots.declared`) and the floor is still crossed, the engine
did not fail to work the folder out: it was told, and too little resolved there. The finding and
the planner's refusal stand, since a run that resolved so little rewrites nothing and the folder may
be wrong, and the assets the withheld references could name stay `possibly-dead`. What changes is
what the run says: how many resolved in the folders named, and that if the site is served from
there the rest name no file there (`fewResolvedIn`, one sentence for every place that says it).
`upfly check` lists them as its findings, with that line, and fails with exit 1 rather than
stopping; `upfly audit` lists them under Broken and points at `check`; `upfly optimize` still
refuses, pointing at `check` rather than at `--public`. With no folder named, the refusal is as
above.

**The measure is deliberately narrow: root-relative references only, linked over linked-plus-broken.**
Only those depend on a serving root. Root-relative is read from the path a reference's text proves
(`provenPath`), in the measure, the withheld list, the audit's split and the pattern list alike, so
`'/img' + '/x.png'` counts though its text starts with a quote. A repository whose *relative*
imports are genuinely broken scores normally and keeps every one of its findings, which makes the
diagnosis correct by construction rather than merely the likeliest explanation. Dynamic, discarded,
alias-shaped and out-of-scope references are excluded too: a discarded path-shaped string out of a
lockfile is no evidence about a serving root, and counting it would make a large `package.json` look
like a misconfiguration.

**The floor is 25%, and it was measured rather than chosen.** Across the five validation
repositories, root-relative references only:

| repo | configured or correctly detected | no serving root found |
|---|---|---|
| `astro-docs` | 12/12, 100% | 0/11, **0.0%** |
| `eleventy-docs` | 23/23, 100% | 0/14, **0.0%** |
| `shadcn-ui` | 164/183, 89.6% | 0/115, **0.0%** |
| `scratch-www` | 682/704, 96.9% | 0/615, **0.0%** |
| `railsgirls-com` | 1325/1335, 99.3% | 1325/1335, 99.3% |

The two populations do not overlap and do not come close. `railsgirls-com` is unchanged in both
columns because it genuinely serves from its own project root, which is the control that shows the
measure is not simply detecting "no serving root configured".

**A partial failure is not caught by this, on purpose.** A monorepo where half the serving roots
are found scores around 50% and keeps its individual findings, because half of them are real and a
user can act on them. This fires only where the run has nothing to say.

**Below ten root-relative references the floor does not apply**, because a share taken over a
handful is not a measurement and a single genuinely broken path would otherwise suppress itself.
That minimum is judgement rather than measurement.

### Aliases are read, never executed

`@/assets/logo.png` resolves only if the project declares that alias somewhere the engine can read
**without running anything**. `loadAliases` parses `tsconfig`/`jsconfig` `paths` (following
`extends` to the file TypeScript would load: a path starting `./` or `../` names a file, `.json`
added when missing, and anything else is a package in `node_modules`, read through its `tsconfig`
field, its `tsconfig.json`, or a path inside it; a folder is never a config and `exports` is not
followed) and a `vite.config.*` `resolve.alias`, and hands the resolver a map; the resolver stays
pure.

**A config is read statically or not at all, and that is a hard line rather than a trade-off.**
Every `resolve.alias` in the validation corpus is `'@': path.resolve(__dirname, './src')`, a
JavaScript expression. Evaluating it would mean **executing a config file from a repository the
user did not write**, in a tool they ran to save bytes. No byte saving buys that. Where the static
read cannot see a value, the alias is reported as unreadable with its file and line, because a
limitation a user can see is worth more than a resolution they cannot trust. A Vite config is parsed
as the module it is (`vite-config.ts`): the config is found through `export default` or
`module.exports`, `defineConfig(...)`, `satisfies`, a top-level `const` and a function that returns an
object, and each alias value is evaluated over a closed list whose result depends only on where the
config file sits: string and template literals, `+`, `__dirname`, `__filename`, `import.meta.url`
and its `dirname` and `filename`, `path.resolve`, `path.join`, `path.dirname`, `fileURLToPath` and
`new URL(s, base)`. A name bound more than once is off the list. A string starting with `/` is read
from the Vite root. A relative string, a bare one, `process.cwd()` and a `path.resolve` with no
absolute part are reported with their line: Vite reads the first from each importing file, the
second is a package, and the others depend on the folder Vite runs in. Each alias Upfly could not
read, and each config it could not read or parse or whose `extends` it could not find, reaches the
report's `skipped` list under the stage `aliases`, with no path and none of a library's own words.
Each skip also records the folders that lose what it could not read: the folder of every config
that uses the setting, itself or through `extends`, or a Vite config's own folder. An
`unresolved-alias` reference in one of them names those configs as its reason, the nearest first,
since the alias may be in one of them; the adapter's note on the construct ("static import") is
never the reason.

Two details that are easy to get wrong:

- **`tsconfig.json` is JSONC.** Comments and trailing commas are legal and common, and `JSON.parse`
  throws on both. It is parsed with `@babel/parser` (a JSONC document *is* a JavaScript object
  literal) rather than by stripping comments with a regex, which would be "never regex JavaScript"
  wearing a different extension. Values are read off the AST, never reconstructed into an object.
- **A tsconfig key and a Vite key mean different things.** A tsconfig key's one `*` stands for
  whatever lies between the text around it, so `"@icons/*.svg"` maps `@icons/ui/star.svg` by
  `ui/star`, and that goes where each target writes its `*`: `src/icons/*.svg` gives
  `src/icons/ui/star.svg`. TypeScript reads no key with a second `*`, and Upfly reports one. A
  Vite key replaces the whole path or the key followed by `/`, so `{ '@': '/src' }` maps `@` and
  `@/x.png` but never `@img/x.png`. Each Vite alias therefore makes two rules, the key and the
  key with `/`. A `*` in a Vite key is text: a key written `@/*` maps only a path that begins
  with those three characters, then ends or goes on after a `/`, and never `@/x.png`.

A config's aliases are its `paths` after `extends`, merged as TypeScript merges them: each base in
order, then the config's own settings, a `paths` later in the chain replacing an earlier one whole.
Targets are read against the `baseUrl` in force, which is absolute against the config that declares
it, else against the folder of the config that wrote `paths`, and `${configDir}` at the start of
either is the folder of the config that uses them. So SvelteKit's `tsconfig.json`, which extends the
config `svelte-kit sync` writes into `.svelte-kit/`, maps `$lib` to its own `src/lib`, and a Nuxt 3
app maps `~` to its own folder. An import's module name that no key maps is looked for under the
`baseUrl`, as TypeScript looks, and only then: a key that matches is the only answer, its targets
the only candidates.

Aliases are scoped to the directory of the config that uses them. `shadcn-ui` has roughly twenty
configs all defining `@/*`, and without scoping every one of them would offer a candidate for every
reference in the workspace. A base that other configs extend, and that is not itself a
`tsconfig.json` or `jsconfig.json`, serves files only through those configs.

Each rule is chosen as the tool that applies it chooses. Vite's alias plugin runs before every
other resolver, a plugin that reads tsconfig `paths` included, and applies the first alias its
config declares that matches, however long the others are: under `{ '@': 'src', '@/components':
'lib/components' }`, `@/components/icon.png` is `src/components/icon.png`. So Vite's rules are
tried first, only the nearest Vite config's, in the order it declares them (an object's in the
order JavaScript enumerates its keys). Vite loads that one config, so one that declares no alias
leaves its folder with none, whatever a config above it declares; `loadAliases` records every Vite
config's folder for this (`AliasMap.viteConfigs`). A Vite alias that matches is the only candidate: when its
file is missing, the build fails there rather than trying another alias. A rewrite planned through
any other rule would point the import at a file Vite never reads. `aliases.property.test.ts` checks
this against Vite's own alias resolution, over alias sections drawn at random.

The tsconfig rules follow, nearest config first and, within one config, in TypeScript's order: an
exact key, then the longest prefix. So wherever the nearest config maps a path, the first candidate
is the file TypeScript resolves, which the same test file checks against TypeScript's own resolver
over configs drawn at random. As in TypeScript, only the nearest config's rules apply and only
the best key's targets are candidates: a path they miss is `unresolved-alias`, never a link
through a shorter key or a parent folder's config to a file the import does not load. A nearer
config with no `paths` is still the nearest, so a parent config's keys do not reach its files. One
difference remains: `include`, `files` and `references` are not read, so the nearest config is
the one nearest by folder.

**A package specifier is not an alias** (rung 6b). `@11ty/logo/img/logo.png` names a file inside
`node_modules`, which the walk prunes, so no alias configuration will ever resolve it; it is
`out-of-scope`. The two shapes differ by one character: `@/…` has an empty scope, which no registry
permits. Nor does npm permit a `$` in a name, since it refuses any name `encodeURIComponent`
changes, so SvelteKit's `$lib/…` is an alias, never a package.
An import's module name is never looked for beside the importing file, as no module resolution
looks there: `import logo from 'logo.png'` does not load the `logo.png` beside the module. A bare
name with no path after it names a package itself, not a file inside one, so when no alias and no
`baseUrl` finds it, it is `broken` (rung 6c) rather than out of scope.

The first argument of `new URL(name, import.meta.url)` is not a module specifier. The URL
constructor resolves it against the module's own URL, so the JavaScript adapter gives it an
attribute's kind rather than an import's: a bare `hero.png` is the file beside the module, and a
leading `#` is a fragment. A bundler reads the name before the browser does, and Upfly reads it
as Vite's asset plugin (`assetImportMetaUrlPlugin`) does. A name that does not start with `.`
goes through the nearest Vite config's aliases before anything else, and an alias that matches
is its only answer (rung 4a); the plugin runs only Vite's own alias and resolve plugins, so a
tsconfig key applies at no rung: an alias-shaped name no Vite alias maps, such as `~/img/x.png`
under a tsconfig `~/*`, ends `unresolved-alias` once the lookups below miss. Then the file beside
the module. Then a name that starts with a letter, digit, `_` or `@` is looked for as a package,
in the `node_modules` of the module's folder or of any folder above it, and is `out-of-scope`
where one holds it (rung 5b). A name found nowhere is `broken`: Vite leaves it for the browser,
which asks for it beside the module. `import.meta.resolve(name)` is different, since it follows
module resolution; the adapter does not read it as a construct, and its argument is guessed at
like any path-shaped string.

`unresolved-alias` means an alias-shaped path that no alias Upfly reads maps. It is a final
outcome, not pending work. The project may still declare the alias where Upfly does not look, such
as a webpack config, SvelteKit's `kit.alias` or Astro's `vite.resolve.alias`, so the reason says
which configs Upfly reads and never that the project declares none. For SvelteKit's `$lib` it also
says what writes the alias: `svelte-kit sync`, run by installing the project, fills
`.svelte-kit/tsconfig.json`, which a fresh clone does not have yet. `svelte.config.js` is not read.

### Non-asset extensions are the resolver's business

`url(inter.woff2)` in an `@font-face` is a perfectly asserted reference to a file the engine
does not track. Adapters deliberately do **not** filter by extension: the tracked-extension
policy lives in one place so it is not re-implemented across six adapters and forgotten by the
sixth contributor, and so that adding video later flows through automatically.

These are dropped without a report line. That is not a silent skip: a `.woff2` was never a
candidate asset, so declining it is not declining to do work, and counting fonts would be noise.
A value an adapter declined is judged the same way at rung 0: a tooltip naming `/files/report.pdf`
is dropped, and one naming an image is counted.

**A silent skip is a bug.** If the engine declines to do something, the report says so.

### Percent-encoded and entity-encoded paths

A reference can spell its path with encoded characters: `hero%20image.png` for a file called
`hero image.png`, or, in HTML, `a&amp;b.png` or `a&#38;b.png` for `a&b.png`, or, in a Markdown
destination, `my\_photo.png` for `my_photo.png`. Four rules govern these, and each prevents a
different error.

The reference keeps the text as written. `rawPath` is always the source text, so
`source.slice(start, end) === rawPath` holds for every reference and a rewrite replaces exactly
what the author typed. Decoded forms are never stored. `spellingsOf` lists them and the resolver
tries each one: its extension filter passes a path if any spelling ends in a tracked extension,
and its lookup tries the spellings in order, recording on the resolved reference the spelling
that matched. Rung 5 asks about the same spellings in the same order, so an encoded path to a
file an ignore rule excludes, or into a directory the walk pruned, is `out-of-scope` rather than
`broken`: `unindexed%20photo.png` names the ignored `unindexed photo.png`. Rung 4b expands a
declared alias for each spelling too, literal first, so `~/assets/img/team%20photo.png` names
`team photo.png`; a move re-spells only what follows the alias, whose prefix is the project's own
text. The audit's sweep reads
a path that did not resolve in the same spellings, so an asset named only in an encoded spelling
is `possibly-dead` rather than `dead` (see "`possibly-dead`, and why "zero references" is usually
a lie").

The literal spelling is tried first. `enc%20name.png` can be a real file whose name contains a
percent sign, while `hero%20image.png` reaches a file called `hero image.png`, and as text the two
cannot be told apart. An engine that never decodes gets the second wrong; one that always decodes
gets the first wrong. The accuracy suite holds both files, so the order is tested rather than
assumed.

A path that cannot be fully decoded offers no decoded spelling at all. A partly decoded path is
neither what the author wrote nor the file's name, and looking it up would miss, which for an
asserted reference means a `broken` finding. The decoder knows numeric references (`&#38;`,
`&#x26;`) and every named reference the HTML specification defines, taken from parse5's table:
each name is decoded once inside an attribute value, where it counts only whole and with its
semicolon. What reads a path decides which character references in it are decoded, and how:
`characterReferencesReadIn` picks HTML's decoder, CommonMark's, or none, from the reference's kind
and shape, or, where a construct CSS owns gave the shape (an `image-set()`, a custom property), from
the markup that holds that CSS, which the reference carries as `host`: the parser decodes a whole
style attribute before CSS reads any of it. An HTML parser decodes an attribute, the CSS inside a
style attribute and a JSX attribute's string, and CommonMark decodes a link destination's names the
same way, so
`![](caf&eacute;.png)` names `café.png`, as `<img src="caf&eacute;.png">` does. A `.css` file, a
`<style>` body, a `new URL` name, JavaScript and JSON decode none: in a stylesheet
`url(caf&eacute;.png)` asks for a file called `caf&eacute;.png`. A `<style>` body inside Markdown is
read the same way: its CSS takes a shape of its own, `md.style-element`, rather than the style
attribute's, since the shape picks the decoder. The two decoders read a number differently. HTML
reads any number of digits, so `&#00000065;` is `A`, and a number from 128 to 159 through the
Windows-1252 table, as parse5 does with the table of its `entities` dependency, so `&#128;uro.png`
names `€uro.png`, not a C1 control. CommonMark (0.31.2, section 2.5) reads at most seven decimal or
six hexadecimal digits, so a longer number is text, and keeps a number's own code point. Both read
zero, a surrogate or a number past U+10FFFF as U+FFFD. Anything else written like a reference, such
as the misspelled `&eacut;`, stops the decoder. Percent-decoding uses `decodeURIComponent`, and text
it rejects, such as `100%`, is treated the same way.

In a Markdown destination a backslash before an ASCII punctuation character is an escape, and
CommonMark removes it in the same pass that decodes character references: `my\_photo.png` names
`my_photo.png`, and `\&eacute;` is the text `&eacute;`, since an escaped `&` starts no reference.
So for a reference of kind `md`, `spellingsOf` offers that reading, recorded as `markdown-escapes`
when the path holds an escape. Nowhere else does `spellingsOf` read a backslash as an escape. In an
attribute's URL (in HTML or JSX, or a `new URL` name) one left after decoding is read as a slash, as
the URL parser reads it on every platform (`readAsUrl`): `<img src="img\photo.png">` loads
`img/photo.png` on Linux as on Windows, and `\\cdn/x.png` in an attribute is another host's. A
Markdown destination is not read that way. Most renderers (markdown-it, micromark, commonmark.js,
cmark-gfm) write a backslash CommonMark keeps, as in `img\photo.png`, `img\\photo.png` or
`img&#92;photo.png`, as `%5C`, and a browser keeps a `%5C` as written, so only a renderer that
passes the backslash through, or a Windows server, finds the folder. The Markdown adapter refuses
such a destination as `unsafe`, and every adapter refuses a `%5C` in a URL the same way
(`holdsEncodedBackslash`), each only while the path could name an image: nothing rewrites it, and
the name search hedges the image it names rather than calling it dead. A drive path names a place on
a disk rather than a folder, and keeps its own reading. In CSS a backslash is an escape, and the CSS
adapter reports a path holding one as `unsafe`; a JavaScript string writes one only as an escape,
and keeps it. Whatever is left, the resolver looks up no spelling that still holds a backslash,
since Windows path rules read one as a folder separator and every other platform's as part of a
name; the drive path, read with Windows rules everywhere, is the exception.

The spellings are tried one at a time, so a path that needs both decodings, such as
`caf&eacute;%20x.png` for `café x.png`, has no spelling that reaches its file. A path holding a
reference the decoder cannot read, or references or backslash escapes that leave a percent-escape
to decode, whether beside them (`my\_photo%20x.png`) or made by them (`hero&#37;20image.png`
reads `hero%20image.png`, which a server decodes again), is therefore reported as `unsafe` by the
Markdown adapter, a refusal with a reason instead of a ceiling that leads to a lookup. That holds
only while some reading of the path ends in an image extension: as written or as CommonMark reads
it, where an unknown name stays text, each also percent-decoded. `/wiki/AT&T;` shows none, so it
names no image whatever `&T;` meant; it is kept like any other link, and the resolver drops it. The
HTML adapter refuses the same character-reference paths, and also any whose decoded spelling differs
from parse5's reading of the attribute, as when a legacy name such as `&copy` is written without its
semicolon: parse5 still decodes it before a `.`, and our decoder does not. It too refuses one only
while some reading ends in an image extension, as written or as parse5 reads it, each also
percent-decoded (`attributeCouldNameAnImage`): `/avatar/AT&amp;T&x;` is kept like any other value,
and the resolver drops it.

A rewrite writes the new path back in the matched spelling. It starts from the path on disk, so
without this a file called `hero image.webp` would be written into a URL with a raw space. `spell`
takes the reference, as `spellingsOf` does, because the syntax around the path decides what it may
hold. It percent-encodes each segment separately, leaving the slashes alone, and for an entity
spelling re-encodes only `&`, because inventing entities for other characters would change text the
author did not write. A Markdown destination is written so that CommonMark reads it as the file,
bare or in angle brackets, since the reference does not record which: `\`, `&`, `<`, `>` and both
parentheses are escaped with a backslash (an unmatched parenthesis ends a bare destination), though
`&` is written `&amp;` where the author wrote character references, and a literal path that needs no
escape stays as written. No backslash escapes a space or a control character, `#` and `?` would
start a fragment or a query, and a server decodes a percent-escape a name holds, so a name with any
of them is written wholly percent-encoded, parentheses included: the resolver decodes an escape or a
percent-escape, never both. The optimize planner re-spells nothing: it swaps the extension in the
text as written, so `my\_photo.png` becomes `my\_photo.webp`, which reads as the converted file. How
the HTML adapter finds these spellings in attributes, `style` included, is under "Character
references in HTML attributes".

### `possibly-dead`, and why "zero references" is usually a lie

An asset referenced only from a `.vue`, `.svelte` or `.njk` file has zero references for a reason
that has nothing to do with the asset: no adapter reads that format yet. Calling it dead is a false
positive we manufactured ourselves. The `eleventy` fixture has two of them: `logo.png` and
`favicon.png` are referenced only from `.njk` templates, and both would otherwise be reported dead.
The hedge stands in for coverage the engine does not have yet, and the fix for a hedge is an
adapter, not a softer label.

The obvious rule, hedge globally whenever some extension went unread, degenerates. On the five
validation repositories the unread list holds 10 to 28 file types each: templates such as `.njk`,
`.liquid` and `.ejs`, icons, fonts, media and SVG. It is never empty on a real project, so `dead`
would never fire, and a label that always fires carries no information. A curated allowlist of
"extensions that can reference an image" is the other wrong answer: it is a place to be wrong in
the direction that ships a false `dead`.

**So the hedge is per-asset.** `discover` records every file it did not read *with its path*, and
`scan` adds every file it could not parse. For each asset with zero references, the audit sweeps
that text for the asset's filename, in one pass building a set of names, not one pass per asset:

- **A hit → `possibly-dead`**, and the report names the file: *"`hero.png`, referenced in
  `config.yaml`, which Upfly cannot parse."* That is actionable; a global hedge is not.
- **No hit → `dead`**, confidently.

`unscannedExtensions` is still reported. It stops being the trigger and becomes what it should
always have been: a coverage statement, and how a user finds out they want an adapter. Its caveat
counts only the files no adapter claimed; a file an adapter could not parse is listed under skipped.

The sweep reads three things: files **no adapter claimed**, the raw path of every reference we
**could not resolve**, and the asset filenames `scan` saw in the files it **did** read, collected
while each file's text was already in memory, so no source file is read twice. That last one
covers a name that parses fine and yields no reference, such as `{ file: 'My Logo.png' }`, a spaced
file name with no slash, which has the shape of a UI label (see "What counts as a path-shaped
string"). Of the files no adapter claimed, a known binary type (a video, a font, an archive) is
never read, since it holds no text and the report already counts it as binary, and any other is
read only when its size on disk, asked first, is within the limit (2 MiB, bytes against bytes);
a larger one is skipped with that reason rather than read whole.

A name is found with the spaces and parentheses it holds, though the filename token stops at
both, and in any script: `Zaječar (2).jpg` and `Рисунок3.png` are found whole, not as
`ar (2).jpg` and `3.png`. Every pass starts at an image extension, which a literal search finds
fast, and walks left by code point over letters, digits and combining marks of any script, emoji
(with the joiner, skin tones and flag letters their sequences use), U+FFFD, which stands for bytes
a name held that were not UTF-8, and `_@.-`; a pattern with that class in front of the extension
would retry it from every letter of every word, several times slower. From each token the search
walks left over up to six space-separated words, so `Firing Practice.webp` is found whole. A second
pass starts at each image extension and walks left for names that hold parentheses in balanced
pairs: `hero (1).png` is the name a browser gives a second download of `hero.png`. The pass is
separate because parentheses in the token would change what it finds, `url(hero.png` in place of
`hero.png` in `url(hero.png)`. A third, from the same extensions, reads a run that holds `%`, and
only such a run: it yields the run as written, since a file's name may hold `%`, and
percent-decoded, as a URL names a file, so `/img/vue%20photo.png` in a file no adapter reads names
`vue photo.png`.

The unresolved paths it reads are those of references whose target is unknown: `dynamic`,
`unresolved-alias`, `discarded`, and the root-relative `broken` references that a run with no
serving root withholds (see "When the serving root cannot be found at all"). `discarded` holds the
values an adapter declined, which are never looked up, so an image named only in a tooltip or a
component's prop is hedged by that value rather than called dead. A reference whose
target is known is no evidence of use. Any other `broken` reference points at nothing and is
already its own finding, and `hero.png: dead` beside `./wrong-dir/hero.png: broken` tells a reader
more than a hedge would. A withheld one has no finding of its own, and `/img/hero.png` may be served
from the directory the run did not find, so a `dead` beside it would call a file safe to remove
that the site may serve. `out-of-scope` is known not to be an indexed asset.

Each of those paths is read in every spelling the resolver would look it up in, for the
reference's kind (see "Percent-encoded and entity-encoded paths"). Read only as written,
`/img/my%20photo.png` holds the token `20photo.png`, and `my photo.png` would be called dead beside
a path that names it. A spelling's last segment is looked up whole as well as searched for
filename tokens, because a decoded name can hold characters no token can: `a&amp;b.png` decodes
to `a&b.png`, whose only token is `b.png`.

A mention cites the line that holds the name and quotes that line. Most unresolved paths fit on
one line, and are cited where they start and quoted whole. A construct an adapter refuses whole,
such as a `<style>` block or a style attribute whose CSS does not parse, or a CSS-in-JS template,
is one reference whose path is its whole text, and it can run for a hundred lines with the name
far below the first. Its mention cites the first of its lines that names the asset, each line
read in every spelling as the whole path is, and quotes that line alone. The lines are the source
text's: a refused CSS-in-JS template's path is flattened, each hole a comment on one line. A name
no line holds, such as a file a pattern matched, is cited at the path's first line of text.

**No basename sweep can rescue a filename assembled at runtime.** `` `background-${dir}.png` ``
never contains the string `background-ltr.png`, so there is a test pinning that limit, of *the
sweep*, so nobody "fixes" it for a case no sweep can reach. It is a limit of the sweep and not of
the engine: the same template literal carries a `medium` ceiling, the resolver globs it, and
`resolved-pattern` links every file it matches. When one mechanism cannot reach a case, check
whether another already does before calling the limit fundamental.

The glob needs a base, though. In a run that could not find its serving root, a root-relative
pattern is globbed against directories that do not serve the site, and ends `dynamic` while the
files it names sit on disk. So the sweep globs each such pattern itself, with the resolver's glob
and the serving root left open (`servedFromAnyRoot`): the pattern has to match the end of an
asset's path, in whole segments, so `/img/pattern-${n}.png` hedges `src/img/pattern-1.png` and not
`src/pattern-1.png`. The set is defined once, by `patternsWithoutServingRoot`, under the same
condition as the withheld references and for the same reason: its target is unknown rather than
absent. Once the serving root is found, the resolver has globbed the pattern against it, and what
it matched there is what the pattern names. A hole the resolver never globs is the exception, in
every run: Liquid's `{{ n }}`, `{% %}` and EJS's `<% %>` are not read as a file-name part, so
`/img/photo-{{ n }}.png` stays `dynamic` whether or not the serving root is found, and the sweep
globs it the same way (`unglobbedHolePatterns`), each hole read as one segment. A path whose only
fixed text is slashes, `{{ page.image }}`, fixes no part of a name and is left to the mentions. The fix belongs here and not in the resolver, which
resolves each reference before any run-wide measure exists, and whose link would claim a use
rather than hedge one and count toward that measure.

A pattern an adapter declined is never globbed at all (rung 0), so the sweep globs it the same way,
and `` alt={`../img/team-${id}.jpg`} `` hedges `src/img/team-1.jpg` rather than leaving it dead.
Nothing resolved it, so a relative one could be anchored at its file or at the project root; the
files it names end with its segments after any leading `./` or `../`, and the open base matches
that ending. The sweep also reads the path a reference's text proves as well as the text, so an
escaped string names what its escapes decode to. That holds where a path is asserted too: in
`import hero from './img/h\u00e9ro.png'`, `src={'./img/caf\u00e9.png'}` or an escaped
`import.meta.glob` pattern, no range spells the decoded path, so the reference is `unsafe` and
stays `dynamic`, and its decoded path travels as `assembledPath`, so `héro.png` is hedged rather
than called dead. Every refusal of a path that still names a file carries what it names the same
way: a CSS `url(img/caf\e9 .png)` the path its escapes decode to, and an HTML path refused for a
character reference parse5's value, the text a browser reads. A guessed JavaScript string holding
another language's hole, `'/img/photo-{{ n }}.png'`, is kept as an unsafe guess rather than
dropped, so its fixed parts are globbed as any such pattern is.

A relative pattern that matched nothing is hedged the same way (`unmatchedRelativePatterns`). A
script can build a path the browser reads from the folder of the page that loads it, `'img/icon-'
+ n + '.png'` in `js/app.js` loaded by `pages/index.html`, and the resolver globs from the
script's folder, not the page's, so `pages/img/icon-1.png` is hedged rather than called dead.
Globbing from the pages that load a script would need the script graph.

A pattern through an alias no rule maps is `unresolved-alias`, and only a rule could say which
directory the alias stands for, so the sweep drops the alias, the first segment, and globs the
rest the same way (`unmappedAliasPatterns`): with no config that maps `@/`,
`` `@/img/badge-${n}.png` `` hedges `src/img/badge-1.png` and not `src/icons/badge-1.png`. A
bundler's glob that matched nothing is read in its own syntax the same way (`globFromAnyRoot`), its
leading `./`, `../`, `/` and alias token dropped. A bundler's context that linked nothing is read
by what it could take (`contextCouldTake`). A call refused for an argument or option that is not
a literal takes its widest reading, every folder below and every file, so
`require.context('./icons', true, filter)` hedges each image under `icons/` rather than calling it
dead. A directory written from the module's folder is read from there; any other could stand for
a folder anywhere, so its segments after any alias token have to name a folder on the asset's path.

Two things belong in that swept text for reasons that are not obvious. **An SVG is both an asset
and a container**: `<image href>`, `<use href>` and a `<style>` block inside one are all real
references and no adapter reads them, so `.svg` is recorded as unread even though it is also an
asset. And **a reference we read but could not resolve names no asset**: eleventy's
`![Templated]({{ site.url }}/img/templated.png)` is `dynamic`, so `templated.png` links to nothing and
looks dead while being demonstrably alive, the same manufactured false positive arriving from the
other direction; its raw path is part of the swept text for that reason. Directories the user
*excluded* are deliberately not swept: an ignore rule is an instruction, not a gap in our coverage.

## Adapters: the contribution surface

An adapter teaches Upfly to read one file format. This is where most contributions go, and
adding one should take about half an hour.

```ts
interface Adapter {
  readonly id: string;                    // 'javascript', 'html', 'css', 'vue', …
  readonly extensions: readonly string[]; // ['.html', '.htm']
  findReferences(input: { file: string; text: string }): RawReference[];
  rewrite(input: { text: string; edits: readonly Edit[] }): string;
}
```

Rules an adapter must follow:

1. **Never touch the filesystem.** It receives text and returns data.
2. **Never resolve paths.** Report `rawPath` exactly as written; the resolver decides what it
   points at. An adapter that resolves paths cannot be unit-tested without a disk. This is also
   why an adapter reports a `ceiling` rather than a confidence, and why "string values that
   resolve to an existing asset" is not something a JSON adapter can implement: it emits every
   path-shaped string as speculative and lets the resolver decide.
3. **Be pure.** Same input, same output, no globals.
4. **Report offsets of the path text only**, not the surrounding quotes or attribute.
5. **Ship a fixture and a table-driven test.** A fixture is a small project in `fixtures/`,
   written the way a person would write it. The adapter's `*.fixtures.test.ts` reads it, and
   `fixtures.test.ts` and the fixture build run the whole engine over it.

Parsing strategy: use a real parser wherever one is cheap and correct: `@babel/parser` or
`oxc` for JS/TS, `parse5` for HTML, `postcss` for CSS. Regex is acceptable for Markdown and
JSON only. **Never regex JavaScript**; it will find references inside comments and strings and
produce exactly the silent corruption this design exists to prevent.

### The six that exist

| Adapter | Extensions | Reads | Parser |
|---|---|---|---|
| `astro` | `.astro` | the frontmatter fence as TypeScript **and** the template body as HTML | delegates to `javascript` + `html` |
| `css` | `.css .scss .less` | `url()`, `image-set()` | `postcss` + `postcss-value-parser` |
| `html` | `.html .htm` | `src`, `srcset`, `poster`, `<source>`, `<audio>`, `<track>`, `<embed>`, `<input>`, `<object data>`, inline SVG `<image>` and `<feImage>`, icon and preloaded-image `<link>`, a link preview's image in `<meta content>`, an image in `<a href>`, `<style>`, `style=""` | `parse5` |
| `javascript` | `.js .jsx .mjs .cjs .ts .tsx .mts .cts` | `import`, `require()`, `import()`, `new URL(…, import.meta.url)`, `import.meta.glob(…)`, webpack's `require.context(…)` and `import.meta.webpackContext(…)`, JSX `src`/`srcSet`/`poster` on any element and every position the HTML adapter reads, CSS-in-JS | `@babel/parser` |
| `markdown` | `.md .mdx .markdown` | `![]()`, `[]()`, link reference definitions, raw HTML, and in `.mdx` the top-level `import`/`export` blocks | a one-pass scanner over masked text, reading destinations as CommonMark does; delegates raw HTML to `html` and MDX's ESM to `javascript` |
| `json` | `.json .webmanifest` | every path-shaped string **value**, as a speculative candidate | regex |

An attribute names a file in JSX exactly where it does in HTML, because both adapters read one
list, `URL_POSITIONS` in `url-attributes.ts`. A position is a tag, an attribute and, where those
two do not decide, a claim read from the element: a `<link href>` names an image only when its
`rel` says it is an icon or a preloaded image (`linkImageClaim`). Each row names the shape
each adapter gives its reference, and where one claim can assert two things that need different
JSX shapes, as an icon, which keeps its format, and a preloaded image, which does not, the row
maps each claimed shape to its JSX shape (`jsxClaimed`). So a row added to the list is read in both, and
`url-attributes.test.ts` checks that the same markup yields the same paths at the same offsets in
a page and in a component. JSX keeps one rule of its own beside the list: `src`, `srcSet` and
`poster` are read on any element, because a component such as `<Image>` hands them on to an
`<img>`. The JSX reader decides each attribute at the element: it is read or declined, and a value
that a claim reading the value's text cannot judge whole is judged path by path (below).

A value is read as a page's is, too. A string or template in a JSX attribute, and the first
argument of `new URL(…, import.meta.url)`, are URLs, so each is read without the C0 controls and
spaces around it, and one with a tab or line break inside stays `unsafe` with a note saying why:
the rule `urlWithin` in `reference-path.ts` gives both adapters (see "Character references in HTML
attributes"). The claim that reads a value's text reads it the same way, so a line break before the
closing quote hides no link to an image. An `import` or `require()` specifier is not a URL, and
module resolution strips nothing, so it is read as written.

Two more claims make the list read what a page names only in its head or in a link. A `<meta
content>` names a link preview's image when its `property` or `name` is `og:image`,
`og:image:url`, `og:image:secure_url`, `twitter:image`, `twitter:image:src` or
`msapplication-TileImage`, in any case (`metaImageClaim`). An `<a href>` names an image when its
value shows an image extension in one of the spellings the resolver tries (`anchorImageClaim`), so
`<a href="/about">` and a PDF claim nothing. A vector counts as a raster does: `optimize` never
converts one, but a link is what shows it is used, and an SVG named only by a link would
otherwise be counted as an unused vector. Such an image is often named nowhere else,
and before the claims it was reported dead while the site used it. Both references link their
asset and are never rewritten: the sites that fetch previews may not read a converted format, and a
person following a link expects the format it names. A plain Markdown link, `[text](path)`, is the
same thing written in Markdown, so it has its own shape, `md.link`, with the same rule, while an
embed, `![alt](path)`, stays `md.image` and is repointed. A link definition, `[label]: path`, is
repointed only when images alone use it: one that a plain reference link uses (`[text][label]`,
`[label][]` or `[label]`) is `md.reference-definition.link`, with the link's rule, even where an
image shares it. The rule lives on the shape, as `formatKept` in `SHAPES`, where the planner reads
it; see "A link says the asset is alive" for what it does there. Because the shape carries the rule,
it survives where another shape would otherwise take over: a percent-encoded or entity-encoded
spelling, Markdown's and Astro's relabelling of what the HTML adapter found, and a JSX template,
which elsewhere takes a template's shape. A JSX value at such a position that is not one string or
template is not one path, so each path found inside it is read as it would be anywhere else: a
branch of a choice, a literal or a pattern in a `+` chain, a call's argument in
`content={absolute('/og.png')}`, a `require()` or a `new URL(…)`. Each takes the position's shape
once the walk ends (`withPositionShape`), as everything an Astro braced value yields does. Under its
own shape a guess that resolved could be repointed. The innermost attribute value decides, and a
link asks its claim of each path found, so a PDF inside a link keeps the shape it was found with. A
link's claim reads the value's text, so a link whose value has none of its own, such as
`href={photo || '/img/team.jpg'}`, is not declined at the element: each path in it is judged by the
claim the same way.

The HTML adapter reads a `<template>`'s content as well as its children. parse5 keeps a
template's markup in a separate fragment, and that markup is live: a script clones it into the
page, and a declarative shadow root renders it with no script at all. Markdown and Astro reach
the same walk, so the raw HTML after a `<template>` that Markdown prose mentions and never
closes, which the parser puts inside the template, is still read.

The JavaScript adapter also emits **path-shaped string literals as speculative**, the same standing
a string in a JSON file gets. The asymmetry was indefensible once stated: `{ "file": "x.png" }` in
`data.json` was a candidate and the identical string in `data.ts` was invisible, and that produced
a *confidently dead* asset on a real repository. A candidate that resolves becomes a real link,
which beats a hedge because the rewrite can act on it; one that does not is discarded, **counted in
the report, and listable with `--include-discarded`**, because a candidate the JSON adapter ate in
error is invisible unless the count says something is wrong and the list says what. It never
overturns a construct that examined a value and declined it: `alt="/not.png"` is display text, and
guessing at it would link an image the text only names and let a rewrite edit the text. The
attribute decides, not the spelling of its value: a template with holes or none, a `+` chain, or a
choice between them in `alt` is declined too. A function, call, object or array there is still
searched, because a component can pass it on as data.

A declined value is not dropped. Each path-shaped one comes back marked `declined`, with the
construct's reason in its `note`: a JSX attribute that names no file on its element, under the
shape `js.jsx.attribute.other` and one reason per attribute name (`JSX attribute largeImage, …`);
a template given to a tag other than a CSS one (`` t`/img/x.png` ``, `String.raw`); a string
written with escape sequences, whose decoded path travels as `assembledPath` because no range of
the text spells it; and the source of an `import type` or `export type ... from`, under the shape
`js.import.type`, which TypeScript erases, so it loads no file and is never linked or rewritten.
The HTML reader declines the same way a path-shaped value naming an image in an attribute it does
not read on its element (a `title`, a custom attribute), under `html.attribute.other` with one
reason per attribute name; `data-src`, `data-srcset` and `imagesrcset`, which a lazy-loading
script or the browser may load, say that Upfly does not read them yet, and a candidate list is
declined one candidate at a time. The JSON reader declines an object key naming an image, which
it never reads as a path, and a string naming one written with escape sequences, whose decoded
path travels as `assembledPath` as JavaScript's does. So "Nothing was skipped" is printed only when
it is true. The resolver never looks one up (rung 0), the report counts them by reason in
`references.declinedValues`, and `--include-discarded` lists them. A component prop that holds a
file path, such as scratch-www's `largeImage`, is counted this way rather than read: whether a
prop names a file is the component's business, and the count is what shows which props a reader
may want read.

Four things they share, and each was a bug before it was a rule:

- **CSS is read in one place.** An HTML `<style>` element, a `style=""` attribute and a
  `styled.div` template all go through the CSS adapter's scanner rather than a second, weaker
  implementation. Markdown hands its raw HTML to the HTML adapter for the same reason, and an
  MDX document's top-level `import`/`export` blocks to the JavaScript adapter, delimited by MDX's
  own rules, so a paragraph line that merely begins with the word `import` stays prose, and each
  line is read by exactly one of the three. One seam remains: in MDX an attribute written in
  braces, `src={'/img/x.png'}`, is JavaScript, which the HTML reader would keep as part of the
  path. The Markdown adapter reads such a value itself, from the unmasked text: one string literal
  is that string, and anything else is declined with its reason, counted in the report, never
  dropped.
- **Mask before you match.** The Markdown adapter blanks fenced blocks, code spans and HTML
  comments with spaces *of identical length* before running any pattern, so a `![](old.png)` in a
  documentation example is invisible while every offset after it stays exact. Code spans are found
  as CommonMark finds them: a backslash-escaped backtick opens none, and a run of backticks closes
  only at the next run of the same length in its paragraph, so a stray backtick in prose never
  hides the image after it. The JavaScript
  adapter does the same to flatten a CSS-in-JS template, replacing each `${…}` with a CSS comment
  of matching length: a comment rather than a SCSS interpolation, because `styled.div` templates
  routinely open with `${baseStyles}` at statement level, where an interpolation fails to parse
  and would cost the real `url()` below it.
- **A `?query` or `#fragment` sits outside the reference range.** Rewriting swaps `hero.png` for
  `hero.webp` and leaves the author's `?v=2` alone. Including it would also make the path
  unresolvable and produce a false broken finding.
- **Template holes are one list.** `TEMPLATE_HOLES` in `reference-path.ts` holds every syntax that
  stands for an unknown part of a path: `{{…}}`, `{%…%}`, `<%…%>`, `${…}`, `#{…}` and `@{…}`.
  The static-extension test, the suffix split, the fragment and external-URL tests, the
  template reason, the file skip's tokens and the Markdown link pattern all derive from it,
  because a rule that misses a syntax reads the hole's text as the path: `hero.@{ext}` had the
  extension `.@{ext}`, which ruled out an image, and the reference vanished. The glob reads one
  subset, `${…}`, `#{…}` and `@{…}`, because only JavaScript template literals and SCSS and Less
  interpolations are ever marked as patterns. Any other templated path is `unsafe`, and so
  `dynamic`: in HTML and Markdown a path holding any hole, in CSS one holding a hole that is not
  SCSS's or Less's. The JavaScript adapter takes its holes from the parser instead, so a `{{…}}`
  inside a JavaScript string is text, sent to the browser as written.

Two places where the same character means opposite things, both settled by `kind`:

- A leading `#` is a document fragment (`url(#gradient)`) everywhere except a module specifier,
  where `#internal/img.png` is a Node subpath import. `isExternalUrl` takes the reference `kind`
  as a **required** argument for exactly this: a default would let a call site keep the wrong
  reading silently, and dropping a subpath import made it vanish from every report under no
  reason at all.
- `#{` opens a SCSS interpolation, so it is never treated as a fragment.

A letter, a colon and a slash or backslash is a Windows drive, never a URL scheme, a package or
an alias. `isDrivePath` answers it before the scheme test, so `C:/site/hero.png` reaches the
resolver instead of being dropped as another host's URL with no report line.

### What counts as a path-shaped string

The JavaScript adapter emits path-shaped string literals as speculative candidates, and the CSS
adapter does the same for quoted strings in preprocessor variables. Each first requires a file
extension; `plausiblePathShape` then decides whether the string is shaped like a path at all.

A comma rules a string out, because `"/a.jpg 1x, /b.jpg 2x"` is an unsplit `srcSet` list rather
than a path. So do tabs and newlines, which no real path carries.

Spaces are allowed. Files uploaded through a CMS or dragged into a project carry them, and a rule
against whitespace makes `["/ncc/Firing Practice.webp"]` invisible, which reports an image on a
live site as dead. But a space is allowed only alongside a `/`. Without one, a spaced string cannot
be told from a sentence: shadcn-ui has 87 quoted strings that contain a space and end in an image
extension, all of them accessible labels such as `"Remove workspace.png"` and
`"Open desk-reference.jpg"`, and none contains a slash. Taking a label for a path is the expensive
mistake: a speculative string that resolves becomes a link, and a rewrite acts on it.

A slash is not enough on its own, because prose can hold both: `"see ./old.png for details"`,
`` `we removed ./old.png last week` ``, `"import logo from './old.png'"`. What separates these from
`/ncc/Firing Practice.webp` is that the prose continues after the extension. So a spaced string
must be nothing but a path. `SPACED_PATH` is anchored at both ends and must finish on an
extension, a dot followed only by letters or digits, which rejects `.png for details` and `.png'`.
The extension check the adapters make first cannot do this job: `extname('see ./old.png for
details')` is `'.png for details'`, which is not empty.

`*` is allowed because the JavaScript adapter joins a template literal's chunks with it, so
`` `/gallery/Firing Practice ${n}.webp` `` is tested as `/gallery/Firing Practice *.webp`.

Parentheses are allowed here and nowhere else. A phone screenshot downloaded twice,
`WhatsApp Image 2026-03-11 at 1.29.35 PM (1).webp`, is a common way an image enters a repository
kept by non-developers. Inside a string literal a parenthesis is an ordinary character. In an
unquoted CSS `url(…)` it closes the construct, so admitting it there would break the parse, and the
quoted form already carries such a name. A bare Markdown destination is read as CommonMark reads it:
parentheses belong to the path in balanced pairs or escaped (`photo(1).png`, `photo\(1\).png`), up
to 32 deep, and the angle-bracket form carries anything else.
The end anchor keeps the widening to file names: `"url(hero one.png)"` ends on `)`, not on an
extension, and is rejected. A string with no space, such as `"url(hero.png)"`, never reaches
`SPACED_PATH`: it is emitted as a guess and discarded when nothing of that name exists.

One gap is accepted. A spaced file name with no slash, `{ file: 'My Logo.svg' }`, has the same
shape as the UI labels and stays invisible. A test in `javascript.test.ts` pins the gap, and
closing it is one clause in `plausiblePathShape`.

### Assembled paths in JavaScript

Besides the constructs that assert a reference, the JavaScript adapter guesses. A path-shaped
string literal outside any construct is one kind of guess. A template literal such as
`` `./_images/background-${dir}.png` `` in an object property is another, and so is a path
assembled with `+`, such as `'/srcset/' + 'card-' + String(width) + '.jpg'`. Guesses carry
`asserted: false`, so none of them is ever reported as `broken`: a string that names nothing is
discarded and counted, and a template or chain that matches nothing is `dynamic`, like any other
template.

A path in an asserting position that holds a hole of another language's template, `{{ }}`,
`{% %}` or `<% %>`, as a project generator such as cookiecutter or yeoman leaves them
(`<img src="./img/{{ cookiecutter.logo }}.png" />`), is `unsafe` with the reason the HTML, CSS and
Markdown readers give such a path, and ends `dynamic`, never looked up as a file
(`foreignTemplateExpressionReason`). A `${` in a quoted string is text rather than an
interpolation, so `'./img/${name}.png'` is looked up as written, and a missing file is a real
finding.

The static text of a guessed template or chain must look like a path, and its extension must be
written in that static text. In `report.${type}` the hole is the extension. Guessing there admits
version strings (`v1.2.0-beta.${n}`), translation keys, IP address formats and source files such
as `layout.${ext}`; on the five validation repositories it admitted no image at all. A reference
in an asserting position, such as `` <img src={`hero.${ext}`}> ``, is not held to this bound,
because the author said it is an asset. The shape test is `plausiblePathShape`, the same predicate
the string rule uses, so the guessing rules cannot disagree about what a path looks like.

A template and a `+` chain that spell the same path are read the same way.
`` `/srcset/card-${width}.jpg` `` and the chain above get the same bound, the same globbing rule
(`assembledPathIsGlobbable`: a fixed directory before the first unknown segment, and at most one
unknown segment in the file name) and the same external-URL and not-a-file tests, all asked of the
assembled text. A pattern is never rewritten in either spelling, so a chain having no single range
a rewrite could replace costs nothing.

There is one difference, and it favours the chain. Where the first operand is already a complete
path, as in `'/img/hero.jpg' + '?v=' + version`, that literal stays the reference and the chain is
not read at all. The literal resolves as an ordinary path, and a rewrite edits exactly that literal
and leaves the query alone, where the template twin would be a pattern that no rewrite touches. A
complete path after the first operand is different: in `liveSite + '/img/hero.png'` it ends an
address whose start Upfly cannot read, such as a production origin a build downloads from, so the
chain is read as its template twin is and claims the literal. Rewriting the literal alone would
change that address; on eleventy-docs it made the build download a converted file the live site
did not have yet, and the build failed. A template with an unknown part keeps its own reading as a
pattern wherever it sits in the chain. A chain
is a guess wherever it is read, a JSX `src` included, so it is held to the bound even where a
template would not be. A parenthesised `+` is a single operand, because the brackets may be adding
numbers rather than joining text.

Same-file constants are read through. `const ASSET_BASE = '/gallery'` above
`` `${ASSET_BASE}/${name}.png` `` is statically knowable, so the template is judged as
`/gallery/${name}.png`, a pattern, rather than as a path whose directory is unknown. This is sound
without scope analysis under one condition: the name has exactly one binding anywhere in the file,
and that binding is a top-level `const` initialised with a string. A top-level binding is visible
throughout the module, so with no other binding of the name, every use of it is that constant. A
parameter, a nested declaration, a catch clause or a second top-level name adds a binding, and the
name stays unknown. Counting too many bindings can only refuse a trace, so bindings in every scope
count. `let` and `var` are never read, because their first value says nothing about a later use.

When a constant was read through, or the path is a chain, the text in the file is not the path.
The range and `rawPath` stay on the source text, so `source.slice(start, end) === rawPath` still
holds, and the path the text proves travels as `assembledPath`, with each unknown segment written
`${}`. A question about what the path is (the glob, the static-extension test, the external-URL
test) reads `assembledPath`. A question about where the text is (the range, a citation, a sweep for
a file name) reads `rawPath`.

Interpolations in CSS-in-JS follow the same rule. The CSS adapter reads a flattened copy of a
`styled.div` template in which each `${…}` is a comment of the same length, so to it
`url(/theme-${mode}.png)` holds a comment and is dynamic. Only the JavaScript adapter knows which
comments are its own placeholders, so it puts the source text back as `rawPath` and asks
`assembledPathIsGlobbable`. `/theme-${mode}.png` is then a pattern in a CSS block, as it is in a
template literal anywhere else in the same file.

### Character references in HTML attributes

parse5 decodes character references in attribute values, so the value it reports can be shorter
than the source text it came from: `src="a&amp;b.png"` is eleven characters of source and seven of
value. A reference's range has to cover source text, and no range into the source spells the
decoded path. The HTML adapter therefore compares each attribute's source text with parse5's value
and carries the result as a flag, `entityEscaped`.

The comparison reads line endings as the parser does. The specification's input stream
preprocessing turns each CR LF pair and each lone CR into one LF before tokenising, so in a file
saved with CR LF line endings a value that spans lines differs from its source text without
holding a character reference. A `srcset` or a `style` attribute is read path by path, and a line
break between paths is only whitespace, so such a value is read as it is in a file with LF line
endings.

A single URL is read as the browser reads it. The HTML specification calls such a value a URL
"potentially surrounded by spaces", and the URL parser strips the C0 controls and spaces at either
end of a URL and removes every tab and line break inside it. So an `<img>` whose closing quote sits
on the line below its path names that path, in a file with either line ending. Read with the line
break, the path's extension would not be an image's and the reference would vanish with no report
line; read with a leading one, a working image would be reported as broken. The reference's range
covers the URL's own text, so a rewrite leaves the whitespace around it where the author put it.
That text is compared with parse5's value as the URL parser reads it, so a CR at either end is no
sign of a character reference, and a path whose references decode to whitespace the URL parser
drops, such as `&#10;`, stays `unsafe`. A tab or line break inside the URL leaves no range that
spells what the browser reads, so that reference stays `unsafe` too, with a note saying why.

The flag is acted on only inside a reference position, once the attribute has been judged to hold a
reference. Acting on it earlier, for every attribute of every element, would turn escaped `alt`
text, other sites' links and `<meta content>` values that name no image into references the engine
says it could not handle. That is the mirror image of a silent skip: failures the engine invented, reported as
`unsafe`, which make it look worse than it is and bury the real ones.

At a reference position an escaped value goes through one helper, so every position answers the
same way:

- Another host's URL is dropped first, as an unescaped one is. An entity in a query string
  (`https://example.com/a.png?w=1&amp;h=2`) does not make the file this project's.
- A single-URL attribute whose decoded spelling is parse5's own reading of it is resolved. Its
  range and `rawPath` stay the encoded source text; the resolver also tries the decoded spelling
  (`spellingsOf`), and a rewrite writes the new path re-encoded (`spell`). `/gallery/a&amp;b.png`
  names `a&b.png` and can be rewritten.
- Any other path stays `unsafe`, and so does one whose references leave a percent-escape to
  decode, beside them or made by them, as "Percent-encoded and entity-encoded paths" explains.
- A `srcset` stays `unsafe`. It is a list, so its one range is not one path.

A `style` attribute is CSS and never meets the external-URL test: `width: 100%` begins with letters
and a colon, which reads as a URL scheme and would drop the whole attribute. Usually only its
delimiters are encoded, as in `style="background-image: url(&quot;/logo.png&quot;)"`, and the path
itself is plain in the source; read as source text, PostCSS would see the unquoted token
`&quot;/logo.png&quot;`. The adapter decodes the CSS with a map from each decoded UTF-16 code unit
back to the source offset it came from (`decodeCharacterReferencesWithMap`), hands the decoded text
to the CSS adapter, and maps each reference found back to the source. A character above U+FFFF,
such as an emoji, is two code units even when one reference spells it, and both map to the
reference's start. It keeps the result only when three guards hold, and otherwise reports the
attribute as unread:

1. The decoder finishes. A name the HTML specification does not define, such as `&eacut;`, stops
   it.
2. Its decoded text equals parse5's, line endings read as the parser reads them. parse5 also
   decodes some legacy names written without their semicolon, such as `&eacute` before a `.`,
   which our decoder leaves alone, so where the two disagree the offsets would describe text the
   browser never saw. This comparison is what makes a bounded decoder safe to use.
3. Each mapped range starts within the attribute, runs forwards, and, decoded, is the path the CSS
   adapter found, so a map off by any amount is refused. `html.guard.test.ts` checks it against a
   map with one entry per code point, which gives an emoji's two code units one entry.

An unread `style` attribute, whether escaped beyond these guards or simply not valid CSS, is
reported with a note saying whether its CSS contains `url()` or `image-set()`. Without one there is
no reference to find, and the report counts the refusal as correct; with one, a reference may be
hidden, and it counts as a miss.

A closed `<style>` element whose CSS does not parse is refused the same way, as one construct.
parse5 has already found where it ends, and a browser drops only the rules it cannot read, so the
rest of the document is still read. Only an unclosed `<style>` fails the document: everything after
it is its CSS.

### Reference shapes

Every reference an adapter emits carries a shape: the construct it was written in, such as
`html.img.src`, `css.url.in-comment` or `path.absolute-url`. A reference's resolution says what
happened to it; its shape says what it is, so outcomes can be counted per construct. The coverage
matrix (`accuracy-suite/tools/matrix.mjs`) prints one row per shape and no total, so no single
figure can be quoted out of context.

The accuracy suite's answer key, `accuracy-suite/key/answer-key.json`, defines the vocabulary, and
`packages/core/src/adapters/shapes.ts` holds a second copy as `SHAPES`, which the engine exports. Neither can
import the other. The key's checker, `check-key.mjs`, imports only `node:` modules and files beside
it, so the key is never certified by the engine it measures, and a shipped package must not depend
on a test fixture. `shapes.reconcile.test.ts` fails when the copies differ in either direction, and
both directions matter: a shape only the engine declares is a construct nothing tests, and a shape
only the tree declares is a row the matrix can never fill. The one allowed difference is
`UNTESTED_SHAPE_IDS`, the shapes an adapter emits that the tree has no instance of yet. They are
declared rather than left unnamed, because a shape with no name cannot be reported as uncovered.
The test fails once one of them gains an instance, so the list cannot outlive the gap.

#### How a shape is chosen

The vocabulary mixes three kinds of name:

- a host, the file or construct the reference sits in (`html.*`, `scss.*`, `md.*`);
- a construct, the syntactic position (`img.src`, `url()`, `import`);
- a disposition, what the path itself is (`path.absolute-url`, `decoy.comment`).

One rule picks between them: a shape names the narrowest thing whose breakage would take out that
reference and no others. That is what makes a row worth printing, since it isolates one thing that
can fail on its own. A `url()` inside a comment is `css.url.in-comment` in every host, because
comment handling is the CSS reader's job and breaks the same way in `.css`, `.scss`, `.less` and a
`<style>` element. A plain `url()` inside `<style>` is `html.style.element`, because what would take
it out is the HTML adapter failing to extract the CSS, not the CSS parse.

That rule chooses within a kind. Between kinds, a disposition takes precedence: a path spelled with
character references, or an absolute URL, is keyed by its `path.*` shape whatever attribute holds
it, because its spelling is what would take it out. Every disposition carries a `path.*` id, so its
kind, and with it the precedence, is visible in the name.

One kind of shape outranks all of this: a shape that declares `formatKept`. The shape is the only
place the planner learns that a reference must never be rewritten, so a percent-encoded link
preview stays `html.meta.content.image` rather than becoming `html.percent-encoded`, and a Markdown
or Astro host keeps it rather than relabelling it as its own.

Because the choice depends on which part of the engine could fail, no function can derive a shape
from the syntax. Each adapter names the shape where it emits a reference, and `ShapeId` is derived
from `SHAPES`, so naming a shape that does not exist is a compile error.

A row must be homogeneous. When a shape's entries turn out to fail in different ways, the shape is
split rather than given a mixed class: the three `html.link.href.*` rows exist because
`linkImageClaim` claims icons and preloaded images in two independent branches, and what it refuses
is a third case. A row is named for what its references assert, not for what its current entries
happen to contain.

#### What a zero means

Each shape declares an emission class, which is what the engine as a whole reports for it:

| class | meaning | how the matrix reads the row |
|---|---|---|
| `engine` | the engine reports a reference | found against expected; a miss is a bug |
| `gap` | no adapter reads the construct yet | zero is expected, and each entry's `knownGap` records the missing reader |
| `declined` | the text is not a live path to a file | zero is correct; a reference here is a false finding |
| `unclaimed` | a real, reachable file the engine chooses not to index | reporting nothing is a scope decision, not a defect |

The matrix counts each class as its own population and never adds them together. Only `engine`
rows form the claimed population, the one place a miss is a defect. The class belongs to the shape,
while each tree entry keeps its own expected outcome, so a claimed shape can hold an unclaimed
target: `html.video.src` is `engine`, and its entries naming an `.mp4` are keyed `out-of-scope`.

#### Which layer decides

The class describes what reaches the report, not what an adapter emits. For some shapes the two
differ, because the distinction needs a fact only the resolver has:

- `decoy.typo`: a name one character from a real file cannot be told from a real path without
  checking the disk.
- `js.import.alias.mapped` and `js.import.alias.unmapped`: only the `tsconfig` or Vite paths table
  says whether an alias maps anywhere.
- `json.webmanifest.other`: telling a screenshot from an icon needs the array the entry sits in,
  which the JSON adapter does not parse.
- `pattern.partial`: whether a pattern matches every file it names depends on which files exist.
- `decoy.windows-path` in JavaScript, for another reason: a backslash can only be written there
  as an escape, and the adapter returns every path-shaped string written with escapes as a
  declined `js.string.literal`, whatever it spells, for the resolver to discard.

For these, the adapter emits a broader shape, the shape declares it in `adapterEmitsAs`, and
`needsToSee` names the fact the adapter lacks. When the engine's shape and the key's disagree, the
matrix reads `adapterEmitsAs` to tell a correct difference of layer from a defect. The declaration
lives on the shape rather than in an exemption list inside the measuring harness, because such a
list goes stale silently: an entry that is no longer needed still suppresses. The reconcile test
checks that every id in `adapterEmitsAs` is another real shape and that `needsToSee` is given.

A declaration can cover part of a shape. Inside `import` or `require()`, a bare specifier such as
`some-ui-kit/dist/logo.png` is module syntax, and the adapter names `path.bare-specifier` itself. In
a plain string the same text could be a relative path written without `./`, so there the adapter
emits `js.string.literal` and the resolver reads it as an ordinary path.

How the accuracy suite measures the engine against these shapes, and what its results say about real repositories: `accuracy-suite/README.md`.

## Discovery

`discover` walks the project once and returns three lists: image assets, the source files some
adapter has claimed by extension, and the files nobody claimed. It is one of the modules that touch
the disk.

It is a hand-written breadth-first walker rather than a glob library, for one reason:
**the performance budget is won by pruning, not by matching.** A repository's `node_modules`
usually holds more files than everything else combined, and the only way to stay under the
budget is to never descend into it at all. A glob has to consider each path in order to reject
it; a walker drops the entire subtree on a single directory-name lookup.

Directories are read a level at a time, up to sixteen at once, the next starting as soon as any
finishes, and the same bound applies to the `stat` of each image afterwards. The limit is there to
avoid exhausting file descriptors, not to match CPU count, since this work is entirely IO-bound. A
shared work queue across levels would parallelise slightly better at the very top of the tree, but
needs active-worker bookkeeping to stop workers exiting while a peer is still producing work, and
this module is meant to stay readable.

What it declines to do, it records. Symlinks and Windows junctions are not followed (a junction
reports as a symlink to `lstat`, which is why the check comes first: following one can put the
walk into a cycle or outside the root). Unreadable directories, unstat-able files and anything
that is neither a file nor a directory each land in `skipped` with a reason. None of it is
silently dropped.

Two details that are easy to get wrong:

- **Reported paths are POSIX-separated and relative to the root**, normalised in exactly one
  place. Ordering uses a code-unit comparator, never `localeCompare`, which is locale-dependent,
  so the same repository would produce differently ordered reports on two machines and the
  byte-identical-report rule would quietly become false. For the same reason an extension is
  read as `path.posix.extname` reads it on every platform, by the resolver, the planner,
  discovery, the adapters and the probe alike: with the platform's own `extname`, the Markdown
  destination `img/hero\.png` would show no extension on Windows and `.png` on Linux, and
  the plan would rewrite it on one machine only. A path that ends in `/` has none: `extname`
  ignores the slash and reads `img/hero.png/` as a `.png` no server sends for it, which a plan
  would rewrite to `img/hero..webp`.
- **`.upflyignore` is matched with the `ignore` package, and a directory must be tested with a
  trailing slash.** Given a `build/` rule, `ignores('build')` is `false` and `ignores('build/')`
  is `true`. Get that wrong and the walker descends into every ignored directory without ever
  reporting an error.

`.gitignore` is deliberately *not* honoured: generated-but-referenced assets under `public/` are
routinely gitignored, and skipping them would produce false "dead asset" findings. In a project
inside a bigger repository, "ignored" would also depend on a repository the user may not know
about. A site built before Upfly runs is handled by name instead: the folders only a tool writes
(`dist`, `build`, `out`, `_site`, `.next`, `storybook-static` and the rest of the list in
`discover.ts`) are pruned, so a built Eleventy site's second copy of every image is not read as
source.

**`public` is a source folder's name as well as a build's, so the settings beside it decide.** Vite
and Next.js serve `public/` as written; Hugo, Gatsby and Hexo build a whole site into it, with a
copy of every image the site serves. Read as source, that copy is what a post's `/img/a.png`
links, so a run would convert it and rewrite the post to name `/img/a.webp`, a file only the
build output holds, which the next clean build does not make. So `public` is pruned when the
generator's own settings file sits beside it, each list taken from the generator's own source:
`hugo.toml`, `hugo.yaml`, `hugo.yml` or `hugo.json`; `gatsby-config.js`, `.mjs` or `.ts`; and for
Hexo, whose `_config.yml` is also Jekyll's, a `package.json` whose `hexo` field is an object, the
test Hexo's own command uses to find a site. Hugo's older `config.toml` is other tools' name too,
so it does not decide. A generator Upfly does not know, or an output folder moved by its settings
(Hugo's `publishDir`), is still read; when a plan would then write into a git-ignored path,
`optimize --commit` refuses before writing anything and names the folder to leave out with
`--exclude`.

Discovery also records **what it excluded, and why**. Every pruned directory lands in
`excludedRoots` with the rule responsible: a built-in name prune, a generator's settings file, or
the specific `.upflyignore` pattern that matched, and `byRule` says which were the project's own
rules. It keeps the raw pattern list to do that, because `ignore` reports *whether*
a path matches but not *which* pattern did, and "excluded by some rule you wrote" is a much worse
report line than "excluded by `legacy/`" when someone is working out where their asset went. The
resolver prefix-tests references against these to produce `out-of-scope` instead of a false
`broken`. Each image a rule excluded by name lands in `excludedImages`, so the report can tell a
reference into what the project asked to leave out from one with no answer.

It records what it **did not read**, too. Every file no adapter claimed lands in `unscannedFiles`
with its path, which is what the audit sweeps to decide `dead` against `possibly-dead`. Ignored
and pruned entries are deliberately absent (an ignore rule is an instruction, not a gap in our
coverage), and so is the ignore file itself, which we obviously did read. The report still names
what the project's own rules left out, since an image used only there shows as unreferenced; the
directories the walk prunes are not listed.

One reader looks past an exclusion: the search `optimize` makes before `replace` deletes an
original. An exclusion limits what a run changes, not what it checks before removing a file that a
page it left out may still show. So the walk keeps each file a rule excluded by name in
`excludedFiles` (raster images aside, which name nothing), and `listExcludedFiles` lists what the
excluded directories hold. The directories the walk prunes stay unread even then: dependencies,
caches, build output, version control and `.upfly` hold no page the project serves from its own
sources, and build output is made again from them.

## Scanning: one place that owns adapter failure

`scan` reads each source file and hands the text to the adapter that claimed it. It exists
because nothing owned that loop, and because the adapters throw.

`css` and `javascript` raise `ADAPTER_PARSE_FAILED` when a file will not parse. That is right
(returning `[]` would report a file full of references as clean), but a throw nobody catches means
**one unparseable `.scss` in a five-thousand-file repository kills the whole audit**, and real
repositories contain one. So `scan` catches it into a reported entry carrying the file and the
parser's message, and that entry feeds the same per-asset sweep as a file no adapter claimed. The
two are the same condition: we did not learn what the file references.

It catches *every* throw, not only ours. Adapters are the contribution surface, and a bug in a
community adapter must not take down an audit of a repository that adapter barely touches, while
still being visible in the report rather than merely survived.

`readFile` is injected, so the module that owns error handling for every adapter is exercised
against an in-memory file map instead of a directory full of deliberately broken files. It
deliberately does not return the file texts: holding a whole repository's source in memory to save
a later re-read trades a bounded cost for an unbounded one.

### Skipping files that cannot hold a reference

Before handing an html, json or markdown file to its adapter, `scan` asks `couldHoldReference`
whether the text contains any token a reference is built from. If it contains none, no adapter
could produce a reference from it, certain or dynamic, and the parse is skipped. The check is a
lowercase substring search, far cheaper than a parse.

It is not used for css, javascript or astro. Those adapters wrap real parsers (postcss and Babel)
that reject invalid input whether or not it holds a reference, and that failure must still reach
the report as a file that could not be parsed. A stylesheet such as `a { color: ; ;; }} unclosed`
holds none of the tokens and is still reported.

One exception runs the other way. The Markdown adapter hands the top-level `import` and `export`
blocks of an `.mdx` file to the JavaScript adapter, and Babel can reject them, so a token-free
`.mdx` file whose `import` or `export` block does not parse is skipped instead of being reported as
a file that could not be parsed. That is accepted for three reasons. No reference is lost, since
without a token there is nothing to find. MDX itself refuses to compile such a file, so its author
already knows. And the alternative is expensive: in the five validation repositories, 1,637 of
2,905 `.mdx` files carry `import` or `export` blocks, nearly all of them component imports, and
taking `.mdx` out of the skip would parse every one of them to find nothing.

The token list is where the risk sits. A token missing from it drops a finding with no error,
which is the silent skip the engine treats as its worst bug. A token too many only costs a parse.
So the list errs wide (`style` matches the word "styling" in prose) and has four families:

1. Every tracked image extension.
2. Constructs that mark a reference position without an extension: `url(`, `image-set(`, the
   attributes `src`, `href` (which also matches `xlink:href`), `poster` and `style` (which also
   matches `styled`), and the CSS-in-JS tags `keyframes`, `createGlobalStyle` and `injectGlobal`.
   `url($icon-path)` in SCSS is reported as `dynamic` and holds no extension at all.
3. Encoded spellings. The resolver also tries a path's entity-decoded and percent-decoded forms, so
   `![alt](hero&#46;png)` resolves to `hero.png`. Of the named references the HTML specification
   defines, only `&period;` spells an extension character, so the tokens are `&#` and `&period;`.
   Percent-decoding applies to any character, and `hero.%70ng` is `hero.png`, so the token is `%`
   rather than `%2`.
4. Template markers, the opener of every syntax in `TEMPLATE_HOLES`. A templated destination such
   as `![logo]({{ site.logo }})` is reported as `dynamic` and has no static extension.

The skip decides per file: one token anywhere parses the whole document. A test of one spelling
therefore needs a file of its own, because a file holding several spellings is parsed if any one of
them is handled, and cannot show which. The accuracy suite keeps `encoded-entity.md`,
`encoded-percent-dot.md` and `encoded-percent-letter.md` apart for this reason.

One gap is accepted. A CSS-in-JS block with the bare `css` tag, whose body does not parse, which
contains no `url(` or `image-set(`, in a file with no other token, is skipped along with its
`dynamic` finding. Since the JavaScript adapter reads the `import` and `export` blocks of `.mdx`
files, such a block can reach a skippable adapter inside an MDX `export`. `css` is not a token
because it is common in both prose and code (`import './x.css'`, `className`), and matching it
would cost most of what the skip saves.

## The graph

`buildGraph` is pure. It links each reference to the assets it resolved to, **through
`linkedPaths`, never by comparing `resolution`**, and returns an `AssetNode` per asset alongside
`byResolution`, every reference bucketed by outcome.

That bucketing is a correctness device, not a convenience. It is a `Record<Resolution, …>` literal,
so an eighth outcome fails to compile *here* rather than quietly vanishing from the report, the
same guarantee `linkedPaths` gets from its `never`-typed default. A reference cannot go missing
from the report without also going missing from a bucket, which makes "every skip is reported"
mechanical instead of remembered.

**Ordering is by POSIX-relative path, not by `Reference.file`.** `file` is an absolute native path,
and `/` (0x2F) and `\` (0x5C) fall on opposite sides of the alphanumerics: sorting it puts
`dir/a.html` before `dirZ.html` on Linux and *after* it on Windows. The promise that the same input
gives a byte-identical report would then be quietly false, and nobody would notice until two people
compared reports. The test for it only has teeth on Windows, because on POSIX the relative path is
a suffix of the absolute one and the two implementations cannot disagree.

A reference that links to a path outside the asset set throws `GRAPH_UNKNOWN_ASSET`. That cannot
happen in a single run (the resolver only ever returns paths it took from those very assets), but
it can the moment references are resolved against a cached asset set, which is exactly what the
editor integration will do. The quiet version of that bug is a phantom dead asset.

## The probe, and why it has two methods

Two of the four audit findings need pixels: `oversized` needs dimensions, and format opportunities
must be **measured**, not guessed. `ImageProbe` is the port that provides them, injected like the
resolver's `exists`; `createSharpProbe` is the implementation and one of the modules that touch the
disk. `encodeToFile` adds the write `optimize` needs to the same port, so a file is written by the
code that measured it.

The port is split into `metadata()` and `encodedBytes()` because the two cost wildly different
amounts. Measured on sharp 0.35.4 / libvips 8.18.6 with noise-filled sources:

| source | `metadata()` | webp | avif |
|---|---|---|---|
| 400×300 | 2 ms | 56 ms | 317 ms |
| 1200×800 | 1 ms | 370 ms | 2 975 ms |
| 2400×1600 | 1 ms | 2 620 ms | 9 026 ms |

Reading a header is free and independent of pixel count; an encode is three orders of magnitude
dearer and AVIF is roughly eight times WebP. A single combined `probe()` would make every caller pay
for an encode to learn a width, so dimensions are always affordable and encoding is something a
caller asks for by name: `formats` is required and has no default, because the default belongs to
configuration: webp, with AVIF opt-in via `--format avif`. The audit measures the format it would
actually convert to; measuring one the tool would not produce is work nobody asked for.

### The cap is a count, not a threshold or a deadline

Even at WebP alone, two thousand images is twelve minutes, and `audit` is meant to be the fast
read-only command. So `maxEncodedAssets` bounds how many assets are encoded, and the two obvious
alternatives are both wrong:

- **A byte threshold bounds nothing.** Encode cost tracks pixel count, not file size, so a threshold
  does no work at all on a repository of three thousand large images, precisely the "large public
  directory" that the validation protocol requires us to test against.
- **A duration budget would break byte-identical output.** The same input must give the same
  report, so a slow machine must not measure fewer assets than a fast one.

Selection is largest source first, ties broken by path, so *which* assets are measured is a
deterministic function of the repository. Assets that could never be encoded (a vector, or one
already in every requested format) leave the running before the cap applies, so they cannot occupy
a slot they will not use. A byte or pixel floor can sit underneath as a secondary filter; the count
is what bounds. Every asset competes for the cap alike: a pattern's targets get no exemption, since a
pattern is never rewritten.

What makes this safe is that it degrades exactly **one** of the four findings. `dead` and `broken`
need no probe at all, and `oversized` needs only the ~1 ms header read, which still happens for every
asset however low the cap goes. Everything past the cap is reported as unmeasured, with a count, a
reason and the flag that lifts it; silence would read as "no opportunity here". The default comes
from `bench/` rather than a guess, like the concurrency number.

### `audit`'s savings are `optimize`'s plan

`upfly audit` states what `optimize` would convert and save with the same folder, options and
config, never a saving `optimize` would not deliver: an unused image's size is already in the
Unused row. So `audit` encodes only the images a plan could convert (`convertibleImages`: an image
with a reference that would move to the new file, judged by the rules that need no measurement),
reads every other image's header as before, and plans with `optimizeFromPipeline`, the function
`optimizeProject` runs after its own pipeline. Measuring every convertible image gives the same
plan as measuring every image: every other image is declined for a reason no measurement changes,
so the set the plan starts from, and everything decided after it (collisions, references that
would lead elsewhere, the search for mentions of a removed original), is the same. A test runs both
on three fixtures under both policies.

The cap then chooses among the convertible images, and the figure past it is marked "at least".
That needs the capped plan to convert nothing the full plan would not. An image measured or not
changes another's fate only through a file both would be converted to, or a reference that would
reach the other's converted file, and either needs the same file name. So the cap takes every
convertible image whose name, less its extension and in any letter case, matches one it took: a
`logo.png` measured without its `logo.jpg` would seem free to become `logo.webp`.

### Animation is the trap

Encoding an animated GIF the obvious way keeps **one frame**. Sharp's own ten-frame, 370×285 fixture
encodes to 616 bytes that way, against 8 370 bytes for the real thing. Reported as a format
opportunity that is a ~92% saving achievable only by destroying the image: a headline finding in the
audit and a corrupted file when the rewrite acts on it.

The asymmetry is the thing to remember: **`encodedBytes` must pass `animated` and `metadata()` must
not**, and getting either backwards produces a confidently wrong number in opposite directions: a
phantom 92% saving, or an image reported ten times too tall.

So `encodedBytes` takes `animated`, and `probeAssets` passes `pages > 1` from the metadata it already
holds. And `metadata()` is deliberately a *plain* read: with `{ animated: true }` that same file
reports 370×**2850**, every frame stacked into one strip, which would make an "oversized by
dimensions" finding wrong by a factor of ten. The plain read gives one frame's dimensions and still
reports `pages`, answering both questions in one pass.

AVIF is the other half of the trap. sharp writes AVIF as a single still image, so an animation
encoded to it with `animated` comes out as one picture of every frame stacked: a six-frame 24×12 GIF
becomes one 24×72 still, far smaller than the GIF, which the probe would report as a saving and
`optimize` would write in its place. So an animation is never measured as a format in
`STILL_ONLY_FORMATS`: the skip, `drops-animation`, says why and that WebP keeps the animation. The
sharp probe also refuses that pair outright, so no caller of `encodeToFile` can write one.

An animated PNG is the third form. sharp reads one as its first frame and reports no pages, so it
would be measured and converted as a still, and `--replace` would delete the animation. So
`metadata()` reads a PNG's frame count from the file's own `acTL` chunk, which the format puts before
the first image data, and an animated source in `FIRST_FRAME_ONLY_SOURCES` is measured in no format,
with the same code and its own reason.

### An image is converted as it is shown

Phones store most photos as the sensor read them, and record the turn a viewer applies in the EXIF
orientation tag. The encode drops metadata, that tag with it, so every encode, the measuring one and
the written one alike, turns the pixels first (sharp's `autoOrient`). Without it the converted file
shows sideways, and under `--replace` the original, which showed correctly, is deleted. `metadata()`
reports the size as shown too, so `oversized` names the side that is too long as a viewer sees it.

An embedded colour profile whose primaries are sRGB's is converted through and dropped, as sharp
does by default, so an ordinary photo pays nothing for it. sRGB is named as the target
(`withIccProfile('srgb', { attach: false })`): left to the default, a 16-bit image ends in another
space's numbers once the profile is dropped, and pure red was written as 234, 51, 34; for any other
image the bytes are the same. Any other RGB profile, Display P3 and wider, is kept with the numbers
it describes (sharp's `keepIccProfile`): converting through it into sRGB would bring its most
saturated colours inside sRGB, and a wide-gamut screen would show them duller than the original. The
kept profile costs its own bytes, about half a kilobyte for Display P3, and since the measuring
encode and the written one make the same choice, the saving shown includes that cost. A grey or CMYK
profile cannot describe the RGB that WebP and AVIF store, so it is converted into sRGB. A profile
that records no primaries is kept, since nothing short of converting through it tells whether its
colours fit inside sRGB.

### Lossless WebP for PNG sources

For a PNG source, the probe measures two WebP encodes, one at the configured quality and one
lossless, and keeps whichever is smaller. A lossless encode is bit-exact, so when it is also smaller
it is better on both axes and there is nothing left to weigh. The choice needs no classifier for
text-heavy images and never consults a perceptual metric. That matters: PSNR rates text-heavy images
higher at every quality, so it would argue for lowering quality on exactly the images that lose most
from it. A byte comparison against an exact encode cannot be misled by a metric it does not use.
If the lossless encode fails, the measurement at the configured quality stands, and the library's
message goes to the diagnostics rather than the report.

The trigger is the source container, not the picture. `bench/src/lossless-cohort.ts` encodes every
raster image in the five validation repositories, 5,857 of them: lossless beats webp 80 on 1,736, by
30.2% at the median, and 1,689 of those are PNG. A JPEG source wins 7 times in 1,693, because
encoding already-lossy pixels exactly preserves their artefacts at full price. Restricting the
second encode to PNG keeps 97.3% of the wins and skips 34% of the second encodes, which are not
free: a lossless encode costs about 1.3 times a lossy one.

One entry per format is recorded, and it carries its setting: `EncodedSize.quality` is a number or
`'lossless'`. `'lossless'` is not a quality of 100, since a lossy WebP at 100 is not bit-exact, and a
number standing in for it would misdescribe the encode to everything that formats it. The planner's
savings, the audit's format opportunities and the report's per-format grouping all assume one
measurement per format. Because the setting varies per image, a summary across assets (the report's
`savingQuality`) collects the settings rather than keeping one, and `PlannedConversion` carries the
setting to `encodeToFile`, so the file `optimize` writes is the one whose saving `audit` reported.

AVIF has no lossless option. On the text-heavy images lossless WebP is aimed at, `avif 75` already
saves 25.6% at the median with a worst SSIM of 0.9934, and lossless AVIF has not been measured. An
option nobody has measured is one nobody should be able to select.

### Nothing throws for a bad image

A zero-byte file, a truncated JPEG, a text file wearing a `.png` extension, a file that vanished
mid-run: every one becomes an `AssetProbe` carrying `metadata: null` and a recorded reason. Sharp
rejects for all of them and `failOn: 'none'` does not help, since it governs decode warnings rather
than header parsing. Measurements not taken are listed with reasons for the same reason skipped
references are: silence would read as "no opportunity here".

Sharp is imported **lazily**. It is a native module, and the previous generation of this project
shipped one built for a single platform and was broken everywhere else for months. A top-level
import would load the binary the moment anything in `upfly-core` is imported, so
`upfly audit --no-probe` would fail on a machine that needs no pixels at all.

### The recorded reason is ours, and the library's is not in the report

The same input must give a byte-identical report, and a failing decode is where that promise nearly
died. libvips does not word the same failure the same way twice: reading four corrupt SVGs 160 times
at probe concurrency gives the full message on most reads and a bare `Input file has corrupt header:`
with nothing after it on the rest. Because the report sorts its skipped list by reason, an unstable
sentence moved entries as well as changing them.

So the report carries one sentence per failure code, written by us, and the library's own text goes
to `ProbeOptions.onDiagnostic`. **There is deliberately no field for it on `ProbeSkip`.** A field
would sit inside the value the report is built from, and keeping it out of the output would then be
a rule someone has to remember; with no field there is nothing for a renderer to print or a sort to
key on. An absent sink drops the text rather than storing it, so a caller with nowhere to put it does
not quietly acquire an unstable string.

The general form is worth more than the instance: **a third-party library's error text does not
belong in an artefact we make a determinism promise about.** It is free to change between versions,
and it describes the library rather than describing what Upfly did.

Dropping the library's text loses nothing a reader needs, because the failure codes carry the
distinctions that matter. They are enumerated by what a reader can do about the failure, not by what
libvips said, and there are only three answers: supply a real image (`not-an-image`), fix the SVG
(`svg-unreadable`), or make the image smaller (`too-large-to-encode`). `encode-failed` remains for a
failure nothing classifies, so that it still reaches the report. The list is bounded, since it does
not grow when libvips adds a message, and each code is decided from our own data. A header failure
is split by extension: a `.svg` that will not read is an SVG to fix, and anything else is not an
image. An encode failure is `too-large-to-encode` when the measured width times height times frame
count exceeds `MAX_ENCODE_PIXELS`. That limit equals sharp's default `limitInputPixels` and is passed
to sharp explicitly, so our arithmetic and the limit in force cannot drift apart. In the five
validation repositories, 21 measurements fail: 8 files that are not images (HTML error pages saved
as `.png`, Git LFS pointers, zero-byte placeholders), 12 unreadable SVGs (no usable width and height,
malformed XML, or too large for the XML parser) and 1 image past the pixel limit.

### Two paths are the same file more often than they look

Windows and macOS fold case; Linux does not. `Reaktor.jpg` and `reaktor.png` convert to `Reaktor.webp`
and `reaktor.webp`, which are two files on one platform in the CI matrix and one file on the other
two. Every comparison here folds case when the question is *would these end up as the same file*: the
planner when it groups conversions by target and when it checks where each reference would lead once
a plan is applied, and the transaction when `prepare` claims a path. The planner's target check also
lists the target's folder, names only, so a file the walk excluded that already holds the converted
name declines that one conversion, where `prepare` would refuse the whole run.

Folded on **every** platform, not only where the filesystem demands it. Folding everywhere costs a
conversion on Linux that would have been safe there. Not folding means one repository gets a different
plan, a different report and a different set of files depending on where it runs, which no promise
about determinism survives.

## Offsets are UTF-16 code units

`start` and `end` are indices into the JavaScript string, the same units every JS parser and
`String.prototype.slice` use. They are deliberately **not** byte offsets. A file containing an
emoji or a non-ASCII path would desynchronise the two, and every rewrite after that point
would land in the wrong place. There is a test for this in `edits.test.ts`.

### A source file that is not UTF-8

Source files are read as UTF-8 and written back as UTF-8. That round trip reproduces a valid
file's bytes, a byte-order mark included, and no other file's: each byte that is not UTF-8 reads
as U+FFFD and would be written back as that character's three bytes. So the scan records whether
a text holds U+FFFD (`ScannedText.holdsReplacementCharacter`), and the planner declines every
rewrite in such a file with that reason, which a dry run shows; under `replace`, an original a
declined reference still needs is kept, as for any declined reference. The file is still read,
and its references still link, so nothing it names looks unused. The exception is a path that
itself holds U+FFFD: the page named a file in bytes that did not decode, `café.png` written in
Latin-1, and that name cannot be read back, so the scan refuses the reference (`unsafe`, with the
reason) rather than letting a lookup call a file that exists broken. The sweep then hedges each
image the path could spell, reading each U+FFFD as one character, the one byte a single-byte
encoding wrote there, and the rest as ending the image's path in whole segments: `img/caf�.png`
hedges `img/café.png`, not `img/cafés.png` or `photos/café.png`. A name holding U+FFFD in text
no reference reads is not spelled this way. A valid file that holds U+FFFD itself cannot be told
apart from the text alone, and loses only its rewrites.

The transaction makes the precise check for a caller that builds its own plan: `prepare`
refuses an edit target whose bytes differ from its text re-encoded as UTF-8.

## Edits and `applyEdits`

`applyEdits(source, edits)` is the primitive underneath every adapter's `rewrite`. It applies
range replacements from the end of the string backwards, so offsets earlier in the document
stay valid without any arithmetic.

It is deliberately strict, and throws rather than guessing when:

- a range is not a valid slice of the source (`INVALID_EDIT_RANGE`)
- two edits cover overlapping text (`OVERLAPPING_EDITS`)
- two edits start at the same offset, where the result would depend on order
  (`AMBIGUOUS_EDITS`)
- an edit carries the text it expects to replace, and its range holds anything else
  (`EDIT_TEXT_MISMATCH`)

The planner gives every edit its reference's `rawPath` as that expected text. An edit is then
applied only to the text it was worked out from: an edit landing on moved text, or offsets
an adapter miscounted, is refused rather than written into the middle of something else.

`validateEdits` runs the same checks without applying anything. `applyEdits` and `invertEdits` call
it, and so does the transaction's `prepare`, which rejects a whole run before a single byte is
written.

## The transaction

Writing is two-phase, because a half-applied run is worse than a failed one.

**Prepare**: with every image already encoded into `.upfly/runs/<run-id>/`, back up the bytes of
anything that will be destroyed, compute every edit in memory, and check the whole plan. Any
failure here leaves the working tree completely untouched.

**Commit**, in this order, and the order is the design:

1. **write `.upfly/manifest.json` in `pending` state**, before a single file is touched
2. create new files: staged images into place, and the destination half of every move
3. apply the text edits
4. remove what is now superseded: deleted originals, and the source half of every move
5. rewrite the manifest in `committed` state

The manifest comes first because it is a statement of intent, not a receipt. A crash at any later
step leaves a `pending` manifest that `undo` can act on; a manifest written after the images and the
edits would leave a crash with a changed tree and no record, which is the one state `undo` cannot get
out of.

**The three write phases are separate functions, and each takes a witness value that only
the previous phase can produce.** That is not decoration. Step 4 is safe only because step 3
completed over *every* edit rather than running per asset: interleaved into a
create-edit-delete loop one asset at a time, asset B's delete runs before asset A's edits and
any file naming both is momentarily inconsistent. The crash matrix cannot see that, because it
injects failures by mutation count and an interleaved loop produces the same count in the same
order. The witnesses make the phases impossible to reorder; they do not make a per-asset loop
impossible, but they remove the innocent version of it, where three loops are merged into one
and nothing in the diff says an invariant died.

**Every prefix of that sequence leaves a tree that still builds**, under either policy. Files
appear before anything points at them, and originals are removed
only once nothing points at them any more. A move is committed as a copy in step 2 and a
removal in step 4 for exactly this reason: between the two, both paths exist.

**What `replace` converts, and which originals it removes, are the planner's decisions, and they
are two halves of one property.** An asset converts only when the plan moves at least one
reference to the new file, and its original is deleted only when the plan moves every reference
that links to it and no reference reaches it in another letter case. So under `replace` an asset
ends one of three ways:

| the asset | outcome |
|---|---|
| every reference to it moves | converted, original deleted |
| some move, and one the plan cannot move still needs the old file (a pattern, a refused literal, a path with no extension to change, a link preview or a link to the image, or a path that reaches it only in another letter case, which Windows and macOS follow) | converted, original kept, and `keptOriginals` says which reference needs it |
| no reference would move: nothing links to it, or only references the plan cannot move | not converted, and `declined` names what holds it |

What `replace` never produces is a converted copy nothing asks for beside an original that has to
stay, which is the pair of files the policy exists to avoid. The conversion half holds under
`keep-original` too: a converted copy no reference moves to is loaded by no visitor, so its size is
no saving, and the report's savings count only what a visitor downloads less of. Only the first and
second rows differ there, since `keep-original` never deletes an original.

A saving too small for the report to count is not converted either. The audit counts a saving from
1 KB, and then only when it is 10% of the file or 100 KB in all; the planner asks the same function,
`whySavingTooSmall`, last of its checks, so every conversion is a saving the report counts. The two
totals differ only by the images the plan declines for a reason of its own, each listed with it.
Converting a 70-byte icon to save 34 bytes would rewrite a reference, and under `replace` delete an
original, for nothing a visitor would notice.

The report counts the plan's declines in two places: images under `declined`, with their sizes,
and the references a plan left as written under `declinedReferences`, so a pattern that stays as
written is never counted as an image.

**Served means under any serving root the resolver used.** `replace` removes an original there and
among the images a build loads alike, since a bundled image's published name changes with every
build and nothing outside links to it; the dry run counts the removed originals that are served,
where an outside link may break. The planner is handed the same `ServingRoots` value the resolver
was, not a folder derived beside it, so an image in a monorepo's second website folder is as served
as one in its first.
Moving a file between two website folders is refused by `relocate`, because a URL that finds it in
one will not find it in the other. When the run found no serving root and the project declared
none, nothing counts as served: every original is kept, and the report says so and how to name the
folder. Guessing the project root instead would remove that protection from every project that
has no website folder at all.

The conversion half is decided per asset before collisions and before any reference is repointed,
so every sentence the plan writes afterwards is about assets that really convert. Asking that early
gives the finished plan's answer because whether a reference moves depends only on the reference
once its one asset converts; a pattern, the only reference that links several assets, never moves.
The deletion half runs last and does not rely on the first: it keeps the original of an asset
nothing links to on its own account, so loosening the conversion half can never delete a file.

**A plan must not change where a reference leads.** A repointed reference has to lead to the
converted file, and every other linked reference to the files it leads to now. A rewrite changes
only the extension, and from the file that holds it the new name can reach a file the old name
never did: an image of that name in a nearer serving root, or one that an alias rule or target
tried earlier maps to. A converted file is new, so a reference the plan leaves as written can
find it in the same places before the file it names now: `/img/banner.webp` on a page that
`apps/web/public` serves first would load a `banner.webp` converted there instead of
`public/img/banner.webp`. The collision check looks only at the converted file's own path. So
once a plan's rewrites are chosen, every linked reference is resolved again from its own file,
with its new text where the plan rewrites it, against the files the plan leaves (every converted
file added, every original it removes gone) and with the run's serving roots and aliases, and
compared with where it leads now. A literal has to lead to the same file, or to its converted
file when rewritten; a pattern may gain a converted file beside those it matches but must not
lose one. A conversion that breaks this is withdrawn: one of whose rewrites would reach anything
else, with a decline naming the file that rewrite would reach, or whose new file a reference left
as written would reach first, with a decline naming that reference and the file it reaches now.
Under `replace` its original stays. Withdrawing a conversion changes those files and drops its
rewrites, so the plan is made again without it until the check withdraws nothing.

The check counts every file that exists, not only the walk's images: an ignore rule limits what a
run changes, not what a browser loads, so a nearer `logo.webp` named in `.upflyignore` or inside a
folder `--exclude` names still takes the page. `optimize` gives the planner a way to list a
directory, and a file the walk did not index is found by listing each directory on the way to a
place a path could lead: inside the project, and under an alias target outside it, since
`../shared/*` in a monorepo package can reach a file there first. Only names are read, never a
file, and the disk is only read. The resolver's optional `unindexed` port asks for it wherever its
index misses, in the order it looks, and both sides of the comparison are read that way.

The check folds case on every platform, as the collision check does (see "Two paths are the same
file more often than they look"): on Windows and macOS `/img/logo.webp` loads a nearer `Logo.webp`,
or a `logo.webp` in a folder named `IMG`, and a plan must not depend on where it runs. The
resolver's index folds when asked (`foldCase`), and the directory listing matches names whatever
their case. Both sides are read folded, so a reference that reaches an original only by folding
case, and that the plan leaves as written, loses that file when the plan removes it; the
conversion is withdrawn for that too. A decline whose match depends on case says so. A reference
that links nothing as written, because it spells the path in another case, is resolved again
folded as well, whatever it is (a literal, a guess, a pattern), and an original one of them
reaches is kept, its reason saying to fix the letter case.

The old-path text search (see "Moving an asset") then guards the references the graph never found,
for a path written down literally. **The bound that remains:** a path assembled at runtime that the
graph did not find, pointing at an asset some other reference links and this run moves. The text
search cannot see it, because it is not written down, and the planner cannot, because it is not a
reference it knows, so that original goes. It is the one way `replace` can still remove a file a
page asks for.

**Recovery is a pure function of the manifest and the current disk.** Every operation records
the content hash on both sides, so hashing a file says whether that operation ran. Nothing
depends on how far a counter got before the process died, and commit therefore keeps no journal
of its own progress. A file matching neither hash was changed by something other than the run:
the transaction refuses to touch it and names it in the error, because silently writing over
somebody's work is worse than leaving a run half applied.

**That check is made again at the moment of writing, not only in prepare.** A file an editor saves
after prepare leaves edit offsets that no longer describe the text, and applying them would both
corrupt the file and store an undo that does not fit it: damage `inspect` would report afterwards
rather than prevent.

**And it starts at the scan, not at prepare.** Every offset counts into the text the scan read,
so the scan records a hash of that text (`ScannedText`), the graph keeps it, and the planner
copies it into each rewrite (`textHash`). `optimize` stages the encodes first, which can take
minutes, and only then reads each file it rewrites; a file whose text no longer matches the
scan's is refused there, before anything is written. Without that, the hashes prepare and
commit check would be taken from the file as saved, and the scan's offsets would be applied
to it with every check passing. Images get the same treatment: each original is hashed before
its encode and checked after the encode and after its backup, so the file converted, the file
backed up and the file a delete expects are one file, and an image removed or saved meanwhile
is a refusal naming it rather than a crash.

**There is no separate "recover an interrupted run" path.** Undoing a finished run and cleaning
up an interrupted one are the same job (reverse whatever the disk says actually happened), so
there is no rarely-exercised branch left to be wrong.

A run that stopped part way leaves its manifest `pending`, and that manifest is the only record of
what it wrote and where its backups are. So `commit` refuses to start while the manifest is
`pending` for another run (`TRANSACTION_INTERRUPTED`): the interrupted run is reverted first. The
lock does not settle this by itself, because the process that held it is gone and its lock is
cleared as stale.

Upfly's folder hides itself from git: before an applied run's first write, `optimize` creates
`.upfly/.gitignore` holding `*` unless one is already there. Staged images and backups never show
in `git status`, `git add -A` never takes them, and the project's own `.gitignore` is never
touched.

**The manifest is self-contained**, and holds no absolute path, so it still means something
after the project is moved. For a text file it stores the *inverse* edits rather than a copy of
the file: the replaced text is a path string, so undo restores the file from bytes rather than
kilobytes. A delete is the one operation whose content nothing else can reconstruct, so its
bytes are backed up under the run directory and `prepare` refuses a delete whose backup is not
actually there. `revert` checks the same backups before its first write and refuses if one has
gone since, so an undo never stops part way through putting originals back. **The run directory
therefore survives commit**: deleting it would throw away the only copy of anything the `replace`
policy removed. A run refused before it writes, while staging or in `prepare`, is the opposite
case: nothing will ever read what it staged, so its encodes and backups are removed. And once a
run commits, every earlier run's directory is removed: `undo` restores only the run the manifest
names, and the committed manifest has just replaced the last one, so nothing can restore from an
earlier directory again. A run that stops part way removes none, its own included.

On top of all that, `upfly optimize --apply` refuses a project folder with uncommitted changes
unless forced, and `--commit` produces exactly one commit, making `git revert` the real undo
button and code review the trust mechanism. The rules are under "The CLI" below.

Windows specifics that are handled deliberately, not incidentally: every placement is a
`copyFile` rather than a rename, so a run directory on another volume cannot fail the way a
cross-volume rename would; long paths are supported; and `EBUSY` and `EPERM` are retried with
backoff, because on Windows an editor or a virus scanner holds a handle open for a few
milliseconds and failing the run for that would make the tool unusable on a first-class target.

### Images a build loads

A rewritten reference has to load in whatever resolves it. A browser resolves a path to a file the
site serves; the project's build resolves the rest, and a bundler loads only the file types its
settings give a rule. scratch-www's `webpack.config.js` gives images a loader for `png|jpg|gif`
only, so a `require('./high-contrast-thumbnail.png')` rewritten to `.webp` stops its build. Upfly
cannot read a bundler's rules without running its settings, so it converts an image the build loads
only for a build known to load the new format by itself. Every other such image keeps its format
under both policies, declined with a sentence naming the build settings Upfly found, or saying it
found none. An allow-list rather than a deny-list, so a build nobody has checked costs a saving,
never a broken build.

**Which references the build loads.** A module import always, wherever its image sits: `import`,
`import()`, `require`, `new URL(…, import.meta.url)`, and an import in Astro frontmatter or MDX.
Any other path when its image sits outside every serving root: no browser can fetch that image by
its URL, so what loads it is the build, through a stylesheet it processes or a page it renders.
Where no serving root was found, served and bundled images cannot be told apart by folder, so the
reference's kind decides: an import is the build's; a stylesheet's `url()` is when its package
names a build, since a site with no build serves its stylesheets as written; an HTML `src` never
is.

**Which build.** The package of the file holding the reference: the nearest folder at or above it
that holds a `package.json`. A build tool runs in a package's folder and reads its settings there,
so a settings file further up belongs to another package's build and cannot vouch for this one.
In that folder the build is named by its settings file, or, when there is none, by the command its
`build` script runs, as a Vite project with no `vite.config` builds with `vite build`. Another
bundler named anywhere in the package (a `webpack.config.js`, a script running `webpack` or
`react-scripts`) outweighs a known one, because which of the two loads a file cannot be told from
outside. It is the reference's package that decides, not the image's folder: a shared image
imported by a Vite app and by a webpack app converts for the Vite import, the webpack import keeps
the old name, and so the original stays.

**The known builds**, each confirmed from its own source for both formats:

| build | loads WebP and AVIF | settings it reads |
|---|---|---|
| Vite 6.4 | from an import or a stylesheet's `url()`: both are in `KNOWN_ASSET_TYPES` (`dist/node/constants.js`) | `vite.config.{js,mjs,ts,cjs,mts,cts}` |
| Next.js 15.5 | from an import: `nextImageLoaderRegex` (`dist/build/webpack-config.js`); from a stylesheet's `url()`: any file but scripts, HTML and JSON becomes an asset (`dist/build/webpack/config/blocks/css/index.js`) | `next.config.{js,mjs,ts}` |
| Astro 5.18 | through Vite's asset types, and its image pipeline's `VALID_INPUT_FORMATS` (`dist/assets/consts.js`) | `astro.config.{mjs,js,ts,mts,cjs,cts}` |

Each also declares both formats to TypeScript (`client.d.ts`, Next.js's `image-types/global.d.ts`).
Next.js's Turbopack builder is native code: its shipped binary names WebP and AVIF in its image
module, which is weaker evidence than a line of source, and the fixture build runs webpack.

**What is not read.** Other tools load the same import: a TypeScript `declare module '*.png'` with
no `*.webp`, a Jest `moduleNameMapper` listing image extensions. Neither would break a build or a
test in the measured repositories, so neither is read. A stylesheet's `url()` naming a served image
is read as the browser's, even where a bundler's stylesheet loader would resolve it.

### One writer at a time

The manifest has one fixed path, `.upfly/manifest.json`, and `undo` reverts the run it records.
That holds only while one run writes at a time. If two runs wrote at once, one would replace the
other's manifest, and the run whose record was replaced would leave its backups under
`.upfly/runs/<run-id>/` with nothing pointing at them: the originals it removed could not be put
back. The lock, `.upfly/lock`, makes one writer at a time a rule the code enforces. It protects the
record rather than the files: commit hashes each edit target again before writing it, so a file
another run changed after this run staged is refused anyway.

`commit` and `revert` each take the lock for their whole duration, so a caller that uses the
transaction directly is covered. `optimize` also takes it before the encodes and holds it until
`commit` returns, so no other run can start and finish while this run encodes, or between its
checks and its first manifest write. The holds nest: a run may take the lock again while it holds
it, and releasing a nested hold does nothing, so an inner `commit` finishing does not unlock the run
around it. Re-entry needs both the same run id and the same process. A process id alone cannot tell
apart two runs in one process, as an editor extension would have; a run id alone would let an `undo`
started from a second terminal, which reads the run id from the manifest, walk into that run while
it is still writing.

The lock file is made with an exclusive create (`O_EXCL`), never by checking for it and then writing
it, since two runs could both see no lock and both write one. That is why `FileStore` has a
`createExclusive` method rather than the lock composing `hash` and `writeText`.

A run that finds the lock held by a live process is refused with `TRANSACTION_LOCKED`, never queued.
A queued run would stall silently behind a long one, and an editor would look frozen. The refusal
names the run holding the lock, its process and when it started, so the user can tell whether
anything is still running.

A lock whose process is gone is stale and is cleared. Staleness is decided by whether the holding
process is alive, not by the lock's age: to a clock, a long run looks the same as a stuck one.

A lock file that cannot be read is refused, not cleared. The exclusive create and the write of the
holder are two steps, so an empty or half-written lock may be one another run is writing at that
moment, and clearing it would let both runs hold the lock. The cost falls on a lock cut short by a
crash, which stays until someone deletes it; the refusal names the file and says to delete it if no
run is going. The CLI makes the same check before it reads the project.
Clearing is tried once. If another run takes the lock in between, this one is refused rather than
retrying in a loop. On the way out, a run removes the lock only if it still names that run and
process, so a run whose lock was cleared as stale cannot delete its successor's.

## Moving an asset

`planRelocation` (`relocate.ts`) moves assets and repoints every reference that names them.
Renaming and moving are one operation, so a single-file move is the simple case of a folder move.
It is pure, like the planner, and its moves ride the same transaction and manifest as `optimize`:
each is committed as a copy in step 2 and a removal in step 4, and `revert` undoes it.

A repointed reference keeps the form it was written in, as seen from the file that holds it. A
root-relative URL stays root-relative, read from the deepest serving root that holds the new path,
as the planner reads a converted file's URL, and a relative path is re-derived from the referencing
file's directory. A reference the resolver linked through an alias keeps the alias, found as the
resolver found it: only an alias link counts, which the graph records as `serving-root`, so a
relative link whose text an alias also matches stays relative, and the rule is asked of the
spelling the lookup matched, so `%7E/assets/x.png` is read as `~/assets/x.png`. A bare import
the resolver linked through the nearest tsconfig's `baseUrl` (no `paths` key matched) stays a
bare module name, the new path under that folder, and a move out of the folder is refused, since
only a relative path could name it there. A leading `./`
stays when the original had one, and a percent-encoded name stays encoded. A diff in which `./`
comes and goes is one nobody can review, and a raw space written into a URL breaks it. Where the
syntax around the path cannot hold a character of the new name, the whole path is written
percent-encoded instead: a `srcset` URL ends at whitespace or a comma, and an unquoted `url()` at
whitespace, a quote, a parenthesis or a backslash. The resolver reads a path without its
surrounding syntax, so the check after the plan cannot see this, and `spell` guards it.

### What a move refuses

A move acts on what the graph knows. A reference the graph missed becomes a broken reference the
move caused, not one it found. So `relocate` refuses whatever it cannot carry out by changing path
text, and reports each refusal with its reason. A refused move contributes no rewrites, so a caller
that ignores the refusals writes less than it asked for, never something wrong.

It rewrites paths, not code, and where a file lives decides how it is referenced:

| where it lives | how code refers to it | what resolves it |
|---|---|---|
| `src/assets/hero.png` | `import hero from '~/assets/hero.png'` | the bundler, which hashes and emits it |
| `public/img/hero.png` | `<img src="/img/hero.png">` | the web server, which serves the bytes as they are |

Moving a file from one row to the other would turn an import into a URL string or the reverse, which
is a code change, so it is refused as `crosses-serving-boundary`. The same code covers a move between
two serving roots, where a URL that finds the file today would not find it afterwards, and a move out
of reach of the alias an import uses: `~/* → src/*` cannot spell a path outside `src/`. A move wholly
inside one world proceeds.

A template reference such as `` `./theme-${mode}.png` `` is one piece of text standing for every file
it matches, so moving one of them breaks it for all of them. That move is refused as
`binds-a-pattern`, naming the other files. Taking them along is not the fix: the user asked for one
file, and the pattern's text stays as written whichever files move, so moving all of them is
refused too. The refusal says what works: change the pattern by hand first. The remaining refusals guard the request itself: a source that is not an asset, a destination
outside the project or already holding an asset, a destination claimed by two moves, and a source
moved twice. Each path is read as it resolves before any of them, so `img/../../x.png` is outside
the project and `img/./a.png` and `img/x/../a.png` are one destination. Both destination checks fold case on every platform, as the planner's collision check
and `prepare` do: `src/Logo.png` is `src/logo.png` on Windows and macOS, so a move there is refused
while `src/logo.png` exists, unless that is the file being renamed.

Last, every rewritten reference is read again from the file that holds it, as a later run would
read it, among the files the moves leave, with case folded as the planner folds it. A new text can
reach another file first, in a nearer serving root or through a longer alias key, or reach none;
the move is then refused as `rewrite-would-miss`, naming the reference. Every literal reference the
moves leave as written is read again too, before and after: one that would reach a moved file's
new path where today it loads another file, or none, would change a page nobody asked to change,
so its move is refused as `redirects-a-reference`. A file moved into a nearer serving root, or to
the name a broken reference asks for, does this. Refusing a move changes the files the others
leave, so the check runs again until it refuses nothing. Given `listDirectory`, as the planner
is, both checks and the destination test also count the files the walk did not index, such as
images an ignore rule excluded, by listing the folders on the way to each path (`unindexedFiles`,
shared with the planner): a destination one of them holds is occupied, and a path that reaches
one first misses.

Some references to a moved asset cannot be repointed: a template, a reference a rewrite rule forbids
editing, or one whose new spelling cannot be worked out. They do not stop the move. Each is listed in
`declined`, because it will break.

`upfly move` is `moveProject` (`move-project.ts`) over this plan. A folder named as the source is
every image under it, each a move to the same place under the destination, which `planRelocation`
takes as a list like any other. After the plan, every other line that still names a moved image's
old path is listed with why Upfly does not follow it ("Every line that names an image" below),
from a search that reads the files the run excluded too. The moves and the edits go through
`writeRewrites`, one transaction and one manifest, which records each declined reference and each
of those lines, so `revert` puts every file back. Nothing is deleted: each image moves.

### Pointing identical copies at one file

`dedupeProject` keeps one copy of each set of byte-identical images (the audit's `duplicate`) and
points the references to the other copies at it, through `planRepoint`: the move's rewrite, with
no file moving. The copy kept is the one named, else the one most references use; on a tie, one a
folder the site is served from holds, then the shortest path, then the first in path order. A
reference follows only where the kept copy is reachable the way it loads files: a URL to a file
the same serving root holds, an import to a file no serving root holds, since bundlers such as
Vite do not import from the folder they serve as it is. Every new text is read again among the
files as they are and must reach the kept copy, or it stays as written with the reason. The edits
go through `writeRewrites`, the same transaction and manifest as `optimize`, so `undo` reverses
them. Nothing is deleted: a copy nothing names any more is listed by the audit as unused.

### What "broken before versus after" can see

The obvious check after a move counts broken references before and after it. That count comes from
the same graph that decides which references exist, so it can only show that the move broke nothing
Upfly can read. A reference to a moved asset in a file type nothing scans, such as
`deploy/netlify.yml`, breaks while the count reads 0 before and 0 after. That is the shape of the
check rather than a defect in it, so `checkMoveRegression` (`move-check.ts`) states the limit beside
the number. The count and its limit are one value, and `lines` renders both whatever the verdict: a
regression of three says nothing about a fourth break the count could not see.

The limit names each class a reader would act on differently:

- Unread file types that could hold a path, with their file counts. Binary types such as fonts are
  left out, since no path text can hide in them. An unread type wants an adapter.
- Files of a type Upfly reads that could not be parsed, each named with the parser's complaint.
  Grouped by extension they would read as a missing adapter, when the cause is usually one invalid
  construct, such as bad CSS inside an inline `<style>`, which makes a whole HTML file unreadable.
  A parse failure is the likeliest place a break hides: if that file links a moved asset, the move
  breaks the reference and the count stays level, because the failure that hid the reference also
  hid the breakage.
- Directories excluded by an ignore rule. Their files are in neither the graph nor the unread count,
  so without this line a reader would take the unread count for the whole blind spot.
- Paths a program assembles at runtime, which neither side of the count can contain.

When the two sides left a different number of files unread, the report says the comparison is not
like-for-like. A move relocates assets rather than sources, so that should not happen.

Nothing in the types stops a caller printing `brokenAfter` alone. The module makes stating the limit
the shorter path, not the only one.

### The independent check

`findSurvivingPaths` (`old-path-search.ts`) searches the text of every file for each moved asset's
old path, in any letter case since Windows and macOS find a file that way, and never reads a graph: a check built on the graph that missed a reference would miss it
again. It searches the path, not the basename, because a move keeps the file name and the basename
would match the asset at its new place. For the same reason `sweepForMentions`, which matches the
basenames of assets nothing references, is not reused.

A long needle misses the URL that markup uses, and a short one matches too much, so the old path is
searched in several spellings, and each finding gives the text that matched as the file spells it: the path as stored, with
a leading slash for a project served from its own root, as a URL under each serving root
(`/img/hero.png` for `public/img/hero.png`), as its last directory and file name (`img/hero.png`,
which catches `../../img/hero.png`), and with Windows separators. A match that lies inside a
destination path is discounted, because for an asset at a serving root the old URL (`/og.png`) is
also the end of the new one (`/moved/og.png`).

A survivor is an occurrence the move did not rewrite. It is usually a reference that could not be
repointed, but it can be prose, a changelog entry or a coincidence, and a text search cannot tell
them apart, so each is reported with its line for a person to read. Reporting a coincidence costs a
glance; missing a break costs a missing image. The limits are printed with every result: a path
assembled at runtime, a path spelled some other way (URL-encoded, behind a CDN prefix, split across a
concatenation), and a file nobody handed the search, such as one in an excluded directory.

`optimize` runs the same search before it writes, treating each original that `replace` would delete
as a move to its converted file. At that point the old path still appears in the references the plan
is about to rewrite, so a match inside a planned edit's range is discounted by its offset. An asset
whose path survives elsewhere is not converted, its decline names where the mention is, and the
report adds one caveat for the run stating the search's bound. A gap in the search is treated the
same way: when a file could not be opened, or the walk could not list a directory, a mention inside
it cannot be ruled out, so no original is deleted, and each decline names the first thing that could
not be read. The search also reads what the run's rules excluded, since an excluded page can still
show the original (see "Discovery" for what stays unread and why). When the only mention is in a
file the run excluded, the decline says so, rather than that Upfly cannot rewrite the path there.
The encodes can take minutes, and a page saved or created meanwhile can name an original the plan
deletes, so an applied run makes the search again after them, under the lock, over the project
walked again. An original a mention then names is kept, with the reason, and the run goes on: its
converted file is written and the references the plan read still move to it, as under
`keep-original`. What that leaves uncovered is under "The transaction".

### Every line that names an image

`refs` answers for one image with its references, the ones the graph follows, and then with
every other line a search for the image's path finds, each with why Upfly does not follow it
(`findUnfollowedLines`, `unfollowed.ts`). The search is the one above, `findPathOccurrences`
reporting every match rather than one per line, over every file the walk found and every
file the run's ignore rules excluded: a scope limits what a run changes, never what it reads.
Together the two lists hold every line the search finds, once, except a line that names
another file of the same name, which is in neither. That exception is the hard part: four
images called `logo.png` must not each claim the lines that name the other three.

Each place the search finds is read against the graph first. Inside a reference that leads
to this image, the line is one of its references; inside one that leads to another image, or
into a folder the walk does not index, it names that file. A broken reference names no file,
and is listed only when it names this image in another letter case, or when it is written
from the site's root in a run that could not tell where the site is served from. A `dynamic`
one is a path built at runtime, a `discarded` one a value in data or props, an
`unresolved-alias` one a path through an alias nothing declares.

Outside every reference the place is read as text. A file name that goes on past the match
(`logo.png.webp`), or a folder name the match starts inside (`old-img/logo.png`), is another
file's. A full address names the image when its path ends with the image's URL under a
serving root or with its path in the repository, which a link to a code host ends with; when
two images' addresses fit, the longest decides. Upfly cannot tell which host serves the site
itself, so it never rewrites a full address, and each one listed carries its host for the
reader. A setting naming the site's own addresses would make those references; it would
apply in the full-address branch of `placeOf`, and is not built. A template hole before the
path (`${base}`, `{{ site.url }}`, an ERB tag) makes it a path built at runtime. Any other
path is resolved from the file that holds it, as an unasserted reference would be: beside the
file, then from the project root, from a serving root or through an alias, with letter case
folded. One that leads to another image, or into an excluded folder, names that file. What is
left is listed with where it sits: a file the run excluded, a type no adapter reads, a file
that did not parse, a comment, Markdown code or frontmatter, or plain text. Comments are found
by the parser of the adapter that reads the file, Babel, parse5 or PostCSS, and Markdown's own
masks, never by a pattern over code.

A place Upfly cannot pin on another file is listed rather than dropped, as the independent
check reports a coincidence: a glance costs less than a missed line, which after a move is a
broken image. The work this adds is one more read of every text file, a parse for comments
only of a file holding a place outside every reference, and one call to the resolver for the
whole search.

## Performance budget

Building the graph on a 10k-file / 2k-image repository must stay **under 3 seconds** cold.

**That budget is missed, and the reason is measured.** CI's `bench (gate)` cell reads about 4.4 s on
Linux and 5.2 s on Windows, inside the regression ceilings and above the target, which was
deliberately not moved. Parsing is about 70% of `scan`, and the main thread is the bottleneck;
reading files never was.

**A pool of parse workers does not help.** Each worker pays V8's warm-up again, so the work grows as
it is spread: 8,763 ms of CPU at one worker became 27,074 ms at eight, for identical input. And its
two knobs oppose each other, because the setting that keeps the workers busy is the one that
inflates the work. The pool was removed before the public API was published; its last version is in
commit `c84a2f3`, for the day a long-lived process such as the editor extension, which would pay the
warm-up once, measures a win.

What does ship is narrower: a file whose text holds none of the tokens a reference needs is not
parsed at all, which is exact rather than fast and carries no performance claim. What remains
untried is a parse cache, a faster parser, and that long-lived process. **The budget number does not
move until a fix is measured.**

That budget covers **discovery, parsing, resolution and graph building only**. Probing and
encoding are explicitly excluded and reported as a separate number: both are dominated by
libvips, and optimising against a target that included them would mean tuning our code against
somebody else's decode time. **They are bounded separately, because their profiles are opposite:**
reads are IO-bound and default to **16 at a time** (`scan.ts`), encodes are CPU-bound and default
to **4** (`probe.ts`), a measured default: `os.cpus() - 1` was about 21% worse. One encode keeps
about one core busy whatever libvips is allowed, so the parallelism is across images, and sharp's
work runs on Node's thread pool, four threads unless `UV_THREADPOOL_SIZE` is set before Node starts
(setting it from inside the program has no effect on Windows). Both bounds are kept full: the next
file or image starts the moment any finishes (`mapInOrder`, used by the walk, the sizing, the scan
and the probe), since a group that waits for its slowest member leaves most of its slots idle while
one large image encodes.

`bench/` is checked in and runs in CI against a fixed fixture, so a regression shows up as a
number rather than a feeling. **Any performance claim in the README must come from a number `bench/`
produced in CI**: the previous generation of this project shipped unmeasured claims, and this one
does not.

How CI's gate is set, and the tree the budget is measured on: `bench/README.md`.

## The report

The JSON is public API and carries `version`. It is snapshot-tested over every fixture tree, so a
schema change shows up as a diff somebody has to approve rather than as tests that still pass.

**No absolute path reaches it.** Half the data upstream carries an absolute `path` beside a POSIX
`relative` (`SkippedEntry`, `ExcludedRoot`, `UnscannedFile`, `Reference.file`), and the validation
protocol runs the same repository from two working directories and requires byte-identical output.
Projecting to the relative form is the report's job, and the guard is a test that serialises the
report and greps it for the root. It is one forgotten projection away from being false.

Everything declined, from every stage, lands in **one flat `skipped` list** rather than five
per-stage ones. Keeping every skip reported is easier when there is a single place to append to.

Two calls about references are worth knowing:

- The unsafe bucket (`dynamic`, `unresolved-alias`, `out-of-scope`) is **listed in full**. It is
  the "N references I couldn't safely rewrite" number, and it is the honesty that earns trust for
  everything else on the page. An `out-of-scope` reference into what the project's own ignore
  rules left out is listed apart, in `references.leftOut`, with a sentence of its own: the run was
  told to leave that file alone, and among the unanswered references it reads as a problem.
- `discarded` is **counted, not listed**. A real repository produces thousands of them from lockfiles
  and i18n bundles, and listing them buries everything else. The count is still there, because it is
  what tells a user the JSON adapter has started eating something real.
- A value an adapter declined is **counted by reason, apart from the references**
  (`references.declinedValues`). It is not a reference, so `summary.references`, `byResolution` and
  the accuracy classes leave it out, though the graph carries it as `discarded` so the sweep can
  read what it names. One reason per construct and name, such as one per JSX attribute, keeps the
  lines few: 120 values on scratch-www come to 13 lines. `--include-discarded` lists each value
  under its reason.

### `findings` holds what there is something to do about

It is not every finding the audit produced. An unreferenced **vector** is moved to `unusedVectors`,
a count and a total size, because Upfly neither converts nor deletes a vector, so itemising one
proposes the only two things it will not do. `--include-unused-svg` lists them;
`summary.findings` counts the itemised array, so the two can never disagree. On `astro-docs` this is
what takes the unreferenced-asset findings from 150 to 24, and the hedges from 140 to 18.

The argument is **"we offer no action", not "vectors are small"**. The second is false, and measured:
SVG is 96% of `shadcn-ui`'s hedged bytes and `eleventy-docs`' nine vectors are 210 KB. That is why the
counted line carries the size: Upfly never deletes an unused asset, so the decision stays with the
reader, and a total is what turns a count into one. SVGs stay in reference tracking throughout: a
broken `<img src="/logo.svg">` is a broken image like any other.

The set of vector extensions lives in `paths.ts`, not in the probe, because **two decisions depend on
it being the same set**: what the probe declines to encode, and what the report declines to itemise.

One exception keeps a vector itemised: if a broken reference asks for its raster twin (`hero.svg`
unreferenced beside a broken `hero.png`), the pair lands in `staleConversions` and the vector stays in
`findings`. There *is* an action, which is to fix the reference. It is phrased as two facts and an
inference the reader judges, never as a conclusion.

**An original kept beside its converted file leaves `findings` too.** After an `optimize` that keeps
originals, the references point at `logo.webp` and nothing links to `logo.png`, so the audit calls it
`dead`. That is true, and it is the user's own choice, not an unused image to clean up. So a `dead`
raster whose converted twin (the same path with `.webp` or `.avif`) exists and is linked moves to
`keptOriginals`: listed in full in the JSON, and counted with its size in the human headline. A twin
that nothing links to either proves nothing, and both stay findings.

### The human renderer prints the skipped list before the findings

That ordering is deliberate and slightly uncomfortable: it puts what the tool could *not* do above
what it found. A limitation printed after eighty findings is a limitation nobody reads, and the
previous generation of this project lost trust by failing quietly.

Nothing in it uses `toLocaleString` or `Intl`. Locale-dependent formatting would render `1,5 MB` on
some machines, which breaks the byte-identical rule exactly the way `localeCompare` would, so bytes
are formatted by hand. Colour is the CLI's business, since that is the layer that knows about TTYs
and `NO_COLOR`.

Caveats carry their own count and a `detail` list. "No adapter reads these file types" is a shrug;
`.njk — 2 files` is how someone finds out which adapter they want.

### Scoring references for accuracy

Every reference in the report carries a `classification`, which answers two questions: did the
reference have an answer (a file it really names), and did the engine give one?

| | the engine answered | the engine refused |
|---|---|---|
| there is an answer | `resolved-with-an-answer`: success | `missed-with-an-answer`: the ordinary failure |
| there is no answer | a wrong answer: the dangerous failure | `correctly-refused`: success |

A `broken` reference counts as answered. The engine worked out where it points and reported the
truth, that the file is not there, and the defect is the project's.

The fourth box is the one the engine cannot fill. A wrong answer, whether a false link, a false
`broken` or a false `dead`, is one the engine believes, so a count it reported itself would always
be zero. Refusal accuracy, correct refusals over correct refusals plus wrong answers, would then come
out at 100% for any engine. So the report carries no such count, and
`refusalAccuracyIsNotSelfAssessable: true` marks the absence as a decision. Wrong answers can only be
counted by a check that does not share the engine's assumptions, such as the verification in
`bench/src/verify.ts`; a check built on the same assumptions agrees with the same mistakes.
Resolution accuracy, answered over answered plus missed, can be computed from
`references.byClassification`.

The default is the unflattering one. Whether an answer exists is the engine's own judgement, so a
reference counts as `correctly-refused` only when a property from the closed list `REFUSAL_REASONS`
holds for it: a path assembled at render time, a target outside what Upfly acts on, or a style
attribute the adapter could not read that holds no url-taking function once parse5 has decoded it
(`url&#40;` is one). Each is a fact about the reference, never "the engine cannot handle it".
Everything else is `missed-with-an-answer`, including an alias that no config the engine can read
declares, since a bundler config it did not read may well resolve it. Adding a reason moves
references from missed to correctly refused and raises the accuracy figure, which is why it has to
be a visible edit to one list rather than a condition somewhere else.

Refusals are listed, not only counted. Each entry in `references.unsafe` carries its
`refusalReason`, so a reader can dispute a single refusal. A reason known to over-claim carries a
measured bound and a note of what it was measured against. For every such reason a run uses,
`references.classificationBounds` puts both beside the counts, and the human report prints them, so
an accuracy figure never travels without its known error, and a reader can tell when the measurement
has gone stale.

Path-shaped strings nobody asserted (the `discarded` references) are `not-a-claim` and stay out of
both figures: scoring the engine on them would measure it against work that was never its job. A
value an adapter declined is no reference at all, and the report puts it in no class.

The engine decides the class once, as a field. If the CLI, an editor or `bench/` derived it, each
would hold its own copy of the rule, and the copies would drift.

`coverage.notExercised` guards the same figures from another side. A check run under a configuration
that skips a mechanism passes without testing it: with serving roots declared, detection never runs,
so a known detection defect can look fixed. The report names each mechanism a run did not use, as a
fact about the run's input rather than a judgement about the engine.

How `bench/src/verify.ts` checks findings from outside the engine: `bench/README.md`.

## The CLI

`upfly` is a thin layer over the engine: it reads the command line and the configuration, runs
`runPipeline` (`audit` and `check`), `optimizeProject` (`optimize`) or the transaction's `revert`
(`undo`), and prints. It decides serving roots with the engine's own `servingRootsFor`, so a
command cannot decide them differently from the measurements behind it.

**`check` is the gate for continuous integration.** It fails (exit 1) on a `broken` finding, and
on an image some reference uses whose file is larger than `check.maxImageBytes`; it reads no
pixels. An unused image never fails it: most projects hold some, and a gate that fails on its
first run is switched off. When the serving root cannot be found it refuses (exit 3), as
`optimize` does, because the root-relative references cannot be judged. `--changed <ref>` keeps
what a change could have caused: findings in the files changed since the commit `ref` and `HEAD`
last shared (`git merge-base`), working tree and untracked files included, or since the last
commit without a ref. A change breaks a page it never touched by deleting the image the page
names, so a broken reference whose file name matches a deleted file is kept wherever it sits.
Everything the verdict leaves out is counted in a sentence: findings outside the change, unused
images over the limit, files that could not be read, and references whose file cannot be known.

**`optimize --only` limits what converts, never what is read.** A scope that limits reading is
how an excluded page ends up naming a deleted original, so `optimizeProject`'s `only` (exact
paths, or patterns in `.gitignore` syntax) reaches the pipeline as `measureOnly`: every file is
walked, read and resolved, and only the named images are measured. An image that is not measured
never converts, and every other rule holds unchanged, so under `--replace` an original still goes
only when every reference to it moved. The result names the images matched and each path or
pattern that matched none, and the CLI says both.

**`refs <image>` asks the planner about one image.** It runs `optimizeProject` as a dry run with
`only: { paths: [image] }`, so the whole project is read and only that image measured, and
answers from what the run produced: each linked reference, cited, with `whyReferenceStays`, the
planner's own rule (`obstacleTo`) turned into a sentence, and a verdict taken from the plan (the
conversion, or its decline) or, for an image nothing links, from the audit (`dead` is unused,
`possibly-dead` names where its file name appears). No second rule is written for the CLI, so
the answer cannot drift from what `optimize` does. The `--json` answer is kept small: the
image, its size, the references, the verdict.

**`dedupe` writes as `optimize` writes.** It refuses `--apply` over uncommitted changes or where
git cannot help, and a run in progress, with `optimize`'s own checks; `--commit` makes one commit of
exactly the files written, ending `Upfly-Run: <id>`, so `upfly undo` and `git revert` both reverse
it. A `--keep` that names no copy, or two copies of one image, stops the run before it writes
(exit 2). The plan prints in `optimize`'s shape: each set with the copy kept and why, each other
copy with how many of its references move, each staying reference with its reason, the files
that change, and the copies no reference names afterwards, which stay on disk.

**`init` writes down the decision a run would make.** It calls `decideServingRoots` inside the
pipeline, as every run without declared folders does, and writes `upfly.config.json` with the
schema, the folders and the format, giving each folder's reason: the project file a detected
folder sits beside, or the count of root-relative paths that chose an inferred one. With no folder
found it leaves `publicDirs` out rather than declare the project root. It refuses (exit 3) when
any configuration file exists, the v2 extension's included, and writes with `wx`, so a file that
appears while the project is read is never overwritten.

**The configuration file is `upfly.config.ts` (or `.js` and their module forms), or
`upfly.config.json`, in the directory the command runs on.** The code forms load through c12 with
everything a user did not ask for turned off: `extends` layers, which c12 would download from a
`github:` or `https:` source, rc files, `.env`, a `package.json` key and `NODE_ENV` sections. Upfly
makes no network calls, which is why the first is off, and the rest would each change a run without
the config file saying so. The JSON form is read as JSONC with syntax errors collected, so a
truncated file is an error rather than a partial config.

**The v2 VS Code extension reads a file with the same name,** holding `enabled`, `watchTargets` and
similar settings. A JSON config with any of those and nothing that only this CLI uses (`publicDirs`,
`publicPolicy`, `exclude`, or its `$schema`) is the extension's, and every command refuses it with
exit 3 and leaves it untouched. `format` is not evidence either way, because both products use the
name. A code config beside the extension's file is read and the file is left alone.

**Output.** With `--json`, stdout carries only JSON lines: progress events as each stage finishes,
the libraries' own messages as `diagnostic` lines, and one final `result` or `error` object. That
is why the libraries' wording can appear there and never in the report. Without it, errors and
progress go to stderr, progress only on a terminal, and every command's text starts with the same
headline, `Upfly <command>`, with a blank line before it and after the text's last line.

**`audit`, `optimize` and `dedupe` print a short summary**: what will happen or happened, the
totals, every image left alone counted by reason, and the next command to run, in labelled rows no
wider than 80 columns, a long path shortened in the middle. One path is never shortened: when the
project is a folder of a larger git repository, a Repository row names that repository's top whole,
however wide, since `--commit` commits there. Each summary ends in a plain sentence of what the run
would do or did, with its figure.

**Each of them writes a report file named after it**, `.upfly/audit.txt`, `.upfly/optimize.txt` or
`.upfly/dedupe.txt`, replaced on each run of that command; an applied run also keeps a copy in its
run folder. The file is the summary expanded: its first lines name the command, the time, the folder
and the options, then come the summary's rows in the same order, each followed by its complete list,
and the engine's caveats last. A row carries its list (`Row.list` in `layout.ts`), so the summary,
the file and `--show <row>`, which prints one row with its list, are one text and cannot disagree.
The folder's `.gitignore` is written before the file, so a report never shows as a change and never
makes `--apply` refuse. Under `--json` no file is written: the JSON holds everything, and a file its
output never names would be a side effect no script asked for. The planner gives its reasons as
sentences, so the summary groups them by the phrases each kind of sentence always holds
(`reasons.ts`); a sentence that holds none is still counted, as another reason, and a probe's skips
are grouped by their code.

**What happens to an original** is a flag's (`--keep-originals`, or `--replace`, which names the
default), else the config file's `publicPolicy`, else `replace`: an `optimize` that left two copies of
every image is not what a user asking to optimize expects, and under it a later run could not remove
originals an earlier one kept, since nothing used them. The library's `optimizeProject` takes the
policy as a required input, so a program states it.

**Colour** appears only on a terminal, and never under `--no-color`, a non-empty `NO_COLOR` or
`TERM=dumb`. Colour is the default, so the help does not offer `--no-color`; it works for whoever
knows it. There is one accent, the brand's coral `#E8365F` in bold, for structure only: the
headline's name and the labels. It is the one bold thing on a line, so values stay at the
terminal's own weight, apart from the command to run next, bold so it can be found and copied; a
second bold column made the summary heavy, and coral at normal weight read as an error. Secondary lines are dim, and red marks a failure and nothing else; no meaning
rests on colour alone. How many colours the terminal shows is Node's answer for the stream
(`getColorDepth`), which reads `COLORTERM` and `TERM` and knows that Windows 10 and later show
24-bit colour though their consoles set neither. The coral is exact at 24 bits and the nearest of
256 where the terminal shows those. Among 16 colours only a red comes near it, so there the
accent is bold without a colour, and red still means a failure.

**Exit codes** are a contract: 0 the command ran, 1 `check` found findings over its thresholds, 2 the
command line or configuration was wrong, 3 Upfly refused to act for safety, 4 something it did not
anticipate went wrong. A crash is its own code, because it is neither a finding nor a refusal. A
refusal's `error` line under `--json` also carries a `reason`, a stable name such as
`UNCOMMITTED_CHANGES` or the engine's `TRANSACTION_LOCKED`, so a script can tell refusals apart
without reading the sentence.

### `optimize` and git

The promise is that the run's changes are the only ones a reviewer has to look at, and that one
`git revert` takes them all back. Everything below follows from that.

- **Only the project folder is looked at.** A project can sit inside a larger repository, on
  purpose (a package in a monorepo) or by accident (a home folder that is itself a repository).
  `git status -- .` and `git ls-files -- .` run in the project folder, and git reports those paths
  relative to the repository's top, so they are cut back to the project. When the top is above the
  project, the dry run and the commit's output name the repository.
- **`--apply` refuses uncommitted changes in the project folder, untracked files included** (exit
  3). An untracked original that `--replace` removed could not be restored by git at all.
  `.upfly/` never counts. `--allow-dirty` writes anyway; `upfly undo` still puts the files back.
- **Where git cannot help, `--apply` refuses the same way**: no git, no repository, or a repository
  that tracks no file in the folder (an ignored folder looks clean to `git status`). `--allow-dirty`
  is the way through.
- **`--commit` needs a clean folder and cannot be combined with `--allow-dirty`**: a file holding
  both the user's edit and the run's would put the user's edit in Upfly's commit, and `git revert`
  would take it out again. It also needs a git identity, checked before anything is written.
- **The commit holds exactly the files the run wrote**, from the manifest. It is made from an index
  of its own (`GIT_INDEX_FILE`): HEAD's tree, then `git add` of those paths, read literally
  (`GIT_LITERAL_PATHSPECS`), so a name holding `[` never matches a second file and work the user
  staged elsewhere stays staged and out of the commit. The project's own index is then brought to
  what was committed. Paths travel on stdin, never through a shell.
- **The commit reads only the files the run wrote.** `git commit` refreshes its index first, and
  for an entry with no size recorded git reads the file to learn whether it changed, so an index
  straight from `git read-tree HEAD` costs a read of every tracked file: about 8 seconds a commit
  on a repository of 2,800 files and 515 MB. The index of its own therefore starts as a copy of
  the project's, which carries each entry's size and time, and `git read-tree -m HEAD` keeps them
  for every entry whose content already matches HEAD. What is left to read is each file the user
  had staged differently, whose recorded size belongs to the staged content. A split index, a
  sparse index, a linked worktree and a `GIT_INDEX_FILE` the user set all hold, since git resolves
  the index's own location and any shared index from the repository. An index holding an unresolved
  merge, which a conflicted `git stash pop` leaves, refuses `-m`; then HEAD is read afresh and the
  commit is the slow one. A branch with no commit starts from an empty index.
- **A run never ends a merge, a rebase, a cherry-pick or a revert the user started.** A plain
  `git commit` made in any of those states finishes it: a merge would gain the other branch as a
  second parent and carry the user's half-finished resolution. Git decides the same question from
  the same files (`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge`, `rebase-apply`)
  and refused a commit of named paths in every one of them, so the commit refuses too: the files
  stay written, and the message says to commit them by hand or to undo the run.
- **A moved file keeps its executable mark in the commit.** `git commit --only` would build the
  same commit, but it gives a path new to HEAD the mode on disk, and Windows (`core.filemode`
  false) keeps no executable bit there, so `move --commit` dropped it. The moved path now takes the
  mode its old path has in the index. A commit the user makes of an `undo` meets the same limit on
  Windows, for the same reason; `git revert` of the run's commit keeps the mode.
- **A commit that could not hold the whole run stops the run before it writes.** Once the plan is
  final, `optimize` hands it to a `beforeWrite` check, and the CLI asks `git check-ignore` about
  every path the plan would write; if git would refuse any of them, nothing is written.
- **The commit message ends with `Upfly-Run: <run id>`**, the id the manifest records, which is how
  `upfly undo` finds the commit to say that it is still in the history. Undo follows the manifest
  alone and reads no configuration file.

## Package layout

| Package | Published as | Contains |
|---|---|---|
| `packages/core` | `upfly-core` | graph, adapters, planner, transaction, report. No CLI or editor concerns, no network. |
| `packages/cli` | `upfly` | argument parsing, human/JSON output, exit codes, git safety. |
| `packages/vscode` | `upfly-vscode` | the editor surface (not yet written). |

`packages/core/src` is grouped by pipeline stage. At the top, `index.ts` is the public entry,
`internal.ts` the entry `upfly-core/internal`, `pipeline.ts` (`runPipeline`) and
`optimize-project.ts` (`optimizeProject`) wire the stages, and
`types.ts`, `errors.ts`, `paths.ts` and `format.ts` are shared by all of them. A test sits beside
the code it tests; the tests that run the whole engine sit at the top.

The public entry holds only what a library user needs for a documented task: running the audit
and reading its report, `optimizeProject`, `dedupeProject`, undoing a run, and writing an adapter.
Every name there is documented and covered by semver, and `package-entry.test.ts` lists its values
and fails on an undocumented name. What the CLI, `bench/` and the accuracy suite need beyond that
comes from `upfly-core/internal`, which promises nothing. A name moves into the public entry when a
documented task needs it; moving one out is a breaking change.

| Folder | Holds |
|---|---|
| `adapters/` | one reader per file type, their shared rewrite, and `shapes.ts`, the reference shapes |
| `discover/` | the walk |
| `scan/` | each file read by its adapter, the check that skips a parse, line citations, the text hash |
| `resolve/` | the resolver, `isLinked`, aliases, serving roots |
| `graph/` | the graph, and what went unread |
| `probe/` | image measurement, and the sharp implementation of it |
| `audit/` | the findings, the mention sweep, duplicates, framework conventions, resolution health |
| `plan/` | the conversion and move planners, and the two checks a move runs |
| `write/` | `optimize`, the transaction, the manifest, the lock, the file store, `applyEdits` |
| `report/` | the JSON report and its human renderer |

`fixtures/` holds small but real projects per framework, each with a `build` script. `bench`'s
`fixture-build` runs `optimize --apply` against copies of them and then builds them and checks
every link: if a build breaks, the reference detection was wrong. With `--cli` it does the same
through the built `upfly` binary, with git. **That test is the product's central promise.** It
runs locally: CI builds the packages but does not yet build the fixtures.

How the fixture build works, and why its instruments are first shown to fail: `bench/README.md`.
