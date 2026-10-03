#!/usr/bin/env python3
"""Share of commits (last 12 months, no merges) in mature web repositories that touch image files,
that move or rename any file, and that are marked as agent-authored (bot author or AI trailer).

Usage: base_rate.py <repo_dir> [...]  -> one JSON object per repo on stdout
"""
import json
import re
import subprocess
import sys

IMG = re.compile(r"\.(png|jpe?g|gif|webp|avif|svg|ico)$", re.I)
AGENT = re.compile(
    r"(co-authored-by:\s*(claude|copilot|cursor|codex|devin|gemini|aider|openhands|jules)|"
    r"copilot-swe-agent|devin-ai-integration|claude\[bot\]|cursor\[bot\]|codex\[bot\]|"
    r"generated with \[claude code\]|google-labs-jules|openai codex)",
    re.I,
)


def main():
    for repo in sys.argv[1:]:
        out = subprocess.run(
            ["git", "-C", repo, "log", "--no-merges", "--since=2025-10-01", "--raw", "--no-renames", "--no-abbrev",
             "--format=@@@%H%x1f%an%x1f%ae%x1f%B%x1e"],
            capture_output=True, text=True, errors="replace",
        ).stdout
        commits = []
        for chunk in out.split("@@@")[1:]:
            head, _, raw = chunk.partition("\x1e")
            sha, an, ae, body = (head.split("\x1f") + ["", "", "", ""])[:4]
            adds, dels, imgs = {}, {}, 0
            for l in raw.splitlines():
                if not l.startswith(":"):
                    continue
                meta, _, path = l.partition("\t")
                f = meta.split()
                status, old_oid, new_oid = f[4], f[2], f[3]
                if IMG.search(path):
                    imgs += 1
                if status == "A":
                    adds[new_oid] = path
                elif status == "D":
                    dels[old_oid] = path
            moves = sum(1 for oid in adds if oid in dels)
            agent = bool(AGENT.search(an + " " + ae + " " + body))
            commits.append({"imgs": imgs, "moves": moves, "agent": agent})
        n = len(commits)
        def share(pool, pred):
            k = sum(1 for c in pool if pred(c))
            return [k, len(pool)]
        ag = [c for c in commits if c["agent"]]
        print(json.dumps({
            "repo": repo.rsplit("/", 1)[-1],
            "commits": n,
            "touch_images": share(commits, lambda c: c["imgs"] > 0),
            "exact_moves": share(commits, lambda c: c["moves"] > 0),
            "agent_marked": len(ag),
            "agent_touch_images": share(ag, lambda c: c["imgs"] > 0),
        }))


if __name__ == "__main__":
    main()
