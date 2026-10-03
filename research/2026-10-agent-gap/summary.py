#!/usr/bin/env python3
"""Final numbers for the report: agent edits only (the platform's first, template commit excluded)."""
import glob
import json
import os
import re

SP = "/tmp/claude-0/-home-user-upfly/cbf25f28-394c-59c0-8dce-3231dc847520/scratchpad"
strata = {}
for line in open(f"{SP}/sample.txt"):
    p = line.split()
    if len(p) == 2:
        strata[p[1].replace("/", "__")] = p[0]
strata["withkynam__duma"] = "A"
routes = {r["repo"]: r for r in json.load(open(f"{SP}/results/_routes_history_all.json"))}
agg = {r["repo"]: r for r in json.load(open(f"{SP}/results/_aggregate.json"))}
TEMPLATE = re.compile(r"(\[skip lovable\]|\[skip gpt_engineer\]|\[skip gpt-engineer\]|^Use tech stack)", re.I)

out = {}
for s in ("A", "B", "all"):
    out[s] = {k: 0 for k in ("repos", "repos_with_edits", "edits", "img_file", "ref_local", "ref_stock", "any_img",
                             "renames", "brk_commits", "brk_never_existed", "brk_survive", "route_commits",
                             "route_links", "route_survive", "added", "added_500k", "added_1m")}
    out[s]["added_max"] = 0
for f in sorted(glob.glob(f"{SP}/results/*.json")):
    name = os.path.basename(f)[:-5]
    if name.startswith("_"):
        continue
    d = json.load(open(f))
    s = strata[name]
    bot = [c for c in d["commits"] if c["bot"]]
    template_shas = {c["sha"] for c in bot if TEMPLATE.search(c["subject"])}
    if bot and not template_shas:
        template_shas = {bot[0]["sha"]}
    edits = [c for c in bot if c["sha"] not in template_shas]
    edit_shas = {c["sha"] for c in edits}
    rt = routes.get(name, {"introduced": []})
    rintro = [i for i in rt["introduced"] if i["bot"] and i["sha"] in edit_shas]
    added = [x["bytes"] for c in edits for x in c["img_changes"] if x["status"].startswith("A") and x["bytes"]]
    vals = {
        "repos": 1,
        "repos_with_edits": 1 if edits else 0,
        "edits": len(edits),
        "img_file": sum(1 for c in edits if c["img_changes"]),
        "ref_local": sum(1 for c in edits if c["added_local_img_refs"] > 0),
        "ref_stock": sum(1 for c in edits if c["added_ext_img_urls"] > 0),
        "any_img": sum(1 for c in edits if c["img_changes"] or c["added_local_img_refs"] or c["removed_local_img_refs"]
                       or c["added_ext_img_urls"]),
        "renames": sum(1 for c in edits if c["renames"] > 0),
        "brk_commits": sum(1 for c in edits if c.get("broken_new")),
        "brk_never_existed": sum(1 for c in edits for b in c.get("broken_new", []) if len(b) > 2 and not b[2]),
        "brk_survive": sum(1 for c in edits for b in c.get("broken_new", []) if len(b) > 3 and b[3]),
        "route_commits": len({i["sha"] for i in rintro}),
        "route_links": len(rintro),
        "route_survive": sum(1 for i in rintro if i["survives"]),
        "added": len(added),
        "added_500k": sum(1 for b in added if b > 5e5),
        "added_1m": sum(1 for b in added if b > 1e6),
    }
    for key in (s, "all"):
        for k, v in vals.items():
            out[key][k] += v
        out[key]["added_max"] = max(out[key]["added_max"], max(added, default=0))

# At the last commit, all authors.
head = {"vite_svg_only": 0, "broken_img_projects": 0, "route_projects": 0, "stock_projects": 0, "stock_urls": 0,
        "oversized_projects": 0, "image_bytes": 0, "savings_bytes": 0}
for name, r in agg.items():
    fb = json.load(open(f"{SP}/results/{name}.json"))["final_broken"]
    real = [b for b in fb if b[1] != "/vite.svg"]
    if fb and not real:
        head["vite_svg_only"] += 1
    if real:
        head["broken_img_projects"] += 1
    if routes.get(name, {}).get("final_broken"):
        head["route_projects"] += 1
    if r["head_external"]["stock_image_urls"]:
        head["stock_projects"] += 1
        head["stock_urls"] += r["head_external"]["stock_image_urls"]
    h = r["head_audit"]
    if isinstance(h, dict) and "summary" in h:
        head["image_bytes"] += h["summary"].get("assetBytes", 0)
        head["savings_bytes"] += (h.get("savings") or {}).get("savedBytes", 0)
        if h["kinds"].get("oversized"):
            head["oversized_projects"] += 1
print(json.dumps(out, indent=1))
print(json.dumps(head, indent=1))
