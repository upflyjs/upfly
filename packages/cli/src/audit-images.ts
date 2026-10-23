/**
 * Every image an audit found, each with its size, the references to it at their file and line,
 * and the kinds of finding that name it: what `audit --json --include-images` adds, so an
 * editor can show each image and the code that uses it without reading the project itself.
 */

import { readFile } from 'node:fs/promises';
import type { Finding, PipelineOutput, Report } from 'upfly-core';
import { type LinkedReference, citeReferences, isLinked, relativePath } from 'upfly-core/internal';

/** A kind of finding that names one image, rather than a reference or the whole project. */
export type ImageFindingKind = Exclude<Finding['kind'], 'broken' | 'serving-root-unknown'>;

/** One image, as `audit --json --include-images` lists it. */
export interface AuditImage {
  /** Where it is, POSIX-relative to the project root. */
  readonly path: string;
  readonly bytes: number;
  /** Each reference that links it, in the report's order. */
  readonly references: readonly AuditImageReference[];
  /** The kind of each finding that names it, in the report's order. */
  readonly findings: readonly ImageFindingKind[];
}

/** A reference to one image, where it is written. */
export interface AuditImageReference {
  /** The file that holds it, POSIX-relative to the project root. */
  readonly file: string;
  /** Counted from 1, or null when the file could not be read again to count it. */
  readonly line: number | null;
  /** The path as written. */
  readonly text: string;
}

/**
 * Each image of the audit's graph, in path order, with its references cited from the files.
 *
 * @param output what the pipeline found
 * @param report the report built from it, whose findings are matched to each image
 */
export async function auditImages(output: PipelineOutput, report: Report): Promise<AuditImage[]> {
  const { graph } = output;
  const linked = graph.assets.flatMap(
    (node) => node.references.filter(isLinked) as LinkedReference[],
  );
  const { citations } = await citeReferences({
    references: [...new Set(linked)],
    root: graph.root,
    readFile: (file) => readFile(file, 'utf8'),
  });
  const findings = findingsByImage(report.findings);
  return graph.assets.map((node) => ({
    path: node.asset.relative,
    bytes: node.asset.bytes,
    references: (node.references.filter(isLinked) as LinkedReference[]).map((reference) => {
      const citation = citations.get(reference);
      return {
        file: citation?.file ?? relativePath(graph.root, reference.file),
        line: citation?.line ?? null,
        text: reference.rawPath,
      };
    }),
    findings: findings.get(node.asset.relative) ?? [],
  }));
}

/** The kinds of finding that name each image, by its path. */
function findingsByImage(found: readonly Finding[]): Map<string, ImageFindingKind[]> {
  const byImage = new Map<string, ImageFindingKind[]>();
  const add = (path: string, kind: ImageFindingKind) => {
    const kinds = byImage.get(path) ?? [];
    if (!kinds.includes(kind)) kinds.push(kind);
    byImage.set(path, kinds);
  };
  for (const finding of found) {
    if ('asset' in finding) add(finding.asset, finding.kind);
    else if (finding.kind === 'duplicate')
      for (const path of finding.assets) add(path, finding.kind);
  }
  return byImage;
}
