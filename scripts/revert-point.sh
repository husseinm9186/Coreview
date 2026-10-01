#!/bin/sh
# LT-602: a revert point before a push — every branch as a git bundle and
# the working tree as a tar (build outputs left out), under
# ~/coreview-backups, named by date and commit.
#
#   scripts/revert-point.sh
#
# Restore: `git clone ~/coreview-backups/<name>.bundle coreview` for the
# history, or untar <name>-worktree.tgz over a checkout for the files.
set -e
cd "$(dirname "$0")/.."
dir="${COREVIEW_BACKUPS:-$HOME/coreview-backups}"
mkdir -p "$dir"
name="coreview-$(date +%Y%m%d-%H%M)-$(git rev-parse --short HEAD)"
git bundle create "$dir/$name.bundle" --all
git bundle verify "$dir/$name.bundle" >/dev/null
tar --exclude=./target --exclude=./node_modules --exclude=./sidecar/.venv --exclude=./dist -czf "$dir/$name-worktree.tgz" .
echo "revert point: $dir/$name.bundle and $dir/$name-worktree.tgz"
