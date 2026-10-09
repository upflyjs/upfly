> **Looking for the Express upload middleware?** That is Upfly 2, the package `upfly` at version 2:
> `npm i upfly@2` ([its code](https://github.com/upflyjs/upfly/tree/v2),
> [its documentation](https://upflyjs.github.io/upfly/)). `upfly-core` is the engine of Upfly 3, a different
> product.

# upfly-core

The engine behind the [`upfly`](https://www.npmjs.com/package/upfly) command-line tool. It finds the images in a
project and the references to them in the files it can read, plans converting the images to WebP or AVIF, and
rewrites the references in one transaction that can be undone. It makes no network calls.

Most people want the command-line tool rather than this package:

```bash
npm install --save-dev upfly
npx upfly audit
```

This package is for building on the engine. It runs on Node.js 22.18 or later (on Node.js 24, 24.11 or
later), as ES modules.

## The public API, by task

| task | what to call |
|---|---|
| Audit a project and read its report | `runPipeline`, with `servingRootsFor` for where the site is served from; then `buildReport` for the report as data, and `renderReport` for it as text |
| Convert images and rewrite their references | `optimizeProject({ root, format, publicPolicy, apply })`: with `apply: false` it returns the plan and writes nothing |
| Point the references to identical copies at one copy | `dedupeProject` |
| Undo the last run | `readManifest(createNodeFileStore(root))` for its record, `inspect` for what happened to each file since, `revert` to put every file back |
| Read a file type Upfly does not read yet | `defineAdapter`, with `rewriteByEdits` for the rewrite |
| Tell one failure from another | every function throws `UpflyError`, whose `code` is one of `UpflyErrorCode` |

`publicPolicy` is `'keep-original'`, which leaves each original beside its converted file, or `'replace'`, which
removes an original once no file Upfly reads still names it. Every export is documented in its TypeScript
declarations, which an editor shows on hover.

`upfly-core/internal` holds the rest of the engine, for the `upfly` command-line tool and the repository's own
tools. It is not part of the public API: any name in it can change in any release.

## More

- [The repository](https://github.com/upflyjs/upfly/tree/main), with the command-line tool's README: what Upfly is
  measured to do, and its limits.
- [ARCHITECTURE.md](https://github.com/upflyjs/upfly/blob/main/ARCHITECTURE.md): how the engine is built.
- [CONTRIBUTING.md](https://github.com/upflyjs/upfly/blob/main/CONTRIBUTING.md): how to add a reader for a file type.

## License

MIT
