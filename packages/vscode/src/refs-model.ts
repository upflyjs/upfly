/**
 * The rows of "Where is this image used?", built from `upfly refs <image> --json`: the image,
 * each reference to it, each other line that names it, which Upfly does not follow, and what
 * `upfly optimize` would do with it.
 */

import { type TreeNode, parseWhere } from './audit-model.js';
import type { RefsResult, UnfollowedReason } from './contract.js';
import { formatBytes, plural } from './format.js';

const REASON_WORDS: Record<UnfollowedReason, string> = {
  'full-address': 'a full address',
  'built-at-runtime': 'built at runtime',
  'data-or-props': 'a value in data or props',
  'unread-file-type': 'in a file type Upfly does not read',
  comment: 'a comment',
  folder: 'a folder path',
  other: 'not followed',
};

/**
 * The rows for one image.
 *
 * @param result the result line of `upfly refs`
 */
export function refsNodes(result: RefsResult): TreeNode[] {
  const nodes: TreeNode[] = [
    {
      label: result.image,
      description: formatBytes(result.bytes),
      icon: 'file-media',
      open: { file: result.image, line: null },
      image: result.image,
    },
    group(
      'References',
      'references',
      'Every place a file Upfly reads uses this image. When Upfly converts or moves it, it rewrites each one it can.',
      result.references.map((reference) => ({
        label: reference.line === null ? reference.file : `${reference.file}:${reference.line}`,
        description: reference.text,
        tooltip: reference.rewritable
          ? 'A run can point it at a new file.'
          : `Stays as written in every run: ${reference.why ?? 'Upfly cannot rewrite it'}`,
        open: { file: reference.file, line: reference.line, search: reference.text },
      })),
      (count) => plural(count, 'reference'),
    ),
    group(
      'Not followed',
      'eye-closed',
      'Other lines that name this image, which Upfly does not follow. A run leaves them as written, so a move or a rename has to change the ones that load the image by hand.',
      result.unfollowed.map((line) => ({
        label: `${line.file}:${line.line}`,
        description: `${REASON_WORDS[line.reason]}; ${line.loads ? 'a page can still load the image through it' : 'nothing loads the image through it'}`,
        tooltip: line.why,
        open: { file: line.file, line: line.line, search: line.text },
      })),
      (count) => plural(count, 'line'),
    ),
  ];
  if (result.unsearchable !== undefined && result.unsearchable.length > 0) {
    nodes.push(
      group(
        'Could not be searched',
        'warning',
        'Files the search could not read, so a line in them naming this image cannot be ruled out.',
        result.unsearchable.map((file) => ({
          label: file.file,
          description: file.reason,
          open: { file: file.file, line: null },
        })),
        (count) => plural(count, 'file'),
      ),
    );
  }
  nodes.push(verdictNode(result.verdict));
  return nodes;
}

function group(
  label: string,
  icon: string,
  tooltip: string,
  children: TreeNode[],
  counted: (count: number) => string,
): TreeNode {
  return children.length === 0
    ? { label, description: 'none', tooltip, icon }
    : { label, description: counted(children.length), tooltip, icon, children };
}

function verdictNode(verdict: RefsResult['verdict']): TreeNode {
  const base = { label: 'What optimize would do', icon: 'lightbulb' };
  switch (verdict.kind) {
    case 'converts':
      return {
        ...base,
        description: `converts it to ${verdict.to}, ${formatBytes(verdict.savedBytes)} smaller, and ${verdict.removesOriginal ? 'removes the original' : 'keeps the original'}`,
      };
    case 'not-converted':
      return { ...base, description: 'leaves it as it is', tooltip: verdict.why };
    case 'unused':
      return {
        ...base,
        description: 'nothing: no reference uses it',
        tooltip:
          'No reference leads to it, and its name appears nowhere else. Upfly never deletes it. A path built at runtime can still produce its name, and an image in a folder the site serves may be linked from outside the project.',
      };
    case 'possibly-unused':
      return {
        ...base,
        description: 'nothing: its name appears where Upfly could not follow it',
        tooltip: 'Read these mentions before treating it as unused.',
        children: verdict.mentions.map((mention) => ({
          label: mention.quote,
          description: mention.where,
          open: { ...parseWhere(mention.where), search: mention.quote },
        })),
      };
  }
}
