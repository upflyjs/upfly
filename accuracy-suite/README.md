# The accuracy suite

A small repository whose answers are known in advance: every image in it, every reference to
each image, and the outcome the engine should produce for each reference. Each expected answer
was written down before the engine ran. The positions (byte offset, line, column) are stamped by
a tool; the answers are not.

```
pnpm accuracy:measure    # build, run the engine over tree/ twice, print the matrix
pnpm accuracy:check      # does the key still describe the tree, with no open questions?
pnpm accuracy:prove      # can the check and the measurement fail? each damage must turn one red
node accuracy-suite/tools/scan-occurrences.mjs   # authoring aid: every asset-shaped token
node accuracy-suite/tools/stamp-positions.mjs    # refill derived positions; read its diff
```

## Its output is a matrix, never a score

One row per reference shape, never per repository and never in total. From a run of
`pnpm accuracy:measure` (the direction column cut where marked):

```
shape                          met/ exp  miss threw  gap stale  n/x  direction
css.url.double                   7/   7     0    0    0    0    0
html.img.srcset.w                8/   8     0    0    0    0    0
unread.vue                       0/  10     0    0   10    0    0  gap [...]
```

There is no total, no percentage and no overall row, and it must stay impossible to build one:
that is what stops a figure from this suite escaping into a claim about real projects. A row says
where to add a reader next, and catches a regression that drops `srcset` from 8 to 5; a single
number does neither.

The rows fall into four populations, read separately and never added together: `claimed` (453
entries in 74 rows, found against expected: the only population where a miss is a bug),
`declined` (93 in 19: text that is not a live path, so claiming nothing is right), `unclaimed`
(15 in 4: real files Upfly chooses not to index) and `gap` (51 in 8: constructs nothing reads
yet, each with its reason in `knownGap`). The engine runs twice, once with the suite's stated
configuration and once with none, and each run reports "claimed N of N" over every claimed entry.

## It does not replace real repositories

| instrument | the question it answers |
|---|---|
| this suite | how well does the engine handle the shapes we know about? Exactly. |
| real repositories | what shapes exist that nobody imagined? The only source of new ones. |

The serious defects in this project came from the second: filenames with spaces, a project with
twelve public directories, a reference in a file type nothing read. A suite built by hand can
only contain what somebody thought of; every shape in it can be traced to something that already
went wrong.

## Layout

```
accuracy-suite/
  key/answer-key.json         the answer key: 108 shapes, 81 assets, 612 references in 153 files
  tools/check-key.mjs         the self-check: plain text and path arithmetic, no engine
  tools/prove-can-fail.mjs    deliberate damages, each asserted to turn a check red
  tools/measure.mjs           the engine over tree/, run twice, rendered as the matrix
  tools/matrix.mjs, .d.mts    the matrix, and its types
  tools/stamp-positions.mjs   fills derived positions; never touches an `expect`
  tools/scan-occurrences.mjs  authoring aid
  tree/                       the repository under test; only this is ever scanned
```

The key and the tools live outside `tree/` on purpose: the key holds every path string in the
tree, so inside it the engine would scan the key and the answers would become part of the
question.

### Inside `tree/`

```
apps/web/              serving root apps/web/public
apps/docs/             serving root apps/docs/public
sites/root-served/     serving root: the site's own directory
legacy/                serving root legacy/public, its sources in file types nothing reads
sites/vitepress-docs/  serving root sites/vitepress-docs/docs/public
docs-examples/         a public/ that is not a serving root
shared/                the alias target for ~/* and @img/*
sites/kit-app/, sites/nuxt-app/, sites/vue-app/   aliases through generated and real configs
```

522 files: 443 text and 79 binary. 303 of the text files are ordinary and hold no asset-shaped
token, so referenced files are a minority, as they are in real code. The filler averages about
1.8 KB a file rather than being stubs, because what distorts a measurement is bytes, not file
count: a generated tree with real code's file count and a thirtieth of its bytes once inverted
two measured conclusions.

## `expect` is the ideal outcome, not today's behaviour

The outcomes are the engine's own. `expect` records what a correct engine should produce,
independently of what this one does, so a `.vue` reference expects to be found, which is the only
way the matrix can say "0 of 8, no reader" out loud instead of reporting nothing. Where today's
engine is known to differ, `knownGap` says why (51 entries carry one).

`discarded` means "must not be treated as a live reference". A `url()` inside a comment is
probably never collected at all rather than collected and marked `discarded`, and the harness
accepts either; it must not accept resolved, broken or rewritten. The key's `expectSemantics`
writes this down.

`UNDECIDED` is a value the key allows, and none is used today. The next shape added from a real
repository may need it: a wrong `expect` is worse than a missing one, since it makes a correct
engine look broken or a broken one look correct. `--strict` fails on any that appear.

## The tree is read-only ground truth

Any test that writes works on a copy. An `optimize --apply` run against the tree would change the
files and silently invalidate the key. `prove-can-fail.mjs` applies every damage to a copy in the
system's temporary directory; the real tree is never written to.

`.gitattributes` sets `* -text` for this whole directory. The key records byte offsets, and a
line-ending conversion on checkout would shift every one of them; the self-check would then blame
the tree for something git did.

A formatter is the same hazard: never run `biome check --write`, or any formatter, over `tree/`
or `key/`. It would normalise quoting, re-indent markup and tidy the deliberately malformed
references, which are the fixture's whole value: `url(/img/texture.png)` unquoted and
`url('/img/photo.jpg')` quoted are two shapes on purpose. `biome.json` therefore ignores `tree/`
and `key/`, as it does `fixtures/`; `tools/` stays linted, because it is code this project runs.

## The weakest seam: the stamper

`stamp-positions.mjs` can turn a red check green without anybody re-reading what changed. Someone
edits the tree, the self-check goes red, they re-run the stamper, and it goes green, and the key
now describes a tree nobody re-examined.

Three things hold against it, and none is a guarantee:

1. The stamper prints every change it makes. Read the diff.
2. It only ever moves positions. It cannot invent a reference, change an `expect` or add a shape.
3. A new or deleted reference does not stamp away: it fails as an unaccounted occurrence or a
   missing `raw`, and the stamper refuses to write.

What survives all three: an existing reference whose `raw` was edited into a different string
that is still present. The stamper re-points it. If a `raw` moved by more than whitespace, the
key needs a person.

## How the key is maintained

The JSON is the artifact, written directly and never generated: a second source of truth beside
it would be a second thing to drift. An entry sits under its file's group with `raw`,
`occurrence`, `shape`, `expect`, `target` where it has one, and `why`. Adding one: write the
entry, run `stamp-positions.mjs`, then `pnpm accuracy:check`.

`occurrence` is the nth literal occurrence of that exact `raw` string in that file, and it need
not start at 1. When a `raw` is a substring of a longer path earlier in the file
(`/img/avatar.png` inside `../../public/img/avatar.png`, `logo.png` inside four longer paths),
the first standalone occurrence is legitimately number 3 or 5. Getting it too low stamps a
reference inside another one, where every other check still passes; the overlap rule exists for
exactly that.

## What the self-check does not check

Stated plainly, because a check whose limits are unstated is read as a guarantee:

- Only asset extensions are scanned. A reference to a `.css` or `.ts` file added without a key
  entry would not be caught. 46 entries hold no asset-shaped token; the checker accepts them
  because it verifies any listed `raw` at its offset whether or not the scan can see it.
- A token whose path is split by syntax is found short. `/gallery/hero image.png` matches as
  `image.png`, and `` `/theme-${mode}.png` `` as `.png`. Both are accounted for by containment
  within the listed reference's span, which is correct but weaker than an exact match.
- A path with no asset extension is invisible to it: a directory reference, or an extensionless
  URL.
- It says nothing about whether an `expect` is right. It proves the key describes the tree;
  whether the tree's answers are the correct ones is a person's judgement.

## Measuring the engine against the tree

`accuracy-suite/tools/measure.mjs` scans the tree once and resolves the scan twice. The first run
uses the serving roots the answer key declares. The second declares nothing and uses the roots
`decideServingRoots` works out, which is what `servingRootsFor` gives any run on a project that
declares none. Each run reports its own figure for the claimed population, and the two are never
added together: a figure that blends two configurations describes neither. Nothing is measured
until `check-key.mjs --strict` passes, since a key that disagrees with the tree would measure the
disagreement rather than the engine. The command fails on any defect in either run: a miss that
is not a keyed gap for that run, a stale gap, or an unkeyed emission. The second run's figure is
published too, and a published figure nothing holds can drop unseen.

The judging is in `matrix.mjs`, which imports nothing, not the engine and not `node:fs`. The key
and the engine's observations are both arguments, so `accuracy-matrix.test.ts` can feed it damaged
inputs and check that each one moves a row the wrong way. It joins the key to the engine's
references by position and puts every key entry in exactly one bucket:

| bucket | meaning |
|---|---|
| `met` | the engine's outcome is one the entry's `expect` accepts |
| `missed` | the outcome is not, or the file was never observed |
| `threw` | the file could not be scanned, and the reference is absent |
| `knownGap` | the entry records why today's engine differs, and it still does |
| `staleGap` | the entry records a gap, but the engine now agrees, so the record is out of date |
| `notExercised` | the gap is about a mechanism this run did not use |

A throw is its own outcome because a crashed adapter is as silent as a correct refusal, and the
two mean opposite things. Where an entry's `expect` accepts silence, its throw is still named, but
not counted as a defect. The join also runs the other way: a reference the engine resolved where
the key lists nothing is reported, and that is the more dangerous direction, since a miss is a gap
in coverage while an unlisted link is a claim a rewrite would act on. `BUCKETS` is the one list of
buckets; the arithmetic check and the table's columns both come from it, so no bucket can hold
entries the page does not print.

Some gaps are about a mechanism rather than a missing reader. An entry whose gap says detection
picks the wrong directory cannot be settled by a run that declares its serving roots: detection
never runs there, and the entry can agree with its `expect` for reasons unrelated to the gap.
Reading that agreement as the gap closing would delete the record of a live defect. So such an
entry names its mechanism in `gapMechanism`, from the closed list `GAP_MECHANISMS`, rather than
leaving the harness to read it from the gap's prose, and each run states how it relates to each
mechanism:

- Outside its configuration (`outOfConfiguration`): the entry is judged on its outcome, met or
  missed, and the gap is neither confirmed nor retired. The first run treats detection this way.
- Exercised (`exercises`): the entry is judged on a run that used the mechanism, the run itself or
  one supplied in `observedUnder`, and the gap is confirmed or found stale. The second run
  exercises detection.
- Neither: the entry is `notExercised`, printed with the reason and never read as closed.

A run exercises nothing unless it says so, so a gap stays open until a run that used its mechanism
judges it. An unknown mechanism name throws: a misspelling would otherwise leave a gap unjudgeable
forever or make a run claim less than it did, and neither would show as a red row.

The matrix cannot see a mistake the key shares. Where the key and the engine agree and are both
wrong, the join finds nothing; a construct the tree does not contain appears nowhere; and nothing
proves that each `expect` is right. `blindSpots()` returns these limits as text, and
`renderMatrix` prints them at the end of every matrix.


## What the tree says about real repositories

The accuracy suite measures the engine on the shapes someone thought to build. It cannot say how
much of a real repository falls outside them, because a shape nobody imagined does not show up as
a failure. It shows up as nothing.

Counting a real repository's references by shape does not close that gap. A reference can only
carry a shape an adapter emits, and `shapes.reconcile.test.ts` holds the engine's vocabulary equal
to the tree's, so a reference outside the tree's shapes can only carry one already known to have
no instance, such as those on `UNTESTED_SHAPE_IDS`. Both sides of a "share of references in tested
shapes" come from the same list, so the share comes out high whatever the repository holds, and it
would not be accuracy even if it could come out low. `bench/src/transferability.ts` therefore
prints no share and no average. Per repository, it counts the references in shapes the tree tests
and names the rest, which gives the tree a growth list taken from real code.

A shape nobody imagined can only be seen by a check that never asks the engine what shape anything
is. The false-negative sweep in `bench/src/validate.ts` searches each validation repository for
every asset's filename and accounts for each mention the graph did not link: either an adapter
missed a reference, or the mention is correctly out of scope, and a person adjudicates what the
sweep cannot explain. That sweep, not a count by shape, is the evidence that the tree's results
hold on real code.
