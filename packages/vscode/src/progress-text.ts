import type { ProgressLine } from './contract.js';

/**
 * What the engine is doing while the stage after a progress line runs, in the words the
 * terminal shows for the same stage. A line reports the stage that finished, so the text
 * names the next one.
 *
 * @param line the progress line the CLI printed last
 * @returns the text, without the extension's name in front
 */
export function progressText(line: ProgressLine): string {
  switch (line.stage) {
    case 'discovered':
      return `reading ${counted(line.files, 'file')}`;
    case 'scanned':
      return `resolving ${counted(line.references, 'reference')}`;
    case 'resolved':
      return 'searching other files for image names';
    case 'measuring':
      return `measuring images: ${line.done} of ${line.total}`;
    case 'measured':
      return 'finding identical images';
    case 'audited':
      return line.command === 'refs' ? 'working out what optimize would do' : 'writing the report';
    case 'planned':
      return line.command === 'refs' ? 'searching every file' : 'writing the plan';
    case 'written':
      return 'finishing';
  }
}

function counted(value: number, noun: string): string {
  return `${value} ${value === 1 ? noun : `${noun}s`}`;
}
