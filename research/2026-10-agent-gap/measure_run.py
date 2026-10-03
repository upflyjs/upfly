#!/usr/bin/env python3
"""Measure an agent's run on a copy of scratch-www against the untouched base.

Usage: measure_run.py <run_dir> <kind: convert|move>
Prints JSON: files changed, images converted/deleted/added, broken references before/after (upfly check),
leftover mentions of removed image names, mis-sized conversions, collateral edits.
"""
import json
import os
import re
import subprocess
import sys

UPFLY = "/home/user/upfly/packages/cli/dist/bin.js"
SP = "/tmp/claude-0/-home-user-upfly/cbf25f28-394c-59c0-8dce-3231dc847520/scratchpad"
BASE = f"{SP}/agentexp/scratch-www-base"
TEXT = re.compile(r"\.(html?|css|scss|less|jsx?|tsx?|mjs|cjs|json|md|mdx|ya?ml|ejs|hbs|txt|xml)$", re.I)


def git(repo, *a):
    return subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True, errors="replace").stdout


def check(repo):
    r = subprocess.run(["node", UPFLY, "check", "--public", "static", "--json"], cwd=repo, capture_output=True,
                       text=True, timeout=900)
    res = [json.loads(l) for l in r.stdout.splitlines() if l.startswith("{") and '"result"' in l]
    res = res[-1] if res else {}
    return {(f["file"], f["rawPath"]) for f in res.get("findings", []) if f.get("kind") == "broken"}


def main():
    run, kind = sys.argv[1], sys.argv[2]
    status = git(run, "status", "--porcelain", "--untracked-files=all").splitlines()
    deleted = [l[3:] for l in status if l.startswith(" D") or l.startswith("D ")]
    added = [l[3:] for l in status if l.startswith("??")]
    modified = [l[3:] for l in status if l.startswith(" M") or l.startswith("M ")]
    renamed = [l[3:] for l in status if l.startswith("R")]
    before = check(BASE)
    after = check(run)
    new_broken = sorted(after - before)
    fixed = sorted(before - after)
    out = {
        "run": os.path.basename(run),
        "modified_files": len(modified),
        "deleted_files": len(deleted),
        "added_files": len(added),
        "renamed": len(renamed),
        "broken_before": len(before),
        "broken_after": len(after),
        "new_broken": [list(x) for x in new_broken],
        "fixed_broken": len(fixed),
    }
    if kind == "convert":
        del_imgs = [p for p in deleted if re.search(r"\.(png|jpe?g)$", p, re.I)]
        new_webp = [p for p in added if p.lower().endswith(".webp")]
        bigger = []
        for p in del_imgs:
            w = re.sub(r"\.(png|jpe?g)$", ".webp", p, flags=re.I)
            wp = os.path.join(run, w)
            if os.path.exists(wp):
                orig = int(git(BASE, "cat-file", "-s", f"HEAD:{p}").strip() or 0)
                if os.path.getsize(wp) >= orig:
                    bigger.append([p, orig, os.path.getsize(wp)])
        # Leftover mentions: names of deleted originals still written anywhere in tracked text files.
        names = {os.path.basename(p) for p in del_imgs}
        leftovers = []
        files = [f for f in git(run, "ls-files").split("\n") if TEXT.search(f)]
        for f in files:
            fp = os.path.join(run, f)
            if not os.path.exists(fp):
                continue
            try:
                t = open(fp, encoding="utf-8", errors="replace").read()
            except Exception:
                continue
            for n in names:
                if n in t:
                    for m in re.finditer(re.escape(n), t):
                        line = t.count("\n", 0, m.start()) + 1
                        leftovers.append([f, line, n])
        # Unused originals deleted: images nothing referenced in the base (per Upfly's plan).
        out.update({
            "originals_deleted": len(del_imgs),
            "webp_added": len(new_webp),
            "webp_not_smaller": bigger,
            "leftover_mentions_of_deleted_names": leftovers[:200],
            "leftover_count": len(leftovers),
        })
    else:
        moved_dir = os.path.join(run, "static/images/reports/annual")
        n_moved = sum(len(fs) for _, _, fs in os.walk(moved_dir)) if os.path.isdir(moved_dir) else 0
        old_left = sum(len(fs) for _, _, fs in os.walk(os.path.join(run, "static/images/annual-report"))) \
            if os.path.isdir(os.path.join(run, "static/images/annual-report")) else 0
        mentions = git(run, "grep", "-n", "images/annual-report", "--", ":!static").splitlines()
        routes_diff = git(run, "diff", "--", "src/routes.js")
        view_dir_exists = os.path.isdir(os.path.join(run, "src/views/annual-report"))
        out.update({
            "files_in_new_folder": n_moved,
            "files_left_in_old_folder": old_left,
            "old_path_mentions_outside_static": mentions[:50],
            "routes_js_changed": bool(routes_diff.strip()),
            "views_annual_report_dir_exists": view_dir_exists,
            "diff_stat": git(run, "diff", "--stat").splitlines()[-1:] if git(run, "diff", "--stat") else [],
        })
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
