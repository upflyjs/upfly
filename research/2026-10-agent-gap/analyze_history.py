#!/usr/bin/env python3
"""Replay a repository's first-parent history and measure, per commit:
- whether it touches image files (added/modified/deleted/renamed)
- whether its diff adds or removes lines naming an image path (local or external URL)
- whether it renames/moves any file
- the broken local image references `upfly check` reports at that commit
Then aggregate: commits that introduced a new broken reference, whether it survives to HEAD,
and whether the missing path ever existed in the repository's history.

Usage: analyze_history.py <repo_dir> <out_json> [max_commits]
"""
import json
import os
import re
import subprocess
import sys
import time

UPFLY = "/home/user/upfly/packages/cli/dist/bin.js"
IMG_FILE = re.compile(r"\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?)$", re.I)
RASTER_FILE = re.compile(r"\.(png|jpe?g|gif|webp|avif|bmp|tiff?)$", re.I)
SRC_FILE = re.compile(r"\.(html?|css|scss|sass|less|jsx?|tsx?|mjs|cjs|astro|vue|svelte|mdx?|json)$", re.I)
URL = re.compile(r"https?://[^\s\"'`)<>\]]+", re.I)
IMG_PATH = re.compile(r"[\w@~./%+-]*\.(?:png|jpe?g|gif|webp|avif|svg)(?![\w])", re.I)
IMG_HOSTS = re.compile(
    r"(images\.unsplash\.com|source\.unsplash\.com|plus\.unsplash\.com|picsum\.photos|placehold|placeholder\.com|"
    r"via\.placeholder|images\.pexels\.com|randomuser\.me|pravatar|dummyimage|loremflickr|ui-avatars|dicebear|"
    r"cloudinary|imgur|lovable-uploads|storage\.googleapis|supabase\.co/storage)",
    re.I,
)
BOT = re.compile(r"(gpt-engineer-app|lovable-dev|lovable|v0\[bot\]|vercel\[bot\]|bolt|copilot|claude|devin|cursor)", re.I)


def git(repo, *args, text=True):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=text, errors="replace" if text else None)
    return r.stdout


def upfly_check(repo):
    try:
        r = subprocess.run(
            ["node", UPFLY, "check", "--json"], cwd=repo, capture_output=True, text=True, timeout=180
        )
    except subprocess.TimeoutExpired:
        return {"error": "timeout"}
    lines = [l for l in r.stdout.splitlines() if l.strip().startswith("{")]
    result = None
    for l in lines:
        try:
            o = json.loads(l)
        except json.JSONDecodeError:
            continue
        if o.get("type") == "result":
            result = o
    if result is None:
        return {"error": f"exit {r.returncode}", "stderr": r.stderr[-300:]}
    broken = sorted({(f.get("file"), f.get("rawPath")) for f in result.get("findings", []) if f.get("kind") == "broken"})
    return {"exit": result.get("exitCode"), "broken": broken, "reason": result.get("reason")}


def classify_diff(diff_text):
    added_local, removed_local, added_ext, removed_ext = [], [], [], []
    for line in diff_text.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            continue
        if not (line.startswith("+") or line.startswith("-")):
            continue
        body = line[1:]
        urls = URL.findall(body)
        ext_imgs = [u for u in urls if IMG_HOSTS.search(u) or re.search(r"\.(png|jpe?g|gif|webp|avif|svg)(\?|$)", u, re.I)]
        stripped = URL.sub(" ", body)
        locals_ = [p for p in IMG_PATH.findall(stripped) if not p.startswith("data:")]
        if line.startswith("+"):
            added_local += locals_
            added_ext += ext_imgs
        else:
            removed_local += locals_
            removed_ext += ext_imgs
    return added_local, removed_local, added_ext, removed_ext


def main():
    repo, out = sys.argv[1], sys.argv[2]
    max_commits = int(sys.argv[3]) if len(sys.argv) > 3 else 400
    head = git(repo, "rev-parse", "HEAD").strip()
    shas = git(repo, "rev-list", "--first-parent", "--reverse", "HEAD").split()
    total = len(shas)
    if total > max_commits:
        step = total / max_commits
        idx = sorted({int(i * step) for i in range(max_commits)} | {total - 1})
        sampled = [shas[i] for i in idx]
    else:
        sampled = shas
    all_paths_ever = set(git(repo, "log", "--all", "--format=", "--name-only").split("\n"))
    commits = []
    prev_broken = set()
    t0 = time.time()
    for i, sha in enumerate(shas):
        meta = git(repo, "show", "-s", "--format=%an%x1f%ae%x1f%aI%x1f%s", sha).strip().split("\x1f")
        an, ae, date, subj = (meta + ["", "", "", ""])[:4]
        parents = git(repo, "rev-list", "--parents", "-n", "1", sha).split()[1:]
        base = parents[0] if parents else None
        if base:
            ns = git(repo, "diff", "--name-status", "-M", base, sha)
            diff = git(repo, "diff", "--unified=0", "--no-color", "-M", base, sha)
        else:
            ns = git(repo, "show", "--format=", "--name-status", sha)
            diff = git(repo, "show", "--format=", "--unified=0", "--no-color", sha)
        files = []
        for l in ns.splitlines():
            parts = l.split("\t")
            if len(parts) >= 2:
                files.append((parts[0], parts[1:]))
        img_changes = []
        renames = 0
        for status, paths in files:
            if status.startswith("R"):
                renames += 1
            for p in paths:
                if IMG_FILE.search(p):
                    size = None
                    if not status.startswith("D"):
                        target = paths[-1]
                        s = git(repo, "cat-file", "-s", f"{sha}:{target}").strip()
                        size = int(s) if s.isdigit() else None
                    img_changes.append({"status": status, "path": p, "bytes": size})
                    break
        a_loc, r_loc, a_ext, r_ext = classify_diff(diff)
        rec = {
            "sha": sha[:10],
            "author": an,
            "bot": bool(BOT.search(an) or BOT.search(ae)),
            "date": date,
            "subject": subj[:120],
            "files": len(files),
            "src_files": sum(1 for _, ps in files if SRC_FILE.search(ps[-1])),
            "img_changes": img_changes,
            "renames": renames,
            "added_local_img_refs": len(a_loc),
            "removed_local_img_refs": len(r_loc),
            "added_ext_img_urls": len(a_ext),
            "removed_ext_img_urls": len(r_ext),
            "added_ext_hosts": sorted({re.sub(r"^https?://([^/]+).*$", r"\1", u) for u in a_ext}),
        }
        if sha in sampled:
            subprocess.run(["git", "-C", repo, "checkout", "-q", "-f", sha], capture_output=True)
            subprocess.run(["git", "-C", repo, "clean", "-qfdx", "-e", ".upfly"], capture_output=True)
            chk = upfly_check(repo)
            if "broken" in chk:
                cur = set(tuple(x) for x in chk["broken"])
                new = sorted(cur - prev_broken)
                fixed = sorted(prev_broken - cur)
                rec["check_exit"] = chk["exit"]
                rec["broken_count"] = len(cur)
                rec["broken_new"] = [list(x) for x in new]
                rec["broken_fixed"] = len(fixed)
                prev_broken = cur
            else:
                rec["check_error"] = chk
        commits.append(rec)
    subprocess.run(["git", "-C", repo, "checkout", "-q", "-f", head], capture_output=True)
    final_broken = prev_broken
    # Did each introduced broken path ever exist in history (anywhere, matched by basename)?
    basenames_ever = {os.path.basename(p) for p in all_paths_ever if p}
    for c in commits:
        for b in c.get("broken_new", []):
            raw = b[1] or ""
            bn = os.path.basename(raw.split("?")[0].split("#")[0])
            b.append(bn in basenames_ever)
            b.append(tuple(b[:2]) in final_broken)
    json.dump(
        {
            "repo": repo,
            "head": head,
            "total_commits": total,
            "replayed": len(sampled),
            "seconds": round(time.time() - t0, 1),
            "final_broken": sorted(list(x) for x in final_broken),
            "commits": commits,
        },
        open(out, "w"),
        indent=1,
    )
    print(f"{repo}: {total} commits, replayed {len(sampled)}, {round(time.time() - t0, 1)} s")


if __name__ == "__main__":
    main()
