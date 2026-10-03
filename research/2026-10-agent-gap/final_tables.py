#!/usr/bin/env python3
"""Markdown tables for the report from _aggregate.json and _routes_history_all.json."""
import json
import sys

SP = "/tmp/claude-0/-home-user-upfly/cbf25f28-394c-59c0-8dce-3231dc847520/scratchpad"
agg = {r["repo"]: r for r in json.load(open(f"{SP}/results/_aggregate.json"))}
routes = {r["repo"]: r for r in json.load(open(f"{SP}/results/_routes_history_all.json"))}


def pct(k, n):
    return f"{k} ({100 * k / n:.1f}%)" if n else "0"


def mb(b):
    return f"{b / 1e6:.1f} MB"


tot = {"edits": 0, "img": 0, "refL": 0, "refX": 0, "ren": 0, "brk": 0, "route_commits": 0, "route_intro_bot": 0,
       "route_surv_bot": 0, "added": 0, "added1m": 0, "repos_route_head": 0, "repos": 0}
for stratum in ("A", "B"):
    print(f"\n### Stratum {stratum}\n")
    print("| project | period | commits | agent edits | edits touching an image file | edits adding a local image path | "
          "edits adding a stock-photo URL | edits introducing a broken image path | edits introducing a link to a missing route or anchor (still broken at the end) | images the agent added (over 1 MB) |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for name, r in sorted(agg.items(), key=lambda kv: -kv[1]["edits"]):
        if r["stratum"] != stratum:
            continue
        rt = routes.get(name, {})
        bot_intro = [i for i in rt.get("introduced", []) if i["bot"]]
        bot_intro_commits = len({i["sha"] for i in bot_intro})
        bot_surv = sum(1 for i in bot_intro if i["survives"])
        brk_bot = 0
        d = json.load(open(f"{SP}/results/{name}.json"))
        brk_bot = sum(1 for c in d["commits"] if c["bot"] and c.get("broken_new"))
        e = r["edits"]
        print(f"| {name.replace('__', '/')} | {r['first']} to {r['last']} | {r['commits']} | {e} | {pct(r['img_touch'][0], e)} | "
              f"{pct(r['ref_local'][0], e)} | {pct(r['ref_ext'][0], e)} | {brk_bot} | {bot_intro_commits} ({bot_surv}) | "
              f"{r['added_img_count']} ({sum(1 for b in r['added_img_bytes'] if b > 1e6)}) |")
        tot["repos"] += 1
        tot["edits"] += e
        tot["img"] += r["img_touch"][0]
        tot["refL"] += r["ref_local"][0]
        tot["refX"] += r["ref_ext"][0]
        tot["ren"] += r["renames"][0]
        tot["brk"] += brk_bot
        tot["route_intro_bot"] += bot_intro_commits
        tot["route_surv_bot"] += bot_surv
        tot["added"] += r["added_img_count"]
print("\nTOTALS", json.dumps(tot))

print("\n### At the last commit (all projects)\n")
print("| project | images | total size | Upfly savings as WebP | oversized | broken image paths | links to a missing route or anchor | stock-photo URLs |")
print("|---|---|---|---|---|---|---|---|")
for name, r in sorted(agg.items()):
    h = r["head_audit"]
    s = h.get("summary", {}) if isinstance(h, dict) else {}
    sav = h.get("savings", {}) if isinstance(h, dict) else {}
    kinds = h.get("kinds", {}) if isinstance(h, dict) else {}
    rt = routes.get(name, {})
    if not s:
        print(f"| {name.replace('__', '/')} | audit did not run: {json.dumps(h)[:60]} | | | | | | |")
        continue
    print(f"| {name.replace('__', '/')} | {s.get('assets')} | {mb(s.get('assetBytes', 0))} | "
          f"{mb(sav.get('savedBytes', 0))} across {sav.get('images', 0)} | {kinds.get('oversized', 0)} | {r['final_broken']} | "
          f"{len(rt.get('final_broken', []))} | {r['head_external']['stock_image_urls']} |")
