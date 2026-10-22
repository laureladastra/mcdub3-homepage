#!/usr/bin/env bash
# Stages the latest mcdub3-nx release into release/: the NRO of every edition in release/manifest.json and the
# settings template, and stamps the manifest with the release's version. GitHub's release downloads send no CORS
# headers, so the page cannot fetch them itself; they are served from this site instead.
# Used by the Pages workflow; run it locally (needs gh, jq, curl) before testing the page.
#
#   scripts/fetch-release.sh [tag]     (default: the latest release)
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=$(jq -r .repo release/manifest.json)
TAG=${1:-$(gh release view --repo "$REPO" --json tagName --jq .tagName)}
echo "mcdub3-nx $TAG from $REPO"

for nro in $(jq -r '.editions[].nro' release/manifest.json); do
  gh release download "$TAG" --repo "$REPO" --pattern "$nro" --dir release --clobber
done
for extra in $(jq -r '.extras[]?' release/manifest.json); do
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$TAG/switch/$extra" -o "release/$extra"
done

# The page accepts a disc when default.xbe matches the manifest; the game checks the same at boot against the
# lift's config/xbe_facts.h. Make sure both agree for the edition this release was lifted from.
facts=$(curl -fsSL "https://raw.githubusercontent.com/$REPO/$TAG/config/xbe_facts.h")
edition=$(sed -n 's/^#define MC3_EDITION *"\(.*\)"/\1/p' <<<"$facts")
size=$(sed -n 's/^#define MC3_XBE_SIZE *\([0-9]*\)u/\1/p' <<<"$facts")
fnv=$(sed -n 's/^#define MC3_XBE_FNV64 *0x\([0-9a-fA-F]*\)ull/\1/p' <<<"$facts" | tr A-F a-f)
jq -e --arg e "$edition" --argjson s "$size" --arg f "$fnv" \
  '.editions[] | select(.id == $e and .xbe_size == $s and .xbe_fnv64 == $f)' release/manifest.json >/dev/null \
  || { echo "release/manifest.json has no edition '$edition' with size $size and FNV $fnv (from $TAG's config/xbe_facts.h)"; exit 1; }

jq --arg v "${TAG#v}" '.version = $v' release/manifest.json > release/manifest.tmp && mv release/manifest.tmp release/manifest.json
ls -l release
