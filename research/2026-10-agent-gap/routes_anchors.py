#!/usr/bin/env python3
"""Heuristic measurement (not product code) of in-app links that name no route, and #anchors that
name no id, in React Router projects (Lovable's stack). Prints each finding for hand-checking.

Usage: routes_anchors.py <repo_dir> [<repo_dir> ...]  -> JSON on stdout
"""
import json
import os
import re
import subprocess
import sys

SRC = re.compile(r"\.(jsx?|tsx?|html)$", re.I)
ROUTE_JSX = re.compile(r"<Route\b[^>]*?\bpath\s*=\s*[{]?\s*[\"'`]([^\"'`]+)[\"'`]", re.S)
ROUTE_OBJ = re.compile(r"\bpath\s*:\s*[\"'`]([^\"'`]+)[\"'`]")
LINK_TO = re.compile(r"\b(?:to|href)\s*=\s*[{]?\s*[\"'`](/[^\"'`\s]*)[\"'`]")
NAVIGATE = re.compile(r"\bnavigate\(\s*[\"'`](/[^\"'`\s]*)[\"'`]")
HASH_LINK = re.compile(r"\b(?:to|href)\s*=\s*[{]?\s*[\"'`]/?#([A-Za-z][\w-]*)[\"'`]")
ID_ATTR = re.compile(r"\bid\s*=\s*[{]?\s*[\"'`]([A-Za-z][\w-]*)[\"'`]")
GET_BY_ID = re.compile(r"getElementById\(\s*[\"'`]([A-Za-z][\w-]*)[\"'`]")
INDEX_ROUTE = re.compile(r"<Route\b[^>]*?\bindex\b")
GENERATED_ROUTE = re.compile(r"\bpath\s*=\s*\{\s*[\w.]+\s*\}")
TO_KEY = re.compile(r"\b(?:to|path|href|url)\s*:\s*[\"'`](/[^\"'`\s]*)[\"'`]")
# A path whose last segment has a file extension names a file (an asset), not a page route.
ASSET_EXT = re.compile(r"\.[A-Za-z0-9]{1,12}$")


def files(repo):
    out = subprocess.run(["git", "-C", repo, "ls-files"], capture_output=True, text=True).stdout.split("\n")
    return [p for p in out if SRC.search(p) and "node_modules" not in p and not p.startswith("public/")]


def route_regex(path):
    if path in ("*", "/*"):
        return None
    p = "/" + path.strip("/")
    parts = []
    for seg in p.split("/")[1:]:
        if seg == "*":
            parts.append(".*")
        elif seg.startswith(":"):
            parts.append("[^/]+" + ("?" if seg.endswith("?") else ""))
        else:
            parts.append(re.escape(seg))
    return re.compile("^/" + "/".join(parts) + "/?$")


NEXT_PAGE = re.compile(r"^(?:src/)?app/(.*/)?page\.(?:jsx?|tsx?|mdx?)$")
NEXT_PAGES_DIR = re.compile(r"^(?:src/)?pages/(.+)\.(?:jsx?|tsx?|mdx?)$")


def next_routes(repo, all_files):
    """Routes of a Next.js project, from its app/ folders and pages/ files."""
    out = []
    for p in all_files:
        m = NEXT_PAGE.match(p)
        if m:
            segs = [s for s in (m.group(1) or "").strip("/").split("/") if s and not (s.startswith("(") and s.endswith(")"))]
            segs = ["*" if s.startswith("[...") or s.startswith("[[...") else (":" + s[1:-1] if s.startswith("[") else s) for s in segs]
            out.append("/" + "/".join(segs))
            continue
        m = NEXT_PAGES_DIR.match(p)
        if m and not m.group(1).startswith(("_", "api/")):
            segs = [s for s in m.group(1).split("/") if s != "index"]
            segs = ["*" if s.startswith("[...") else (":" + s[1:-1] if s.startswith("[") else s) for s in segs]
            out.append("/" + "/".join(segs))
    return out


def analyze(repo):
    routes, links, hashes, ids = [], [], [], set()
    all_files = subprocess.run(["git", "-C", repo, "ls-files"], capture_output=True, text=True).stdout.split("\n")
    pkg = ""
    try:
        pkg = open(os.path.join(repo, "package.json"), encoding="utf-8", errors="replace").read()
    except Exception:
        pass
    is_next = '"next"' in pkg
    typed = "@tanstack/react-router" in pkg or "@tanstack/react-start" in pkg or "@tanstack/start" in pkg
    if is_next:
        routes += next_routes(repo, all_files)
    generated = False
    list_targets = []
    for p in files(repo):
        try:
            t = open(os.path.join(repo, p), encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        for m in ROUTE_JSX.finditer(t):
            routes.append(m.group(1))
        if INDEX_ROUTE.search(t):
            routes.append("/")
        if "createBrowserRouter" in t or "useRoutes" in t or "routes" in p.lower():
            for m in ROUTE_OBJ.finditer(t):
                routes.append(m.group(1))
        if GENERATED_ROUTE.search(t):
            generated = True
        for m in TO_KEY.finditer(t):
            list_targets.append(m.group(1))
        for rx in (LINK_TO, NAVIGATE):
            for m in rx.finditer(t):
                line = t.count("\n", 0, m.start()) + 1
                links.append((p, line, m.group(1)))
        for m in HASH_LINK.finditer(t):
            line = t.count("\n", 0, m.start()) + 1
            hashes.append((p, line, m.group(1)))
        ids.update(m.group(1) for m in ID_ATTR.finditer(t))
        ids.update(m.group(1) for m in GET_BY_ID.finditer(t))
    # Routes generated from a list (<Route path={item.to}>): every literal `to:` or `path:` value counts as a route.
    if generated:
        routes += [x for x in list_targets if x.startswith("/")]
    # Relative child routes ("settings") are joined to every absolute route as a parent, generously.
    abs_routes = [r for r in routes if r.startswith("/") or r in ("*",)]
    rel_routes = [r for r in routes if not r.startswith("/") and r != "*"]
    compiled = [route_regex(r) for r in abs_routes]
    for parent in abs_routes:
        for child in rel_routes:
            compiled.append(route_regex(parent.rstrip("/") + "/" + child))
    compiled += [route_regex("/" + r) for r in rel_routes]
    compiled = [c for c in compiled if c]
    broken_links = []
    # No router found, or typed routing (the type checker owns those links): links are not judged.
    judge_links = bool(routes) and not typed
    for f, line, target in links if judge_links else []:
        path = target.split("?")[0].split("#")[0]
        if not path or ASSET_EXT.search(path) or path.startswith("/api") or path.startswith("//"):
            continue
        if not any(c.match(path) for c in compiled):
            broken_links.append([f, line, target])
    broken_hashes = [[f, line, h] for f, line, h in hashes if h not in ids]
    return {
        "repo": os.path.basename(repo),
        "typed_routing": typed,
        "next": is_next,
        "has_router": bool(routes),
        "routes": sorted(set(routes)),
        "links": len(links),
        "broken_links": broken_links,
        "hash_links": len(hashes),
        "broken_hashes": broken_hashes,
    }


if __name__ == "__main__":
    print(json.dumps([analyze(r) for r in sys.argv[1:]], indent=1))
