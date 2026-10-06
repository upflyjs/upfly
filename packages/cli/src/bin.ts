#!/usr/bin/env node
import { main } from './main.js';

// `exitCode` rather than `process.exit()`, so output still queued for a pipe is written.
process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  ...(process.argv[1] === undefined ? {} : { script: process.argv[1] }),
});
