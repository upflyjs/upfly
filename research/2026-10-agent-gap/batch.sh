#!/usr/bin/env bash
# Clone each repository (sequentially: the git proxy caps concurrent operations) and replay its history.
SP=/tmp/claude-0/-home-user-upfly/cbf25f28-394c-59c0-8dce-3231dc847520/scratchpad
cd "$SP/repos" || exit 1
while read -r stratum slug; do
  [ -z "$slug" ] && continue
  dir="${slug//\//__}"
  if [ ! -d "$dir/.git" ]; then
    GIT_LFS_SKIP_SMUDGE=1 timeout 600 git clone -q --no-tags "https://github.com/$slug" "$dir" >/dev/null 2>&1 \
      || { echo "$stratum $slug CLONE_FAILED"; rm -rf "$dir"; continue; }
  fi
  size=$(du -sm "$dir/.git" | cut -f1)
  if [ "$size" -gt 800 ]; then echo "$stratum $slug TOO_BIG ${size}MB"; continue; fi
  timeout 3600 python3 "$SP/analyze_history.py" "$SP/repos/$dir" "$SP/results/$dir.json" 400 >/dev/null 2>&1 \
    && echo "$stratum $slug OK ${size}MB" || echo "$stratum $slug ANALYZE_FAILED"
done < "$SP/sample.txt"
echo BATCH_DONE
