#!/usr/bin/env python3
"""Aggregate analyze_history.py results; run `upfly audit --json` at each repository's HEAD."""
import json
import os
import re
import subprocess
import sys
from collections import Counter

SP = "/tmp/claude-0/-home-user-upfly/cbf25f28-394c-59c0-8dce-3231dc847520/scratchpad"
UPFLY = "/home/user/upfly/packages/cli/dist/bin.js"
URL = re.compile(r"https?://[^\s\"'`)<>\]]+", re.I)
IMG_HOSTS = re.compile(
    r"(images\.unsplash\.com|source\.unsplash\.com|plus\.unsplash\.com|picsum\.photos|placehold|placeholder\.com|"
    r"images\.pexels\.com|randomuser\.me|pravatar|dummyimage|loremflickr|ui-avatars|dicebear)",
    re.I,
)
SRC = re.compile(r"\.(html?|css|scss|less|jsx?|tsx?|astro|vue|svelte|mdx?|json)$", re.I)


def audit_head(repo):
    r = subprocess.run(["node", UPFLY, "audit", "--json"], cwd=repo, capture_output=True, text=True, timeout=900)
    res = None
    for l in r.stdout.splitlines():
        try:
            o = json.loads(l)
        except Exception:
            continue
        if o.get("type") == "result":
            res = o
    if not res or "report" not in res:
        return {"error": f"exit {r.returncode}"}
    rep = res["report"]
    f = rep.get("findings", [])
    kinds = Counter(x.get("kind") for x in f)
    oversized = [x for x in f if x.get("kind") == "oversized"]
    summ = rep.get("summary", {})
    sav = res.get("savings") or {}
    return {
        "summary": summ,
        "kinds": dict(kinds),
        "oversized_max_bytes": max([x.get("bytes", 0) for x in oversized], default=0),
        "savings": sav,
    }


def external_images_head(repo):
    files = subprocess.run(["git", "-C", repo, "ls-files"], capture_output=True, text=True).stdout.split("\n")
    hosts = Counter()
    nfiles = 0
    for p in files:
        if not SRC.search(p) or "lock" in p:
            continue
        try:
            t = open(os.path.join(repo, p), encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        hit = False
        for u in URL.findall(t):
            m = IMG_HOSTS.search(u)
            if m:
                hosts[m.group(1).lower()] += 1
                hit = True
        nfiles += hit
    return {"stock_image_urls": sum(hosts.values()), "files": nfiles, "hosts": dict(hosts)}


def main():
    strata = {}
    for line in open(f"{SP}/sample.txt"):
        parts = line.split()
        if len(parts) == 2:
            strata[parts[1].replace("/", "__")] = parts[0]
    strata.setdefault("withkynam__duma", "A")
    rows = []
    for name, stratum in strata.items():
        path = f"{SP}/results/{name}.json"
        if not os.path.exists(path):
            continue
        d = json.load(open(path))
        repo = d["repo"]
        cs = d["commits"]
        bot = [c for c in cs if c["bot"]]
        # The first commit is the platform's template; count edits after it.
        edits = [c for c in bot if not c["subject"].startswith("[skip lovable]")][1:] if bot else []
        def share(pred, pool):
            n = sum(1 for c in pool if pred(c))
            return n, len(pool)
        img_touch = share(lambda c: len(c["img_changes"]) > 0, edits)
        img_added = share(lambda c: any(x["status"].startswith("A") for x in c["img_changes"]), edits)
        ref_local = share(lambda c: c["added_local_img_refs"] > 0, edits)
        ref_ext = share(lambda c: c["added_ext_img_urls"] > 0, edits)
        renames = share(lambda c: c["renames"] > 0, edits)
        any_img_work = share(
            lambda c: len(c["img_changes"]) > 0 or c["added_local_img_refs"] > 0 or c["removed_local_img_refs"] > 0,
            edits,
        )
        intro = [c for c in cs if c.get("broken_new")]
        intro_bot = [c for c in intro if c["bot"]]
        events = [(c["sha"], b) for c in intro for b in c["broken_new"]]
        never_existed = sum(1 for _, b in events if len(b) > 2 and not b[2])
        survived = sum(1 for _, b in events if len(b) > 3 and b[3])
        errors = Counter(str(c.get("check_error", {}).get("error")) for c in cs if c.get("check_error"))
        added_sizes = [x["bytes"] for c in edits for x in c["img_changes"] if x["status"].startswith("A") and x["bytes"]]
        head = audit_head(repo)
        ext = external_images_head(repo)
        dates = [c["date"][:10] for c in cs]
        rows.append(
            {
                "repo": name,
                "stratum": stratum,
                "commits": d["total_commits"],
                "replayed": d["replayed"],
                "bot_commits": len(bot),
                "edits": len(edits),
                "first": min(dates) if dates else None,
                "last": max(dates) if dates else None,
                "img_touch": img_touch,
                "img_added": img_added,
                "ref_local": ref_local,
                "ref_ext": ref_ext,
                "renames": renames,
                "any_img_work": any_img_work,
                "broken_intro_commits": len(intro),
                "broken_intro_bot_commits": len(intro_bot),
                "broken_events": len(events),
                "broken_never_existed": never_existed,
                "broken_survived_to_head": survived,
                "final_broken": len(d["final_broken"]),
                "check_errors": dict(errors),
                "added_img_bytes": sorted(added_sizes, reverse=True)[:10],
                "added_img_over_500k": sum(1 for s in added_sizes if s > 500_000),
                "added_img_count": len(added_sizes),
                "head_audit": head,
                "head_external": ext,
                "events": events[:20],
            }
        )
    json.dump(rows, open(f"{SP}/results/_aggregate.json", "w"), indent=1)
    for r in rows:
        print(
            r["stratum"], r["repo"][:40].ljust(40), r["first"], r["last"], "commits", r["commits"], "edits", r["edits"],
            "img", r["img_touch"], "refL", r["ref_local"], "refX", r["ref_ext"], "ren", r["renames"],
            "brokenIntro", r["broken_intro_commits"], "ev", r["broken_events"], "never", r["broken_never_existed"],
            "surv", r["broken_survived_to_head"], "final", r["final_broken"], "err", r["check_errors"],
            "added>500k", r["added_img_over_500k"], "/", r["added_img_count"], "stock", r["head_external"]["stock_image_urls"],
        )


if __name__ == "__main__":
    main()
