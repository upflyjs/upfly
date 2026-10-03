# Where coding agents fail often, and what Upfly could be for them

A research report for Rinkal, written 2026-10-03 on the branch `research/agent-gap-report` (from `v3` at `8ffeed1`).

How to read it. Sections 2 to 5 are evidence: every factual claim carries a link. "(opened)" means the page was read
during this research. "(search summary)" means this environment's network policy blocked the page and the figure
comes from a search engine's summary of it; check those before quoting them. Sections 6 to 8 are opinion and say so.
Section 5 is original measurement, with the scripts beside this file.

## 1. The answer

1. Your premise holds, and now it has numbers. In six active web projects, 86 of 4,545 commits over the last year
   (1.9%) touched an image file at all. In 44 agent-built projects, 43 of 1,053 agent edits (4.1%) touched an image
   file, and 2 moved or renamed any file. When a capable agent was asked to convert a real site's images or move an
   image folder, it did all three jobs correctly, in 10 to 60 minutes and 171k to 408k tokens each, where Upfly's dry
   run of the same conversion took 64 seconds (section 5.4). Agents almost never install image tools: four
   image-conversion MCP servers on npm get 13 to 434 downloads a week (for example
   [sharp-mcp](https://registry.npmjs.org/-/v1/search?text=sharp-mcp&size=3), 434), against 125M for sharp itself.
   `audit`, `optimize`, `refs` and `move` are useful, safer and cheaper than an agent doing the same job by hand, but
   they are called rarely and they fill no capability gap.
2. Where agents genuinely and frequently fail, by the strength of the evidence: knowing when the work is done (in
   Anthropic's data, 28 to 33% of experienced users' Claude Code sessions carry a hard sign of success, against 91 to
   92% judged at least partly successful); changes that must stay consistent across many files (success falls from
   48% on one-file fixes to under 10% at three or more files); and, in web work, references that point at nothing and
   pages that do not look right. Stale library knowledge, security and visual checking are real failures too, but
   each is served by a well-funded tool and none fits Upfly (sections 3 and 4).
3. The gap that fits Upfly is not images. It is a fast, offline check that every path and link in a web project's
   source names something real, run by the agent after its edits and before its commits. In the 1,053 agent edits I
   replayed, 31 (2.9%) introduced a reference that names nothing: 27 a link to a page or anchor that does not exist,
   4 an image path to a file that never existed. A check limited to images would have caught 4 of the 31. Nothing in
   an agent's loop catches these today: the build leaves string paths to the browser, language servers check code
   imports only (and do not run at all in Claude Code's cloud sessions), lychee reads HTML and Markdown but not JSX,
   CSS resolution or aliases, and the one MCP server that tries uses regular expressions and guesses by file name
   (section 4). Your engine already does the hard part, for images, and its design anticipated the rest (R92).
4. How strong this gap is: moderate, not proven. The rates come from a small, partly selected sample, dominated by
   four projects with long histories. Most of the broken links were fixed by a later edit, so the value is catching
   them before a person does, not preventing permanent damage. Typed routing in newer stacks takes part of the page
   link problem away by itself. I found no larger, cleaner gap that fits Upfly; I also found no evidence that this
   one is large enough to carry the product alone.
5. It has a future. Agent-built web projects are produced by the million, more agent runs are unattended, review is
   the constraint, and the vendors now tell agents to run a deterministic check and gate their commits on it (Claude
   Code runs a project's `verify` skill before each commit). A check that needs no browser, no network and no language
   server works exactly where unattended agents run.
6. What I would do: make `check` report every local reference that names nothing, whatever its type, then page
   links for file-based routers; ship it into the loop through `upfly init` (a `verify` skill, a hook, a CI step);
   keep `optimize`, `refs` and `move` as the repair layer; measure the result over agent histories the way the
   accuracy suite measures references (section 8).
7. A side finding: on scratch-www, `upfly check` reports a relative image path in a shared component as broken, while
   a browser loads it on every page that uses the component. That looks like a false `broken` finding (section 9).

## 2. What agents are used for

- Web front-end is the largest single slice of measured coding-agent use. In 500,000 Claude interactions (Claude.ai
  and Claude Code, 6 to 13 April 2025), JavaScript and TypeScript were 31% of coding queries and HTML and CSS 28%;
  Python was 14%. The top task categories were "UI/UX Component Development" (12%) and "Web & Mobile App Development"
  (8%), and 79% of Claude Code conversations were automation rather than collaboration.
  [Anthropic Economic Index, Apr 2025](https://www.anthropic.com/news/impact-software-development) (opened).
- AI app builders now produce web projects at a volume no human workflow does. Vendor figures: Lovable reports about
  1M new projects a week and 50M+ in total
  ([The Next Web, Jun 2026](https://thenextweb.com/news/lovable-build-economy-500m-arr-vibe-coding), search summary);
  Vercel says coding agents trigger more than half of its roughly 6M daily deployments, a count of deployments rather
  than sites ([Startup Fortune](https://startupfortune.com/guillermo-rauch-says-ai-agents-now-trigger-more-than-half-of-all-vercel-deployments/),
  search summary); Netlify reported 1M+ Bolt-built sites deployed between Nov 2024 and Mar 2025
  ([Netlify](https://www.netlify.com/press/bolt-netlify-1-million-ai-generated-websites/), search summary).
- These are web projects of exactly Upfly's kind. All 41 Lovable projects I cloned (section 5) are Vite and React
  single-page apps with images in `public/` and `src/assets/`, and all build with `vite build` (7 in development
  mode, one after a sitemap step), which runs no type check. Lovable moved new projects to TanStack Start from 13 May
  2026
  ([Lovable docs](https://docs.lovable.dev/features/upgrade-to-tanstack-start), search summary).
- More runs are unattended. The 99.9th-percentile Claude Code turn grew from under 25 minutes (Oct 2025) to over 45
  minutes (Jan 2026), and experienced users auto-approve more than 40% of sessions
  ([Anthropic, Feb 2026](https://www.anthropic.com/research/measuring-agent-autonomy), opened by a research
  sub-agent). In JetBrains' 2026 survey of 15,000+ developers, 90% use coding agents at work at least weekly
  ([JetBrains, Aug 2026](https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/), vendor survey,
  search summary).

## 3. Where agents fail

### 3.1 Knowing when the work is done

- Anthropic's own guidance: "Claude stops when the work looks done. Without a check it can run, 'looks done' is the
  only signal available, and you become the verification loop."
  [Claude Code best practices](https://code.claude.com/docs/en/best-practices) (opened).
- About 400,000 Claude Code sessions from about 235,000 people (Oct 2025 to Apr 2026): sessions by intermediate and
  expert users were judged at least partly successful 91 to 92% of the time, but carried a hard signal of success
  (matching commits or pull requests, passing tests, or the user's explicit confirmation) only 28 to 33% of the time;
  novices 77% and 15%. The success judgement is made by a model reading the transcript.
  [Anthropic, Jun 2026](https://www.anthropic.com/research/claude-code-expertise) (opened).
- On long runs, Claude "marks features as done prematurely"; an evaluator agent driving the app through Playwright
  still let "stub-only" features through, at 3 to 6 hours and $125 to $200 a run.
  [Anthropic, Nov 2025](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents),
  [Mar 2026](https://www.anthropic.com/engineering/harness-design-long-running-apps) (opened by a research sub-agent).
- Maintainers of three repositories reviewed 296 AI-written pull requests; roughly half of those that passed the tests
  would not have been merged.
  [METR, Mar 2026](https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/)
  (search summary).

### 3.2 Changes that must stay consistent across many files

- On SWE-bench-Live, a one-file patch of under 5 lines is solved 48% of the time; at 3 or more files, or more than 100
  lines, under 10%; patches touching 7 or more files are never solved. Counts tasks.
  [arXiv 2505.23419](https://arxiv.org/html/2505.23419v2) (search summary).
- RefactorBench: 100 multi-file refactoring tasks; agents solve 22%, a human under time pressure 87%.
  [arXiv 2503.07832](https://arxiv.org/abs/2503.07832v1) (search summary).
- SWE-Bench ProMax (Aug 2026): 170 refactoring tasks averaging 11.4 modified files; best resolve rate 41.2%; failed
  attempts "consistently modify fewer files than the gold patch requires", which the authors call the dominant
  failure. [arXiv 2608.09802](https://arxiv.org/abs/2608.09802) (search summary).
- In agents' own trackers (each opened): a repository-wide rename "Misses references" and "many things were missed"
  ([anthropics/claude-code#1315](https://github.com/anthropics/claude-code/issues/1315)); moves and renames become
  "complicated read/rewrites" with "problems if rewriting them isn't 100% correct"
  ([#1206](https://github.com/anthropics/claude-code/issues/1206)); a shell rename silently overwrote 36 files
  ([#31034](https://github.com/anthropics/claude-code/issues/31034)). Anecdotes, not rates.
- Paths rot in text no compiler reads: in 356 repositories with 612 agent instruction files (CLAUDE.md, AGENTS.md),
  23.0% of repositories referenced functions, classes, scripts or file paths that no longer exist
  ([arXiv 2606.09090](https://arxiv.org/abs/2606.09090), search summary); one curator found 25 of 49 file paths in a
  repository's AGENTS.md and CLAUDE.md broken
  ([githubnext/gh-aw-cao#10154](https://github.com/githubnext/gh-aw-cao/issues/10154), opened).

### 3.3 Web front-end work

- Agents score far lower on web tasks than on the Python benchmarks usually quoted: Web-Bench, best model 25.1% Pass@1
  against 65.4% on SWE-bench Verified ([arXiv 2505.07473](https://arxiv.org/abs/2505.07473)); WebGen-Bench, whole sites
  from scratch, best agent 27.8% of test cases ([arXiv 2505.03733](https://arxiv.org/abs/2505.03733)); SWE-bench
  Multimodal, 617 front-end JavaScript issues, 12% at release ([arXiv 2410.03859](https://arxiv.org/html/2410.03859v1)).
  All search summaries; models have moved on since, and the benchmarks have known defects.
- Missing resources are one of the two dominant error types when models generate web apps: WebCompass's taxonomy puts
  "Feature Missing" and "Resource Fail" (images, fonts and dependencies that fail to load) together at roughly 40 to
  55% of generation errors, and deducts for each "Resource 404".
  [arXiv 2604.18224](https://arxiv.org/html/2604.18224) (search summary; Resource Fail's own share not separable).
- The same failure by hand on the platforms: four Vercel Community threads about v0 projects whose code references
  generated images missing from the export
  ([1](https://community.vercel.com/t/v0-generated-images-missing-from-downloaded-archive/32903),
  [2](https://community.vercel.com/t/v0-project-export-missing-generated-image-assets-in-downloaded-archive/33153),
  [3](https://community.vercel.com/t/v0-project-zip-download-missing-image-files/33130),
  [4](https://community.vercel.com/t/problems-downloading-images-generated-by-vercel/31923); search summaries); Bolt
  images that stop displaying after an edit
  ([stackblitz/webcontainer-core#1631](https://github.com/stackblitz/webcontainer-core/issues/1631), opened by a
  research sub-agent); Scale AI, building a prompt-to-app platform, hit "hallucinated image URLs" in generated
  front-end code and ended up rewriting them with Babel's syntax tree after regex and LLM fixes failed
  ([summary](https://hyper.ai/en/headlines/3356555a4a52e04eb80807e1d839fef9), search summary).
- Complicating: AI-built sites are about as flawed as the average human-built site, not clearly worse. 15 sites built
  by five AI tools averaged 55 accessibility issues per page against 62 for a typical site
  ([VentureBeat on AudioEye](https://venturebeat.com/technology/we-asked-five-ai-tools-to-build-accessible-websites-all-15-sites-failed),
  vendor study, search summary).

### 3.4 Real failures that are not Upfly's

- Stale library knowledge and invented packages: 19.7% of 2.23M package references were hallucinated in 2025
  ([USENIX Security 2025](https://www.usenix.org/system/files/usenixsecurity25-spracklen.pdf)), 4.6 to 6.1% for 2026
  models ([arXiv 2605.17062](https://arxiv.org/pdf/2605.17062)); both search summaries. Served by documentation tools
  (Context7: 62.6k stars, 450k weekly npm downloads of its MCP server, [repo](https://github.com/upstash/context7),
  opened by a research sub-agent) and package scanners.
- Security: models chose the insecure option in 45% of Veracode's 2025 tasks; the 2026 pass rate is about 55% and flat
  ([Veracode](https://veracode.com/blog/spring-2026-genai-code-security), search summary). Served by security vendors.
- Seeing the page: served by browser tools, heavily used (Playwright MCP 8.76M and Chrome DevTools MCP 2.49M weekly
  npm downloads, read from the npm registry by a research sub-agent).
- Review load, the context for all of the above: in Faros AI's telemetry, median PR review time rose 441% and 31% more
  PRs were merged with no review ([ADTmag, Apr 2026](https://adtmag.com/articles/2026/04/22/more-code-more-bugs.aspx),
  vendor data, search summary). What is not checked automatically increasingly ships unchecked.

## 4. What already covers which failure

| failure | what covers it | does it reach an agent's loop for a web project? |
|---|---|---|
| a code import that names no module | compiler, bundler, language servers | yes; Claude Code's plugins catch "type errors and missing imports that its own edits introduce", once a plugin and a server are installed; "In cloud sessions, Claude Code doesn't start plugin language servers" ([docs](https://code.claude.com/docs/en/plugins/code-intelligence), opened) |
| renaming a code symbol | LSP rename through MCP servers (Serena, about 30k stars; JetBrains' MCP server) | partly; Claude Code's own LSP tool is read-only and it has no move tool ([tools reference](https://code.claude.com/docs/en/tools-reference), opened by a research sub-agent) |
| moving a JS or TS file | TypeScript's `getEditsForFileRename`, VS Code's update-imports-on-move | only for moves made in the editor; a shell `mv` triggers nothing ([AbysmalBiscuit/mcpls#33](https://github.com/AbysmalBiscuit/mcpls/issues/33), opened); updating CSS paths on a move has sat in VS Code's backlog since 2019 ([vscode-css-languageservice#177](https://github.com/microsoft/vscode-css-languageservice/issues/177), opened) |
| a path in HTML, CSS, JSX, Markdown or JSON that names no file | not the build: webpack and Vite leave `url()` strings and JSX `src` strings for the browser | lychee checks local links in HTML and Markdown offline (`--offline`, `--root-dir`), reads other files as plain text, and does not read JSX, bundler imports or aliases ([lychee](https://github.com/lycheeverse/lychee), opened, 4.0k stars); docs frameworks check their own links; `reference-mcp`, the one MCP server for asset references, uses three regular expressions, falls back to finding any file of the same name, and calls the network ([repo](https://github.com/AbduljabbarBXR/reference-mcp), 1 star, read by a research sub-agent from its npm package) |
| a link to an in-app page that does not exist | typed routing, if the project uses it and runs the type checker: Next.js `typedRoutes`, stable, "statically typed links", TypeScript only ([docs](https://github.com/vercel/next.js/blob/canary/docs/01-app/03-api-reference/05-config/01-next-config-js/typedRoutes.mdx), opened); TanStack Router, "end-to-end type safety (routes, params, loaders)" ([README](https://github.com/TanStack/router), opened) | not for string routes such as the React Router links in the Lovable projects of section 5, whose `vite build` runs no type check |
| what the page looks like | Playwright MCP, Chrome DevTools MCP, browser extensions | yes, slowly: minutes per page; $125 to $200 per long evaluator run in Anthropic's harness (section 3.1) |

The research sub-agent that surveyed tools paged the whole official MCP Registry
([API](https://registry.modelcontextprotocol.io/v0.1/servers?limit=100), 38,918 server names on 2026-10-03): its 19
broken-link servers crawl live sites; its 46 image-conversion servers are hosted or URL-based and none rewrites
references in a codebase. It concluded that no source it opened "claims to check image references offline in source
code, across JS/TS/JSX, CSS, Astro, MDX and Markdown, resolving paths the way the site will".

How a check gets into the loop today, and how tools get called often:
- Claude Code tells the agent to run a project skill named `verify` "right before each commit, except for changes to
  docs or tests" (v2.1.286 or later); a Stop hook runs a check as a script and blocks the turn from ending until it
  passes; skills are matched by their description, inside a listing budget of 1% of the context window
  ([skills](https://code.claude.com/docs/en/skills), [best practices](https://code.claude.com/docs/en/best-practices),
  both opened). GitHub Copilot reads project skills from `.github/skills`, `.claude/skills` and `.agents/skills`
  ([github/docs source](https://github.com/github/docs/blob/main/content/copilot/concepts/agents/about-agent-skills.md),
  opened).
- The vendors now steer agents from MCP tool listings to command-line tools plus skills: "Prefer CLI tools when
  available" ([Claude Code costs](https://code.claude.com/docs/en/costs), opened); "Modern coding agents increasingly
  favor CLI-based workflows exposed as SKILLs over MCP because CLI invocations are more token-efficient"
  ([Playwright MCP README](https://github.com/microsoft/playwright-mcp), opened).
- Tools get called constantly when they fill a systematic knowledge gap (Context7's README: "Code examples are
  outdated and based on year-old training data"), when they return pass or fail (tests, browsers, diagnostics), or
  when the platform switches them on (Copilot's cloud agent configures GitHub's and Playwright's MCP servers
  automatically, [github/docs source](https://github.com/github/docs/blob/main/content/copilot/concepts/agents/cloud-agent/mcp-and-cloud-agent.md),
  opened by a research sub-agent).

## 5. Experiments run for this report

Four measurements, reproducible from the scripts beside this report. Upfly itself was the instrument where it could
be: the CLI built from `v3` at `8ffeed1`.

### 5.1 How often web projects change images at all

Method: blob-less clones of six active web projects; every non-merge commit from 1 Oct 2025 to 3 Oct 2026. A commit
touches an image when it adds, changes or deletes a `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.svg` or
`.ico` file; a move is a file deleted and re-added unchanged in one commit; "agent-marked" is a bot author or an AI
co-author trailer, which undercounts agent work because most agent-assisted commits carry no mark.

| repository | commits | touch an image file | move a file | agent-marked | agent-marked touching an image |
|---|---|---|---|---|---|
| 11ty/11ty-website | 301 | 16 (5.3%) | 3 | 2 | 0 |
| nodejs/nodejs.org | 657 | 2 (0.3%) | 6 | 27 | 0 |
| reactjs/react.dev | 158 | 10 (6.3%) | 1 | 4 | 0 |
| scratchfoundation/scratch-www | 491 | 9 (1.8%) | 1 | 2 | 0 |
| shadcn-ui/ui | 1,242 | 21 (1.7%) | 15 | 63 | 2 |
| withastro/docs | 1,696 | 28 (1.7%) | 0 | 0 | 0 |
| all six | 4,545 | 86 (1.9%) | 26 (0.6%) | 98 | 2 |

### 5.2 What an agent did to 44 agent-built projects, edit by edit

Method: Lovable commits each change a person asks for as one commit by its bot (`lovable-dev[bot]`, formerly
`gpt-engineer-app[bot]`), so a Lovable project's history is a record of an agent's edits to a web project. I replayed
44 histories commit by commit: at each commit, `upfly check --json` (sampled to at most 400 commits per project, which
only `abelv22/project-foundation`, with 8,334 commits and 85 agent edits, exceeded) and a classification of the diff. An "agent edit" is a commit by the platform's agent (Lovable's `gpt-engineer-app[bot]`,
1,092 commits in all, or v0's, 2) other than its template commit.
Two strata, reported apart:

- A: 17 projects in people's own accounts, found by searching the web for Lovable's and v0's README boilerplate,
  mostly 2025 to 2026. In 9 of them no commit is by the platform's bot (pushed by a person, possibly from another AI
  tool); those count only in the snapshot at the last commit, never as agent edits.
- B: 27 projects in Lovable's own `GPT-Engineer-App` organization
  ([github.com/GPT-Engineer-App](https://github.com/GPT-Engineer-App): "New projects created with Lovable will be
  created under this organisation", 3,311 public repositories): its 8 most recently updated, and 19 from 2024 chosen
  by name as likely websites (a selection, not a random sample; 2024 means older models).

Results (agent edits only):

| | A (8 projects with agent edits) | B (24 projects) | all |
|---|---|---|---|
| agent edits | 835 | 218 | 1,053 |
| edits touching an image file | 31 (3.7%) | 12 (5.5%) | 43 (4.1%) |
| edits adding a local image path to code | 80 (9.6%) | 21 (9.6%) | 101 (9.6%) |
| edits adding a stock-photo URL (Unsplash, Pexels and similar) | 23 (2.8%) | 6 (2.8%) | 29 (2.8%) |
| edits moving or renaming any file | 2 | 0 | 2 (0.2%) |
| edits introducing a broken local image path | 2 | 2 | 4 (0.4%) |
| images the agent added | 47 (10 over 1 MB) | 28 (16 over 1 MB) | 75 (26 over 1 MB) |

- All four broken image paths name files that never existed in the repository, at any commit: an invented path, not
  a moved one. Three were fixed by a later edit; one is still broken at the last commit.
- The clearest one: in `GabrielScript/Neumann`, an agent edit titled "Refactor: Implement performance optimizations"
  added `<link rel="preload" href="/src/assets/logo.webp" as="image" type="image/webp" fetchpriority="high">` to
  `index.html`. Only `logo.png` ever existed, and a Vite production build does not serve `/src/` paths anyway. The
  person reverted the whole edit the same day (commit `c262e11`, reverted by `1e3ac68`).
  Another: `/avatars/01.png`, the placeholder path from shadcn/ui's example code, pasted into a user menu.
- Oversized images arrive as side effects of other work. In `David-Temitope/alphadom`, an edit titled "Enhance
  homepage & fix UI", whose message says "ensure faster loading by using preloaded backgrounds", added
  `public/images/about-workspace.jpg`, a 7360 by 4912 JPEG of 16.8 MB shown on the About page, plus hero images of
  1.7 to 2.9 MB; all still there (commit `eea627c`). In `withkynam/duma`, "Add app logo to header" added a 2.1 MB,
  1628 by 1799 PNG displayed at 40 by 40 CSS pixels; WebP at quality 80 would be 78 KB.
- At the last commit of all 44 projects: 91.7 MB of images, of which Upfly would save 56.6 MB (62%) as WebP; 17
  projects hold images Upfly flags as oversized; 11 use stock-photo URLs (440 in total, 351 of them in one project).
  This environment could not reach image hosts, so I could not test whether those URLs resolve.
- A template-level break: 14 of the 27 projects in stratum B carry a broken `/vite.svg` icon link from the platform's
  own 2024 template commit, and no later agent edit fixed it in any of them.

### 5.3 Links to pages and anchors that do not exist

Method: a heuristic script (regular expressions; a throwaway measuring instrument, not product code) collects the
project's routes (`<Route path>`, index routes, routes generated from a list of `to:` values, and Next.js `app/` and
`pages/` folders), every literal `to=`, `href=` and `navigate()` target starting with `/` that names no file, every
`#anchor` link, and every literal `id`. A link is flagged when no route matches it; an anchor when no element carries
that id. Projects with typed routing are skipped. Links held in variables are not read, so the counts are lower
bounds. Every flag at a last commit was checked by hand against the project's router, as were introductions in seven
projects. The first version of the script had three errors that hand-checking caught (routes generated from a list,
index routes, a manifest file taken for a page); it was corrected and every project was measured again.

| | A | B | all |
|---|---|---|---|
| agent edits introducing at least one link to a page or anchor that does not exist | 19 of 835 (2.3%) | 8 of 218 (3.7%) | 27 of 1,053 (2.6%) |
| links introduced | 21 | 19 | 40 |
| of those, still broken at the last commit | 1 | 18 | 19 |

- At the last commit, 12 of the 44 projects had at least one link that leads nowhere (in 8 introduced by the
  platform's agent, in 4 by other authors), all confirmed by hand.
- The shapes repeat: footer links to `/about`, `/contact` and `/privacy` on a one-page site (`cloud-landing`); a
  "Upgrade to Pro" button calling `navigate("/upgrade")` with no such route (`auto-vision-assist`); a user menu with
  `/profile`, `/settings` and `/support` and none of those pages (`nav-login-website`); `/terms` and `/privacy` in a v0
  project's footer with no such folders under `app/` (`Multilingual-Voice-Alerts-`); a link to `/product/:id` where the
  route is `/products/:id` (`alphadom`); `navigate('/settings')` added a day before the settings page existed
  (`alusc`, commit `1541d3e`); and, by another author, a route literally named `/dashboard/Dashboard.tsx` linked from
  three buttons (`TourFlow`).
- Together with 5.2: 31 of 1,053 agent edits (2.9%) introduced a reference that names nothing, 27 to pages or anchors
  and 4 to images, with no overlap between the two. An image-only check sees 4 of the 31.

### 5.4 Three controlled runs of a coding agent on a real site

Method: `scratchfoundation/scratch-www` at `8025bf2`, the commit Upfly's README exit run used (1,655 tracked files,
400 PNG, JPEG and GIF images), copied three times. A coding agent (a sub-agent of this session, the same model family
as the author of this report, at its default effort, with a shell and ImageMagick, without Upfly, without the
project's dependencies installed) received a person's request: twice, "convert the PNG and JPG images to WebP, update
the code, delete the old files once nothing uses them, make sure nothing breaks"; once, "move
`static/images/annual-report/` to `static/images/reports/annual/` and update every reference". Measured afterwards
against the untouched copy with `upfly check --public static`, a search for every deleted file name in every tracked
text file, and, for the move, the routes and view folders that share the name `annual-report`.

| run | result | broken references by `upfly check`, before and after | time | tokens | tool calls |
|---|---|---|---|---|---|
| move 249 images | correct: 298 references in 9 files; routes and the `annual-report` view folder untouched; no old path left | 23 and 23, none new | about 10 min | about 171k | 47 |
| convert, run 1 | correct: 236 images, 288 one-line edits in 66 files, including two template literals and bare icon names; webpack's loader rule extended; no WebP larger than its original | 23 and 23, none new | about 29 min | about 310k | 135 |
| convert, run 2 | correct, and the same 236 files as run 1 | 23 and 23, none new | about 60 min | about 408k | 150 |
| Upfly's dry run of the conversion | 182 images, 213 references in 55 files, each image left alone with its reason | | 64 s | 0 | |

- Both conversion runs left alone exactly what should be left alone: the link-preview image, an image shown only to
  Internet Explorer, 31 emoji images named only in comment text served by the Scratch API, and 107 unreferenced images.
  Both raised the question Upfly's dry run raises: the deploy deletes removed files, so old public addresses will stop
  working. They converted more than Upfly plans to, because they rewrote template literals and bare names that Upfly
  declines, and edited the webpack configuration where Upfly declines the one image whose build may not load WebP.
- What this shows: given a clear request and time, a capable agent does these jobs correctly, slowly and expensively.
  It does not show what the in-product agents of app builders do; section 5.2 does, and there the failures were side
  effects of other work, not the image jobs themselves.

## 6. The candidate gaps, ranked

Opinion, built on sections 2 to 5. Each candidate is judged on: do agents fail at it measurably; how often would a
tool be used; is it served; does it fit Upfly's engine; does it grow as agents do more of the work.

### 6.1 A check that every path and link in a web project's source names something real (recommended)

One command that reads the project the way Upfly already reads it for images and fails when any reference names
nothing: an image, but also a font, video, audio track, subtitle file, PDF, download, favicon or manifest icon, a
script or stylesheet in HTML, and later a link to an in-app page or an `#anchor`. Offline, deterministic, a second or
two, run by the agent after its edits and before its commits, and in CI.

- Agents fail at it, measurably but not spectacularly: 2.9% of agent edits in section 5, WebCompass's "Resource Fail",
  the platforms' forum threads.
- It would be used constantly, which is what you are looking for. A check runs on every commit whether or not
  anything is wrong, is silent most of the time, and catches the occasional broken reference while the agent can
  still fix it. That is the pattern of the tools agents call most (tests, browsers, diagnostics), not the twice-a-year
  pattern of `optimize`. And it catches failures that happen as side effects of other work, which a tool that waits to
  be called never sees: the preload of a missing WebP arrived in an edit about performance, not in an image task.
- Nothing serves it inside the agent's loop (section 4). Your engine is that tool already, for images.
- The fit is strong for files and weaker for pages. Files: ARCHITECTURE.md keeps the extension policy out of the
  adapters precisely so that "adding video later flows through automatically", and the accuracy suite already holds
  eight asserted references to missing `.mp4`, `.mp3`, `.ogg`, `.vtt`, `.pdf` and `.woff2` files that the engine filters
  out by design (R78 Q1, upheld by R92, which called reporting them "a different product, a broken-link checker" and
  "a new ruling with scope consequences"). Pages: a route model per framework; simple where routes are files
  (Next.js, Astro, SvelteKit, Nuxt), harder where they are code (React Router), unnecessary where routing is typed and
  type-checked.
- It grows with the trend (section 7).
- Weaknesses: small sample; most breaks fixed later; typed routing removes part of the page problem; browsers catch
  broken resources when someone looks.

### 6.2 Moving and renaming anything, with every reference updated

Agents measurably fail at changes that span many files (3.2), and nothing updates paths in CSS, HTML, Markdown or
JSON after a move. But moves are rare (0.6% of commits in 5.1; 2 of 1,053 agent edits), and the agent in 5.4 did a
249-file move correctly. Opinion: worth having, as your 3.1 plan already has it, because it repairs what 6.1 finds;
not a reason to exist on its own.

### 6.3 An image arriving in the project: sized, converted, referenced correctly

The strongest evidence that agents mishandle images is here: 26 of 75 images added by agents were over 1 MB, one of
16.8 MB under a commit message promising faster loading. But it happens in a few percent of edits; Next.js, Astro and
Nuxt projects and image CDNs handle it at build or request time; and builders that generate images are starting to
optimize their own. Opinion: this is what `optimize` already does. The useful addition is acting on just what a change
added (`check --changed` flags a new oversized image, `optimize --changed` fixes it), run by the same hook as 6.1.

### 6.4 Telling agents which assets exist

No evidence found that agents fail for lack of an inventory; they list files. Low priority.

### 6.5 What a change removes from the site's public addresses

When a page or a public file moves, outside links break. Upfly already knows the serving folders and already warns
about removed originals, and all three agents in 5.4 raised the question themselves. Unmeasured. Opinion: a line in
the check's output (public addresses a change removed, with a suggested redirect), not a product.

### 6.6 Real failures that do not fit Upfly

Stale library knowledge, seeing the rendered page, security, accessibility, search visibility of single-page apps.
Each is served, and none is a job for an offline reference graph.

## 7. Does this space have a future

Evidence for (sections 2 to 4): agents already write most new code where it is measured (Google's 75% of new code is
a vendor statement, [Semafor, Apr 2026](https://www.semafor.com/article/04/24/2026/google-ceo-says-75-of-companys-new-code-is-ai-generated),
search summary); they write web projects more than anything else; those projects are produced by the million; review
time rises faster than review capacity; and the vendors' advice is to give agents a deterministic check and gate
commits on it, through channels that now exist (a `verify` skill, Stop hooks, Copilot's skills folders, CI).

Evidence against, or limiting: models improve quickly; typed routing and server rendering are becoming defaults in
agent-built stacks (Lovable's TanStack Start); frameworks and CDNs absorb image work; agents gain browsers; and Knip,
at 19.5M weekly npm downloads with a regex reader for imports in Astro, MDX, Vue, Svelte and CSS files, could extend
into assets ([knip](https://github.com/webpro-nl/knip), read by a research sub-agent).

Opinion: the need for a fast, offline "does everything this project names exist" check grows with the volume of
unattended agent work and shrinks only where frameworks make every reference typed or imported. That shift is real but
slow: `public/` folders, CSS `url()`, Markdown, JSON data and HTML attributes are not going away, and they are where
nothing checks today. I expect such a check to stay useful for years, most of all in projects agents build and
maintain.

## 8. What I would do

Opinion, in order.

1. Make the ruling R92 deferred: `upfly check` reports every asserted local reference that names no file, whatever
   its type. The engine was designed for it and the accuracy suite already has the cases.
2. Put the check where agents run checks, with the person's yes: `upfly init`, which 3.1 already has offering to point
   the project's agent at Upfly, also writes a project `verify` skill (Claude Code runs it before each commit; Copilot
   reads `.claude/skills`), a Stop-hook snippet and a CI step. Keep the CLI as the way in; `upfly mcp` stays optional.
3. Shape the output for the agent that must fix it: file, line, the path as written, and the nearest existing files in
   the JSON ("did you mean `public/images/hero.webp`?"). A check that is noisy gets ignored or disabled, so the
   zero-false-`broken` rule matters more here than anywhere (section 9).
4. `--changed` scope, so the check costs nothing on a one-file edit.
5. Then page links for file-based routers (Next.js, Astro, SvelteKit, Nuxt), React Router where it is statically
   readable, and nothing where routing is typed.
6. Measure demand the way you measured accuracy: the replay scripts beside this report, run over a few hundred
   agent-built repositories, give breaks per 1,000 agent edits caught, and false findings per 1,000, which must be
   zero. Published, that number is the claim. The same scripts run over the platforms' own templates would have found
   the `/vite.svg` break in 14 of 27 projects at once; that is a conversation to have with an app builder.
7. Keep `optimize`, `refs`, `move` and `dedupe` as the repair layer.

What would change my mind: a larger replay showing references break in well under 1 of 100 agent edits; app
builders shipping their own static reference checks before publishing; or browser verification becoming cheap
enough to run on every commit.

## 9. A side finding for Upfly itself

On scratch-www at `8025bf2`, `upfly check --public static` reports 23 broken references. 22 are root-relative paths
to files absent from `static/` (true). The 23rd is
`src/components/timeline-card/timeline-card.jsx:20`, `src="../../images/annual-report/2020/Symbols-UI/Open Link.svg"`.
The component is imported only by the 2020 and 2021 annual-report views, served at `/annual-report/2020` and
`/annual-report`; a browser resolves the relative `src` against the page's address, `..` stops at the site root, and
the result is `/images/annual-report/2020/Symbols-UI/Open Link.svg`, which exists in `static/`. So this looks like a
false `broken` finding: the engine seems to resolve a JSX attribute string against the source file's folder, while
the browser resolves it against the page. Under your rules it belongs in the "cannot be sure" bucket, because the
page addresses are not knowable from the component. The move agent in 5.4 noticed this path and reasoned about it
correctly.

## 10. Limits of this research

- This environment's network policy denied most research sites to page fetches (arxiv.org, huggingface.co, metr.org,
  almanac.httparchive.org, which was read from its GitHub source instead, survey.stackoverflow.co,
  news.ycombinator.com, reddit.com, dev.to, web.dev, gitclear.com, coderabbit.ai, forum.cursor.com, docs.lovable.dev
  and others), and the shell could not reach image hosts. That is changed in the cloud environment's settings
  (Network access, a broader level or those hosts under Allowed domains;
  https://code.claude.com/docs/en/cloud-environments#network-access).
- The session's web-search budget (200 searches) ran out early, shared by five research sub-agents. Topics cut short:
  Figma's MCP and design-to-code asset handoff, design-system adherence, Terminal-Bench, the 2026 Stack Overflow
  survey.
- The AIDev dataset of 932,791 agent pull requests (on HuggingFace) was unreachable, so I could not measure which
  file types agents touch across many repositories; sections 5.1 and 5.2 stand in.
- `packages/cli/AGENTS.md` was not read: the permission layer declined that read, and I did not work around it.
- Small samples: the per-edit rates rest mostly on four projects with long histories; stratum B is a selection by
  name and largely from 2024; the controlled runs are three runs, one model family (the one writing this), one
  repository.
- The link measurement is a heuristic; its flags were hand-checked, and what it cannot read is not counted.
- Vendor figures (Lovable, Vercel, Netlify, Google, Faros, JetBrains, AudioEye) are self-reported.

## Appendix: reproducing section 5

The scripts are in this folder; each starts with a comment saying what it measures. Paths inside them point at the
scratch folder this research ran in; change the `SP` constant. `sample.txt` lists the 44 projects with their stratum,
`heads.txt` the commit each was measured at, and `results/` holds the aggregated outputs.

1. `batch.sh` clones each project and runs `analyze_history.py` (per-commit classification and `upfly check` replay).
2. `route_history.py` (with `routes_anchors.py`) replays links and anchors; `merge_routes.py` merges its outputs.
3. `aggregate.py` runs `upfly audit --json` at each last commit; `summary.py` prints the figures quoted in 5.2 and 5.3.
4. `base_rate.py` measures section 5.1 over blob-less clones.
5. `measure_run.py` measures a controlled run against the untouched copy (section 5.4).
