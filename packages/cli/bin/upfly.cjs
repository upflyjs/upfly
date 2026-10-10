#!/usr/bin/env node
'use strict';

// The `upfly` command's first file: CommonJS, in syntax every Node.js since 4 can read, and it
// loads nothing else until the version passes. A Node.js too old for Upfly then prints one line
// saying what it needs, rather than failing on syntax or an API further in.

/** The oldest Node.js Upfly runs on: major, minor and patch. */
const FLOOR = [22, 0, 0];

/**
 * Why this Node.js cannot run Upfly, as one line, or null when it can.
 *
 * @param {string} version a Node.js version such as `22.14.0`
 * @returns {string | null}
 */
function tooOld(version) {
  const have = version.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < FLOOR.length; index += 1) {
    if (have[index] !== FLOOR[index]) {
      if (have[index] > FLOOR[index]) return null;
      return `Upfly needs Node.js ${FLOOR.join('.')} or later, and this is Node.js ${version}.`;
    }
  }
  return null;
}

module.exports = { tooOld };

if (require.main === module) {
  const problem = tooOld(process.versions.node);
  if (problem === null) {
    require('./run.cjs');
  } else {
    process.stderr.write(`${problem}\n`);
    // EXIT_CODES.USAGE: the command cannot run as it was started.
    process.exitCode = 2;
  }
}
