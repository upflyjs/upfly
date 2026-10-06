import { describe, expect, it, vi } from 'vitest';
import { UpflyError } from '../errors.js';
import type { Adapter, RawReference, SourceFile } from '../types.js';
import { type ReadFilePort, scanSources } from './scan.js';
import { hashText } from './text-hash.js';

/**
 * `scan` owns error handling for every adapter, so the interesting cases are failures: a
 * file that will not parse, a file that vanished, an adapter that throws something nobody
 * expected. `readFile` is an injected port, so each one is an entry in a plain object
 * rather than a temporary tree of broken files.
 */

function sourceFile(relative: string, adapterId: string): SourceFile {
  const extension = relative.slice(relative.lastIndexOf('.'));
  return { path: `/repo/${relative}`, relative, extension, adapterId };
}

/** A port backed by an object. A missing key rejects the way `fs` would. */
function filesystem(files: Record<string, string>): ReadFilePort {
  return async (path) => {
    const text = files[path];
    if (text === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
    }
    return text;
  };
}

/** An adapter that reports one reference per line of the form `ref:<path>`. */
function lineAdapter(id: string, extensions: readonly string[]): Adapter {
  return {
    id,
    extensions,
    findReferences: ({ file, text }) => {
      const found: RawReference[] = [];
      let offset = 0;
      for (const line of text.split('\n')) {
        if (line.startsWith('ref:')) {
          const start = offset + 'ref:'.length;
          found.push({
            file,
            start,
            end: start + line.length - 'ref:'.length,
            rawPath: line.slice('ref:'.length),
            kind: 'attr',
            shape: 'html.img.src',
            ceiling: 'high',
            asserted: true,
          });
        }
        offset += line.length + 1;
      }
      return found;
    },
    rewrite: ({ text }) => text,
  };
}

const html = lineAdapter('test-html', ['.html']);
const css = lineAdapter('test-css', ['.css']);
const adapters = [html, css];

describe('scanSources', () => {
  it('reads each file and returns what its adapter found', async () => {
    const result = await scanSources({
      sourceFiles: [sourceFile('index.html', 'test-html'), sourceFile('app.css', 'test-css')],
      adapters,
      readFile: filesystem({
        '/repo/index.html': 'ref:hero.png',
        '/repo/app.css': 'ref:bg.jpg\nref:logo.png',
      }),
    });

    expect(result.references.map((reference) => reference.rawPath)).toEqual([
      'hero.png',
      'bg.jpg',
      'logo.png',
    ]);
    expect(result.unscanned).toEqual([]);
  });

  it('hands each file to the adapter that claimed it', async () => {
    const seen: string[] = [];
    const recording: Adapter = {
      ...css,
      findReferences: ({ file }) => {
        seen.push(file);
        return [];
      },
    };

    await scanSources({
      sourceFiles: [sourceFile('index.html', 'test-html'), sourceFile('app.css', 'test-css')],
      adapters: [html, recording],
      readFile: filesystem({ '/repo/index.html': '', '/repo/app.css': '' }),
    });

    expect(seen).toEqual(['/repo/app.css']);
  });

  it('preserves source-file order regardless of which read finishes first', async () => {
    // The report is byte-identical for the same input only if order comes from the
    // input, not from IO timing.
    const delays: Record<string, number> = { '/repo/a.html': 20, '/repo/b.html': 0 };
    const readFile: ReadFilePort = async (path) => {
      await new Promise((done) => setTimeout(done, delays[path] ?? 0));
      return `ref:${path}`;
    };

    const result = await scanSources({
      sourceFiles: [sourceFile('a.html', 'test-html'), sourceFile('b.html', 'test-html')],
      adapters,
      readFile,
    });

    expect(result.references.map((reference) => reference.rawPath)).toEqual([
      '/repo/a.html',
      '/repo/b.html',
    ]);
  });

  it('starts the next read the moment any finishes, while a slow one is still reading', async () => {
    const started: string[] = [];
    const waiting = new Map<string, () => void>();
    const readFile: ReadFilePort = (path) => {
      started.push(path);
      return new Promise((resolve) => waiting.set(path, () => resolve(`ref:${path}`)));
    };
    const run = scanSources({
      sourceFiles: ['a.html', 'b.html', 'c.html'].map((name) => sourceFile(name, 'test-html')),
      adapters,
      readFile,
      concurrency: 2,
    });

    waiting.get('/repo/b.html')?.();
    await new Promise((done) => setImmediate(done));
    expect(started).toEqual(['/repo/a.html', '/repo/b.html', '/repo/c.html']);

    waiting.get('/repo/c.html')?.();
    waiting.get('/repo/a.html')?.();
    expect((await run).references.map((reference) => reference.rawPath)).toEqual([
      '/repo/a.html',
      '/repo/b.html',
      '/repo/c.html',
    ]);
  });

  it('produces identical output across concurrency settings', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`/repo/f${index}.html`, `ref:img${index}.png`]),
    );
    const sourceFiles = Array.from({ length: 40 }, (_, index) =>
      sourceFile(`f${index}.html`, 'test-html'),
    );

    const one = await scanSources({ sourceFiles, adapters, readFile: filesystem(files) });
    const many = await scanSources({
      sourceFiles,
      adapters,
      readFile: filesystem(files),
      concurrency: 7,
    });

    expect(many.references).toEqual(one.references);
  });

  describe('a file it could not read', () => {
    it('reports a parse failure instead of aborting the run', async () => {
      // The whole reason this module exists: one unparseable file in a repo must
      // not take the audit down with it.
      const throwing: Adapter = {
        ...css,
        findReferences: () => {
          throw new UpflyError('ADAPTER_PARSE_FAILED', 'Unclosed block at line 12.');
        },
      };

      const result = await scanSources({
        sourceFiles: [sourceFile('broken.css', 'test-css'), sourceFile('fine.html', 'test-html')],
        adapters: [html, throwing],
        readFile: filesystem({ '/repo/broken.css': 'a {', '/repo/fine.html': 'ref:hero.png' }),
      });

      expect(result.references.map((reference) => reference.rawPath)).toEqual(['hero.png']);
      expect(result.unscanned).toEqual([
        {
          path: '/repo/broken.css',
          relative: 'broken.css',
          extension: '.css',
          reason: 'parse-failed',
          detail: 'ADAPTER_PARSE_FAILED: Unclosed block at line 12.',
        },
      ]);
    });

    describe("a parser's own message goes to the diagnostic channel, not the report", () => {
      /** Fails as the real adapters do: our own message, the parser's text as diagnostic. */
      const real: Adapter = {
        ...css,
        findReferences: () => {
          throw new UpflyError(
            'ADAPTER_PARSE_FAILED',
            'Could not parse: invalid css syntax at line 144, column 13',
            [],
            '<css input>:144:13: Unknown word /',
          );
        },
      };

      async function scanOneBroken(
        onDiagnostic?: Parameters<typeof scanSources>[0]['onDiagnostic'],
      ) {
        return scanSources({
          sourceFiles: [sourceFile('styles/site.css', 'test-css')],
          adapters: [real],
          readFile: filesystem({ '/repo/styles/site.css': 'a {' }),
          ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
        });
      }

      it('never lets the library text reach the value the report is built from', async () => {
        // PostCSS's own text changes with a dependency upgrade, and the report must be
        // byte-identical for the same input. Asserted over the whole serialised result,
        // not only `detail`, so it holds whatever a renderer or a sort later reads.
        const result = await scanOneBroken();

        expect(JSON.stringify(result)).not.toContain('<css input>');
        expect(JSON.stringify(result)).not.toContain('Unknown word');
        expect(result.unscanned[0]?.detail).toBe(
          'ADAPTER_PARSE_FAILED: Could not parse: invalid css syntax at line 144, column 13',
        );
      });

      it('hands it to the diagnostic channel instead', async () => {
        // Not lost. Somebody debugging an adapter wants exactly this string, and it
        // answers a different question from the one the report answers.
        const seen: unknown[] = [];
        await scanOneBroken((diagnostic) => seen.push(diagnostic));

        expect(seen).toEqual([
          {
            relative: 'styles/site.css',
            adapterId: 'test-css',
            detail: '<css input>:144:13: Unknown word /',
          },
        ]);
      });

      it('drops it when nobody is listening, rather than storing it somewhere', async () => {
        // An absent sink drops the text rather than parking it on the result, so a caller
        // with nowhere to put an unstable string cannot acquire one by accident.
        // `ProbeSkip` has no `diagnostic` field for the same reason.
        const result = await scanOneBroken();

        expect(result.unscanned).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain('144:13');
      });

      it('says nothing at all when the failure was ours', async () => {
        // An `UpflyError` we raised ourselves has no library text, and inventing an
        // empty diagnostic entry for it would make the channel noisier than the
        // report it exists to keep clean.
        const ours: Adapter = {
          ...css,
          findReferences: () => {
            throw new UpflyError(
              'ADAPTER_PARSE_FAILED',
              'Could not parse: the file is not valid css',
            );
          },
        };
        const seen: unknown[] = [];

        await scanSources({
          sourceFiles: [sourceFile('styles/site.css', 'test-css')],
          adapters: [ours],
          readFile: filesystem({ '/repo/styles/site.css': 'a {' }),
          onDiagnostic: (diagnostic) => seen.push(diagnostic),
        });

        expect(seen).toEqual([]);
      });
    });

    it('writes the relative path into the detail, never the absolute one', async () => {
      // An adapter may put the absolute path it was handed into its message, and the
      // message reaches the report. Two checkouts of one repository differ in their
      // absolute paths, and the report must be byte-identical for the same input. No
      // fixture tree holds a file that fails to parse, so these tests are what cover it.
      const throwing: Adapter = {
        ...css,
        findReferences: ({ file }) => {
          throw new UpflyError('ADAPTER_PARSE_FAILED', `Could not parse ${file}: Unexpected token`);
        },
      };

      const result = await scanSources({
        sourceFiles: [sourceFile('deep/nested/broken.css', 'test-css')],
        adapters: [throwing],
        readFile: filesystem({ '/repo/deep/nested/broken.css': 'a {' }),
      });

      expect(result.unscanned[0]?.detail).toBe(
        'ADAPTER_PARSE_FAILED: Could not parse deep/nested/broken.css: Unexpected token',
      );
      expect(result.unscanned[0]?.detail).not.toContain('/repo/');
    });

    it('scrubs a Windows-spelled absolute path out of the detail too', async () => {
      // On Windows an adapter interpolates the native separator. Built with `String.raw`
      // so the backslashes stay backslashes rather than becoming escapes.
      const path = String.raw`E:\repo\deep\broken.css`;
      const file: SourceFile = {
        path,
        relative: 'deep/broken.css',
        extension: '.css',
        adapterId: 'test-css',
      };
      const throwing: Adapter = {
        ...css,
        findReferences: (input) => {
          throw new UpflyError('ADAPTER_PARSE_FAILED', `Could not parse ${input.file}: bad token`);
        },
      };

      const result = await scanSources({
        sourceFiles: [file],
        adapters: [throwing],
        readFile: filesystem({ [path]: 'a {' }),
      });

      expect(result.unscanned[0]?.detail).toBe(
        'ADAPTER_PARSE_FAILED: Could not parse deep/broken.css: bad token',
      );
      expect(result.unscanned[0]?.detail).not.toContain('E:');
    });

    it('keeps the references an adapter found before it failed, and still reports it', async () => {
      // Both have to hold: the file is reported as `parse-failed`, and the references
      // found before the failure survive. They are correct, and dropping them makes a
      // referenced asset look dead: one unparseable `<style>` block in a Markdown file
      // would discard every `![](hero.png)` above it.
      const partial: Adapter = {
        ...css,
        findReferences: ({ file }) => {
          throw new UpflyError('ADAPTER_PARSE_FAILED', 'bad CSS in a style block', [
            {
              file,
              start: 0,
              end: 9,
              rawPath: 'hero.png',
              kind: 'md' as const,
              ceiling: 'high' as const,
              asserted: true,
            },
          ]);
        },
      };

      const result = await scanSources({
        sourceFiles: [sourceFile('guide.css', 'test-css')],
        adapters: [partial],
        readFile: filesystem({ '/repo/guide.css': 'anything' }),
      });

      expect(result.references.map((reference) => reference.rawPath)).toEqual(['hero.png']);
      expect(result.unscanned.map((file) => [file.relative, file.reason])).toEqual([
        ['guide.css', 'parse-failed'],
      ]);
    });

    it('reports a failure carrying nothing exactly as it did before', async () => {
      // The control: a failure with no payload reports the file and no references. An
      // empty `partial` must not report something that was never found.
      const throwing: Adapter = {
        ...css,
        findReferences: () => {
          throw new UpflyError('ADAPTER_PARSE_FAILED', 'unclosed block');
        },
      };

      const result = await scanSources({
        sourceFiles: [sourceFile('a.css', 'test-css')],
        adapters: [throwing],
        readFile: filesystem({ '/repo/a.css': 'a {' }),
      });

      expect(result.references).toEqual([]);
      expect(result.unscanned[0]?.reason).toBe('parse-failed');
    });

    it('survives an adapter throwing something that is not an UpflyError', async () => {
      // Adapters are the contribution surface. A bug in a community adapter must not take
      // down an audit of a repository that adapter barely touches, and it must be
      // visible in the report rather than merely survived.
      const buggy: Adapter = {
        ...css,
        findReferences: () => {
          throw new TypeError('Cannot read properties of undefined (reading "value")');
        },
      };

      const result = await scanSources({
        sourceFiles: [sourceFile('app.css', 'test-css')],
        adapters: [buggy],
        readFile: filesystem({ '/repo/app.css': 'body {}' }),
      });

      expect(result.unscanned[0]?.reason).toBe('parse-failed');
      expect(result.unscanned[0]?.detail).toContain('Cannot read properties of undefined');
    });

    it('reports a file that vanished between the walk and the read', async () => {
      // A file that disappears mid-run is reported; it does not crash the run.
      const result = await scanSources({
        sourceFiles: [sourceFile('gone.html', 'test-html'), sourceFile('here.html', 'test-html')],
        adapters,
        readFile: filesystem({ '/repo/here.html': 'ref:hero.png' }),
      });

      expect(result.references).toHaveLength(1);
      expect(result.unscanned).toEqual([
        {
          path: '/repo/gone.html',
          relative: 'gone.html',
          extension: '.html',
          reason: 'unreadable',
          detail: 'ENOENT',
        },
      ]);
    });

    it('describes a rejection that carries no errno', async () => {
      const result = await scanSources({
        sourceFiles: [sourceFile('a.html', 'test-html')],
        adapters,
        readFile: async () => {
          throw new Error('the port is misconfigured');
        },
      });

      expect(result.unscanned[0]?.detail).toBe('the port is misconfigured');
    });

    it('describes a rejection that is not an Error at all', async () => {
      const result = await scanSources({
        sourceFiles: [sourceFile('a.html', 'test-html')],
        adapters,
        readFile: async () => {
          // Deliberately hostile: a port that throws a bare string.
          throw 'nope';
        },
      });

      expect(result.unscanned[0]?.detail).toBe('nope');
    });
  });

  describe('asset mentions, gathered while the text is in memory', () => {
    it('records an asset filename no adapter turned into a reference', async () => {
      // Evidence for the sweep from files an adapter did read. Collected here while the
      // text is in memory, so no file is read twice.
      const result = await scanSources({
        sourceFiles: [sourceFile('config.html', 'test-html')],
        adapters,
        readFile: filesystem({
          '/repo/config.html': ['a', 'b `/img/hero.png`', 'c'].join('\n'),
        }),
        assetBasenames: new Set(['hero.png']),
      });

      expect(result.mentions).toEqual([
        { basename: 'hero.png', relative: 'config.html', line: 2, quote: 'hero.png' },
      ]);
    });

    it('records nothing when no basenames were supplied', async () => {
      const result = await scanSources({
        sourceFiles: [sourceFile('a.html', 'test-html')],
        adapters,
        readFile: filesystem({ '/repo/a.html': 'hero.png' }),
      });

      expect(result.mentions).toEqual([]);
    });

    it('records one mention per basename per file', async () => {
      // A hundred repeats of a name are one piece of evidence, and the report cites
      // a place rather than a count.
      const result = await scanSources({
        sourceFiles: [sourceFile('a.html', 'test-html')],
        adapters,
        readFile: filesystem({ '/repo/a.html': 'hero.png hero.png hero.png' }),
        assetBasenames: new Set(['hero.png']),
      });

      expect(result.mentions).toHaveLength(1);
    });

    it('still records mentions from a file that failed to parse', async () => {
      // That file is precisely the one whose references we do not know, so its
      // mentions are the evidence that matters most.
      const throwing: Adapter = {
        ...css,
        findReferences: () => {
          throw new UpflyError('ADAPTER_PARSE_FAILED', 'unclosed block');
        },
      };

      const result = await scanSources({
        sourceFiles: [sourceFile('broken.css', 'test-css')],
        adapters: [throwing],
        readFile: filesystem({ '/repo/broken.css': 'a { background: url(hero.png) ' }),
        assetBasenames: new Set(['hero.png']),
      });

      expect(result.unscanned[0]?.reason).toBe('parse-failed');
      expect(result.mentions[0]?.basename).toBe('hero.png');
    });

    it('ignores a filename that is not an asset', async () => {
      const result = await scanSources({
        sourceFiles: [sourceFile('a.html', 'test-html')],
        adapters,
        readFile: filesystem({ '/repo/a.html': 'other.png' }),
        assetBasenames: new Set(['hero.png']),
      });

      expect(result.mentions).toEqual([]);
    });
  });

  it('throws when a file names an adapter that was not supplied', async () => {
    // A wiring mistake, not a data problem: scanning with a different adapter set
    // than discovery used. Silently skipping the file would make its assets look
    // dead, which is the failure this whole layer exists to prevent.
    const readFile = vi.fn(filesystem({}));

    await expect(
      scanSources({ sourceFiles: [sourceFile('page.vue', 'vue')], adapters, readFile }),
    ).rejects.toThrow(expect.objectContaining({ code: 'ADAPTER_NOT_REGISTERED' }));
    expect(readFile).not.toHaveBeenCalled();
  });

  it('records the text of each file that yielded a reference, and of no other', async () => {
    const result = await scanSources({
      sourceFiles: [sourceFile('index.html', 'test-html'), sourceFile('app.css', 'test-css')],
      adapters,
      readFile: filesystem({
        '/repo/index.html': 'ref:hero.png',
        '/repo/app.css': 'no reference in this one',
      }),
    });

    expect(result.texts).toEqual([
      {
        path: '/repo/index.html',
        hash: hashText('ref:hero.png'),
        holdsReplacementCharacter: false,
      },
    ]);
  });

  it('marks a text holding U+FFFD, which is how bytes that are not UTF-8 read', async () => {
    const result = await scanSources({
      sourceFiles: [sourceFile('index.html', 'test-html')],
      adapters,
      readFile: filesystem({ '/repo/index.html': 'Caf\uFFFD\nref:hero.png' }),
    });

    expect(result.texts.map((text) => text.holdsReplacementCharacter)).toEqual([true]);
  });

  it('refuses a path holding U+FFFD in such a text, whatever the adapter, and no other', async () => {
    const result = await scanSources({
      sourceFiles: [sourceFile('index.html', 'test-html')],
      adapters,
      readFile: filesystem({ '/repo/index.html': 'ref:caf\uFFFD.png\nref:hero.png' }),
    });

    const [unreadable, clean] = result.references;
    expect(unreadable?.ceiling).toBe('unsafe');
    expect(unreadable?.note).toContain('not valid UTF-8');
    expect(clean?.rawPath).toBe('hero.png');
    expect(clean?.ceiling).toBe('high');
  });

  it('scans nothing without complaint', async () => {
    const result = await scanSources({ sourceFiles: [], adapters, readFile: filesystem({}) });

    expect(result).toEqual({ references: [], unscanned: [], mentions: [], texts: [] });
  });
});
