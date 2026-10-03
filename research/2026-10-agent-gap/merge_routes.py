#!/usr/bin/env python3
"""Merge the parallel route-history outputs into _routes_history_all.json, dropping link targets that name a file
(an extension in the last segment), which are assets rather than page routes."""
import glob
import json
import re

SP = "/tmp/claude-0/-home-user-upfly/cbf25f28-394c-59c0-8dce-3231dc847520/scratchpad"
EXT = re.compile(r"\.[A-Za-z0-9]{1,12}$")


def is_asset(target):
    return bool(EXT.search(target.split("?")[0].split("#")[0]))


merged = []
for f in sorted(glob.glob(f"{SP}/results/_rh_*.json")):
    for r in json.load(open(f)):
        r["introduced"] = [i for i in r["introduced"] if not (i["kind"] == "L" and is_asset(i["target"]))]
        r["final_broken"] = [x for x in r["final_broken"] if not (x[0] == "L" and is_asset(x[2]))]
        bot_shas = {i["sha"] for i in r["introduced"] if i["bot"]}
        hum_shas = {i["sha"] for i in r["introduced"] if not i["bot"]}
        r["bot_commits_introducing"] = len(bot_shas)
        r["human_commits_introducing"] = len(hum_shas)
        merged.append(r)
json.dump(merged, open(f"{SP}/results/_routes_history_all.json", "w"), indent=1)
print(len(merged), "repos merged")
