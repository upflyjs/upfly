/** What `upfly --help` and `upfly <command> --help` print. */

import type { CommandName } from './args.js';

const GENERAL = `Usage: upfly <command> [dir] [options]

Finds the images in a project and the references to them in the files it can read, and
names the files it could not read.

Commands:
  audit [dir]      Report images, references, and what could be smaller. Changes no
                   project file.
  optimize [dir]   Convert images, update the references it can rewrite, and remove each
                   original they replace. Shows the plan and changes nothing unless run
                   with --apply.
  undo [dir]       Put back every file the last optimize, dedupe or move --apply changed.
  check [dir]      An optional guard for continuous integration: fail when a reference
                   names an image that does not exist. Changes nothing.
  init [dir]       Write upfly.config.json with the folders Upfly works out, and say why;
                   with --agents, point the project's coding agents at Upfly too.
  refs <image> [dir]
                   List every line that names one image: the references, whether Upfly
                   could rewrite each, the lines it does not follow and why, and what
                   optimize would do with it. Changes nothing.
  dedupe [dir]     Keep one copy of each image stored more than once and point the
                   references at it. Deletes nothing; shows the plan unless run with --apply.
  move <from> <to> [dir]
                   Move an image, or the images in a folder, update the references Upfly
                   can rewrite, and list every other line that still names the old path.
                   Deletes nothing; shows the plan unless run with --apply.

Options for every command:
  --json         Print one JSON object per line: progress, then the result
  -h, --help     Show help for a command
  -v, --version  Print the version

dir is the project to read, the current directory by default. Its upfly.config.ts or
upfly.config.json is read if there is one.

audit, optimize, dedupe and move print a summary, and keep it with every list in full in a
file named after the command (.upfly/audit.txt, .upfly/optimize.txt, .upfly/dedupe.txt,
.upfly/move.txt), which git is told to ignore. --full prints that file; --show <row> prints one row of it with its
list.
`;

const AUDIT = `Usage: upfly audit [dir] [options]

Reports the images in the project, the references to them in the files it can read, the
references that point at nothing, the images nothing references, and what upfly optimize
would convert and save with the same folder, options and config: it measures the images
optimize could convert as WebP, or AVIF when the config names it, and plans as optimize
does. It reads the project and changes no file in it. It prints a summary, and keeps it
with every list in full in .upfly/audit.txt, which git is told to ignore.

Options:
  --full                 Print the full report instead of the summary
  --show <row>           Print one row of the summary with its complete list: references,
                         savings, broken, unused, oversized, copies or skipped
  --public <dir>         A folder the site is served from, such as public; repeat it for
                         several, and use . for the project root itself. Without it, Upfly
                         works the folders out and says so
  --exclude <pattern>    Leave matching paths out, in .gitignore syntax; repeatable
  --max-encodes <n>      Measure the n largest images optimize could convert (default 100);
                         past them, the savings are marked "at least"
  --probe-all            Measure every image optimize could convert, however many
  --no-probe             Read no image at all; sizes and savings are then not measured
  --include-discarded    Also list the path-like strings that linked nothing
  --include-unused-svg   Also list the unused SVG files, which are otherwise only counted
  --json                 Print one JSON object per line: progress, then the report

Exit status: 0 when the audit ran, 2 for a usage or configuration error, 3 when the
configuration file belongs to another tool, 4 for a failure Upfly did not anticipate.
`;

const OPTIMIZE = `Usage: upfly optimize [dir] [options]

Converts each image that measures smaller as WebP (or AVIF), updates the references to it
that Upfly can rewrite safely, and removes the original once no file Upfly reads still
names it. Without --apply it changes no project file and shows a summary of the plan: what
would be converted, which files would change, which originals would go, and how many
images are left alone and why. The full plan, with every list in full, is kept in
.upfly/optimize.txt.

Options:
  --apply                Write the plan. Refused while the project folder has uncommitted
                         changes or git does not track it, so that the run's changes are
                         the only ones to review
  --commit               With --apply: commit exactly the files the run wrote, as one
                         commit that git revert undoes
  --keep-originals       Keep each original beside its converted file. By default an
                         original is removed once no file Upfly reads still names it, so a
                         link from outside the project to one in a folder the site is
                         served from stops working; --replace asks for that default
  --dry-run              Show the plan and change nothing, as a run without --apply does
  --format <webp|avif>   The format to convert to (default webp)
  --full                 Print the full plan instead of the summary
  --show <row>           Print one row of the summary with its complete list: convert,
                         update or leave
  --only <pattern>       Convert only the matching images, in .gitignore syntax relative to
                         the project, such as images/logo.png or *.jpg; repeatable. The
                         whole project is still read, as on any run
  --public <dir>         A folder the site is served from, such as public; repeat it for
                         several, and use . for the project root itself
  --exclude <pattern>    Leave matching paths out, in .gitignore syntax; repeatable
  --allow-dirty          With --apply: write even with uncommitted changes, or outside a
                         git repository. upfly undo still puts the files back
  --include-declined     In the JSON, also list each image left unconverted, with the
                         reason; the full plan always does
  --include-discarded    Also list the path-like strings that linked nothing
  --include-unused-svg   Also list the unused SVG files, which are otherwise only counted
  --json                 Print one JSON object per line: progress, then the result

Every image is measured before it is converted, so the first run on a large project
takes a while. The full text of each run, and the record of an applied run, are kept in
.upfly/, which git is told to ignore.

Exit status: 0 when the run finished, including when there was nothing to do; 2 for a
usage or configuration error; 3 when Upfly refused to write, and the message says why and
what to do; 4 for a failure Upfly did not anticipate.
`;

const UNDO = `Usage: upfly undo [dir] [options]

Puts back every file the last optimize, dedupe or move --apply changed: removed originals
come back, updated references point at them again, converted files are removed, and
moved images go back where they were. It checks each file first and changes nothing if any of them was edited since
that run.

Options:
  --json                 Print one JSON object per line: the result

Exit status: 0 when the files were put back or there was nothing to undo; 2 for a usage
error; 3 when undo refused because a file changed since the run, or another run is in
progress; 4 for a failure Upfly did not anticipate.
`;

const CHECK = `Usage: upfly check [dir] [options]

An optional guard for continuous integration. By default it fails when a reference names an
image that does not exist, or when an image a reference uses is larger than
check.maxImageBytes in the config file, if that is set. It also lists, apart, image paths in
code or data that name no file, which Upfly does not read as references, so it cannot tell
whether a page shows them: these fail it only when check.failOn or --fail-on names
possibly-broken. An unused image never fails it. The line under the headline says whether it
passed and why; the lists follow. It reads no pixels and changes nothing.

Options:
  --fail-on <kinds>      What fails the check in this run, over check.failOn in the config:
                         broken, too-large or possibly-broken, separated by commas or with
                         the flag repeated
  --warn                 List everything and exit 0 whatever is found, so a workflow shows
                         the lists without failing
  --changed [ref]        Keep only what a change could have caused: the findings in files
                         changed since ref (a branch, tag or commit; measured from where
                         the current commit and ref last shared history), or with no ref,
                         in files with uncommitted changes. A reference to an image the
                         change deleted counts wherever it sits. Put the folder before
                         --changed when no ref follows it
  --public <dir>         A folder the site is served from, such as public; repeat it for
                         several, and use . for the project root itself
  --exclude <pattern>    Leave matching paths out, in .gitignore syntax; repeatable
  --json                 Print one JSON object per line: progress, then the result

Exit status: 0 when it passed, or under --warn; 1 when it found something of a kind that
fails it; 2 for a usage or configuration error, or a ref git does not know; 3 when Upfly
cannot tell where the site is served from, or the configuration file belongs to another
tool; 4 for a failure Upfly did not anticipate.
`;

const INIT = `Usage: upfly init [dir] [options]

Writes upfly.config.json in the project: the folders the site is served from, as Upfly
works them out when none is named, and the format to convert to, with the reason for each.
Read it, correct what is wrong, and every command uses it from then on. It never changes
a configuration file that already exists.

Options:
  --agents               Also point the project's coding agents at Upfly: add a marked
                         block to AGENTS.md, created when there is none, and to a CLAUDE.md
                         or GEMINI.md already there, and put the Upfly skill in
                         .agents/skills and .claude/skills. It changes nothing outside its
                         block, keeps a configuration file that exists, and a second run
                         changes nothing
  --json                 Print one JSON object per line: progress, then the result

Exit status: 0 when the files were written; 2 for a usage error; 3 when a configuration
file already exists and --agents was not given, which the message names, or an
instruction file holds an Upfly block with no end; 4 for a failure Upfly did not
anticipate.
`;

const REFS = `Usage: upfly refs <image> [dir] [options]

Lists every line in the project that names one image. First its references: the file and
line, the path as written, and, for one optimize would leave as it is, why. Then, under
Not followed, every other line a search for the image's path finds, in any letter case and
as a browser reads a path written percent-encoded or with HTML character references,
with why Upfly does not follow it: a full address, a path built at runtime, a value in data
or a component's props, a file type Upfly does not read, a comment. Upfly leaves those as
written when it converts or moves the image. A line that names another file of the same
name is in neither list. Last, the verdict: what optimize would do with the image, with the
configured format and policy, or that it is unused. It reads the whole project, the files
--exclude leaves out included, measures only that image, and changes nothing.

image is a path from the current folder, and must be inside the project.

Options:
  --public <dir>         A folder the site is served from, such as public; repeat it for
                         several, and use . for the project root itself
  --exclude <pattern>    Leave matching paths out, in .gitignore syntax; repeatable
  --json                 Print one JSON object per line: progress, then the answer

Exit status: 0 with the answer; 2 when the image does not exist, is outside the project or
is not an image Upfly found, or for a usage or configuration error; 3 when the
configuration file belongs to another tool; 4 for a failure Upfly did not anticipate.
`;

const DEDUPE = `Usage: upfly dedupe [dir] [options]

For each set of images with the same bytes, keeps one copy and points the references to the
others at it, where the kept copy can be reached the way each reference loads files: a URL
from the same folder the site is served from, an import from outside every such folder. A
reference that cannot follow stays as written, with the reason. Without --apply it changes
no project file and shows a summary of the plan, with the full plan in .upfly/dedupe.txt.
It never deletes a file: a copy nothing names any more is left where it is, and upfly
audit lists it as unused, with its size.

The copy kept is the one the most references use; on a tie, one a folder the site is served
from holds, then the shortest path, then the first in path order.

Options:
  --keep <path>          Keep this copy of its set, a path inside the project; repeatable,
                         one per set
  --full                 Print the full plan instead of the summary
  --show <row>           Print one row of the summary with its complete list: sets,
                         update, leave or unused
  --apply                Write the plan. Refused while the project folder has uncommitted
                         changes or git does not track it, as optimize is
  --dry-run              Show the plan and change nothing, as a run without --apply does
  --commit               With --apply: commit exactly the files the run wrote, as one
                         commit that git revert undoes
  --allow-dirty          With --apply: write even with uncommitted changes, or outside a
                         git repository. upfly undo still puts the files back
  --public <dir>         A folder the site is served from, such as public; repeat it for
                         several, and use . for the project root itself
  --exclude <pattern>    Leave matching paths out, in .gitignore syntax; repeatable
  --json                 Print one JSON object per line: progress, then the result

Exit status: 0 when the run finished, including when there was nothing to do; 2 for a
usage or configuration error, such as a --keep that names no copy; 3 when Upfly refused to
write, and the message says why and what to do; 4 for a failure Upfly did not anticipate.
`;

const MOVE = `Usage: upfly move <from> <to> [dir] [options]

Moves an image, or each image in a folder, and updates each reference to it that Upfly
can rewrite to name the new place, in the form it was written in. A move Upfly cannot make
safely is refused with the reason: a destination outside the project or already holding a
file, a move between the bundled source and a folder the site is served from, an image a
path built at runtime also matches. A reference that cannot follow is listed with the
reason, and so is every other line that still names the old path, such as a full address
or a comment, found by a search of every file: Upfly leaves those as written. Without
--apply it changes no project file and shows a summary of the plan, with the full plan in
.upfly/move.txt. It deletes no image.

from and to are paths from the current folder, inside the project. A to that is a folder,
or ends in a slash, takes from in under its own name.

Options:
  --full                 Print the full plan instead of the summary
  --show <row>           Print one row of the summary with its complete list: move,
                         update, leave, unfollowed or refused
  --apply                Write the plan. Refused while the project folder has uncommitted
                         changes or git does not track it, as optimize is
  --dry-run              Show the plan and change nothing, as a run without --apply does
  --commit               With --apply: commit exactly the files the run wrote, as one
                         commit that git revert undoes
  --allow-dirty          With --apply: write even with uncommitted changes, or outside a
                         git repository. upfly undo still puts the files back
  --public <dir>         A folder the site is served from, such as public; repeat it for
                         several, and use . for the project root itself
  --exclude <pattern>    Leave matching paths out, in .gitignore syntax; repeatable. Their
                         files are still searched for lines naming the old path
  --json                 Print one JSON object per line: progress, then the result

Exit status: 0 when the run finished; 2 for a usage or configuration error, such as a path
outside the project or one that names no image; 3 when Upfly refused to write, or refused
every move asked for, and the message says why; 4 for a failure Upfly did not anticipate.
`;

const TEXT: Record<CommandName, string> = {
  audit: AUDIT,
  optimize: OPTIMIZE,
  undo: UNDO,
  check: CHECK,
  init: INIT,
  refs: REFS,
  dedupe: DEDUPE,
  move: MOVE,
};

/** The help for one command, or the general help when `command` is null. */
export function helpText(command: CommandName | null): string {
  return command === null ? GENERAL : TEXT[command];
}
