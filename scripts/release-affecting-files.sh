# shellcheck shell=bash
# Single source of truth for "files baked into the compiled binary" — the set
# a PR must bump the version for, and the set the missed-release backstop
# diffs for. Sourced by scripts/check-version-guard.sh and by the
# missed-release step in .github/workflows/release.yml.
#
# release.yml's push trigger deliberately has NO paths filter: GitHub requires
# literal globs there that can't be sourced from here, and a filter narrower
# than this list would silently skip the release workflow entirely. Running on
# every push and no-op'ing via the release-existence gate is the cheaper
# invariant to keep correct.
RELEASE_AFFECTING_ERE='^(src/|build\.ts$|package\.json$|pnpm-lock\.yaml$|tsconfig\.json$|tsconfig\.base\.json$)'
