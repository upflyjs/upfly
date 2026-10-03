#!/usr/bin/env python3
"""Replay first-parent history and record, per commit, in-app links naming no route and #anchors naming no id
(identity: file + target text). Reports which commits introduced new ones, by author, and which survive to HEAD.

Usage: route_history.py <out_json> <repo_dir> [...]
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from routes_anchors import analyze  # noqa: E402

BOT = re.compile(r"(gpt-engineer-app|lovable-dev|lovable|v0\[bot\]|vercel\[bot\])", re.I)


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, errors="replace").stdout


def main():
    out, repos = sys.argv[1], sys.argv[2:]
    results = []
    for repo in repos:
        head = git(repo, "rev-parse", "HEAD").strip()
        shas = git(repo, "rev-list", "--first-parent", "--reverse", "HEAD").split()
        prev = set()
        intro = []
        per_commit = []
        for sha in shas:
            an, ae, subj = (git(repo, "show", "-s", "--format=%an%x1f%ae%x1f%s", sha).strip().split("\x1f") + ["", "", ""])[:3]
            subprocess.run(["git", "-C", repo, "checkout", "-q", "-f", sha], capture_output=True)
            r = analyze(repo)
            cur = {("L", b[0], b[2]) for b in r["broken_links"]} | {("#", b[0], b[2]) for b in r["broken_hashes"]}
            new = sorted(cur - prev)
            bot = bool(BOT.search(an) or BOT.search(ae))
            per_commit.append({"sha": sha[:10], "bot": bot, "has_router": r["has_router"], "new": len(new)})
            for n in new:
                intro.append({"sha": sha[:10], "bot": bot, "subject": subj[:80], "kind": n[0], "file": n[1], "target": n[2]})
            prev = cur
        subprocess.run(["git", "-C", repo, "checkout", "-q", "-f", head], capture_output=True)
        final = prev
        for i in intro:
            i["survives"] = (i["kind"], i["file"], i["target"]) in final
        bot_commits = [c for c in per_commit if c["bot"]]
        results.append(
            {
                "repo": os.path.basename(repo),
                "commits": len(per_commit),
                "bot_commits": len(bot_commits),
                "bot_commits_introducing": sum(1 for c in bot_commits if c["new"] > 0),
                "human_commits_introducing": sum(1 for c in per_commit if not c["bot"] and c["new"] > 0),
                "introduced": intro,
                "final_broken": sorted(list(x) for x in final),
            }
        )
        print(f"{os.path.basename(repo)}: {len(per_commit)} commits, {len(intro)} introductions, {len(final)} at HEAD", flush=True)
    json.dump(results, open(out, "w"), indent=1)


if __name__ == "__main__":
    main()
