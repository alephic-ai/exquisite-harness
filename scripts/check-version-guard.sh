#!/usr/bin/env bash
# Ported from alephic-intelligence-v2 scripts/check-cli-version-guard.sh,
# retargeted from packages/intelligence-cli to this single-package repo.
#
# Modes:
#   (default)   compare BASE_SHA...HEAD_SHA (CI sets both), else origin/main...HEAD
#   --staged    compare origin/main against the staged index (local pre-push use)
set -euo pipefail

pkg=package.json
base_ref="${VERSION_GUARD_BASE_REF:-origin/main}"

read_package_version() {
  git show "$1:$pkg" | node -e '
let data = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  data += chunk
})
process.stdin.on("end", () => {
  console.log(JSON.parse(data).version)
})
'
}

fail() {
  file="$1"
  message="$2"
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::error file=$file::$message"
  else
    echo "Error: $message" >&2
  fi
  exit 1
}

# Strictly-greater semver check for X.Y.Z: version_gt <base> <head> exits 0
# iff head > base. Written in node so local --staged runs don't need GNU
# sort's `sort -V` (absent on macOS).
version_gt() {
  node -e '
const parse = (v) => v.split(".").map((n) => parseInt(n, 10))
const [a, b] = process.argv.slice(1).map(parse)
for (let i = 0; i < 3; i++) {
  if ((b[i] || 0) > (a[i] || 0)) process.exit(0)
  if ((b[i] || 0) < (a[i] || 0)) process.exit(1)
}
process.exit(1)
' "$1" "$2"
}

if [ "${1:-}" = "--staged" ]; then
  change_base=$(git merge-base "$base_ref" HEAD)
  version_base="$base_ref"
  head=$(git write-tree)
elif [ -n "${BASE_SHA:-}" ] && [ -n "${HEAD_SHA:-}" ]; then
  change_base=$(git merge-base "$BASE_SHA" "$HEAD_SHA")
  version_base="$BASE_SHA"
  head="$HEAD_SHA"
else
  change_base=$(git merge-base "$base_ref" HEAD)
  version_base="$base_ref"
  head=HEAD
fi

# Files that get baked into the compiled binary. Keep in sync with the push
# paths filter in release.yml and the missed-release grep there. Docs,
# workflows, and lint/format config never enter the binary.
release_affecting='^(src/|build\.ts$|package\.json$|pnpm-lock\.yaml$|tsconfig\.json$|tsconfig\.base\.json$)'

changed=$(git diff --name-only "$change_base" "$head" \
  | grep -E "$release_affecting" || true)

if [ -z "$changed" ]; then
  echo "No release-affecting changes -- nothing to guard."
  exit 0
fi

base_ver=$(read_package_version "$version_base")
head_ver=$(read_package_version "$head")

if [ "$base_ver" = "$head_ver" ]; then
  printf '%s\n' "$changed" | sed 's/^/  - /'
  fail "$pkg" "Release-affecting files changed but version is still $head_ver. Bump \"version\" in $pkg so release.yml publishes a new eh-v<version> release."
fi

if ! version_gt "$base_ver" "$head_ver"; then
  fail "$pkg" "Version went backwards: $base_ver -> $head_ver. The new version must be greater."
fi

if ! command -v gh >/dev/null 2>&1; then
  fail "$pkg" "GitHub CLI 'gh' is required to check whether eh-v$head_ver already exists."
fi

if gh release view "eh-v$head_ver" >/dev/null 2>&1; then
  fail "$pkg" "eh-v$head_ver is already released, so merging this PR would no-op release.yml and ship nothing. Bump to a new, unreleased version."
fi

echo "Version bumped: $base_ver -> $head_ver (no existing eh-v$head_ver release)"
