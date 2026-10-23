import { describe, expect, it } from 'vitest';
import { LineReader } from './json-lines.js';

function collect(): { lines: string[]; reader: LineReader } {
  const lines: string[] = [];
  return { lines, reader: new LineReader((line) => lines.push(line)) };
}

describe('LineReader', () => {
  it('gives each complete line once', () => {
    const { lines, reader } = collect();
    reader.push(Buffer.from('{"a":1}\n{"b":2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('joins a line that arrives in two chunks', () => {
    const { lines, reader } = collect();
    reader.push(Buffer.from('{"stage":"disc'));
    expect(lines).toEqual([]);
    reader.push(Buffer.from('overed"}\n'));
    expect(lines).toEqual(['{"stage":"discovered"}']);
  });

  it('keeps a character whose bytes are split between chunks', () => {
    const { lines, reader } = collect();
    const bytes = Buffer.from('{"file":"caf\xe9.png"}\n', 'utf8');
    const cut = bytes.indexOf(0xa9);
    reader.push(bytes.subarray(0, cut));
    reader.push(bytes.subarray(cut));
    expect(lines).toEqual(['{"file":"caf\xe9.png"}']);
  });

  it('drops the carriage return of a Windows line ending', () => {
    const { lines, reader } = collect();
    reader.push(Buffer.from('{"a":1}\r\n'));
    expect(lines).toEqual(['{"a":1}']);
  });

  it('gives a last line that has no line ending when the stream ends', () => {
    const { lines, reader } = collect();
    reader.push(Buffer.from('{"a":1}\n{"b":2}'));
    reader.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('skips empty lines', () => {
    const { lines, reader } = collect();
    reader.push(Buffer.from('\n{"a":1}\n\n'));
    reader.end();
    expect(lines).toEqual(['{"a":1}']);
  });
});
