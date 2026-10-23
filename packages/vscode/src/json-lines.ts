import { StringDecoder } from 'node:string_decoder';

/**
 * Splits a child process's output into lines as it arrives. A chunk can end anywhere, even
 * inside a character's bytes, so text is decoded across chunks and a line is given only once
 * its line ending has arrived, or when the stream ends.
 */
export class LineReader {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  /** @param onLine called with each line, without its line ending; empty lines are skipped */
  constructor(private readonly onLine: (line: string) => void) {}

  /** Adds the next chunk of output. */
  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    let end = this.pending.indexOf('\n');
    while (end !== -1) {
      this.give(this.pending.slice(0, end));
      this.pending = this.pending.slice(end + 1);
      end = this.pending.indexOf('\n');
    }
  }

  /** Gives what is left once the stream has ended. */
  end(): void {
    this.pending += this.decoder.end();
    this.give(this.pending);
    this.pending = '';
  }

  private give(line: string): void {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text !== '') this.onLine(text);
  }
}
