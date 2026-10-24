#!/usr/bin/env bash
# Stages the latest mcdub3-nx release into release/: the NRO of every edition in release/editions.json and the
# settings template, and writes release/manifest.json, which the page reads: those editions that the release has an
# NRO for, and the release's version. GitHub's release downloads send no CORS
# headers, so the page cannot fetch them itself; they are served from this site instead.
# Used by the Pages workflow; run it locally (needs gh, jq, curl) before testing the page.
#
#   scripts/fetch-release.sh [tag]     (default: the latest release)
set -euo pipefail
cd "$(dirname "$0")/.."

cp release/editions.json release/manifest.json
REPO=$(jq -r .repo release/manifest.json)
TAG=${1:-$(gh release view --repo "$REPO" --json tagName --jq .tagName)}
echo "mcdub3-nx $TAG from $REPO"

# Every edition stays in the manifest, marked "released" when this release has its NRO: the page packages only those,
# and recognises the others' discs to say their build is still to come (instead of calling them unknown).
assets=$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name')
keep=()
for nro in $(jq -r '.editions[].nro' release/manifest.json); do
  if grep -qx "$nro" <<<"$assets"; then
    gh release download "$TAG" --repo "$REPO" --pattern "$nro" --dir release --clobber
    keep+=("$nro")
  else
    echo "warning: $TAG has no $nro: the page will recognise that edition but not package it"
  fi
done
[ ${#keep[@]} -gt 0 ] || { echo "$TAG has none of the manifest's NROs"; exit 1; }
jq --arg keep "${keep[*]}" '.editions |= map(.released = (.nro as $n | $keep | split(" ") | index($n) != null))' \
  release/manifest.json > release/manifest.tmp && mv release/manifest.tmp release/manifest.json

for extra in $(jq -r '.extras[]?' release/manifest.json); do
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$TAG/switch/$extra" -o "release/$extra"
done

# The page accepts a disc when default.xbe matches the manifest; the game checks the same at boot. Make sure both
# agree: config/xbe_editions.h lists every accepted XBE since the European edition, config/xbe_facts.h the lifted
# one before it. Only for the released editions: an older release cannot know a newer edition.
raw="https://raw.githubusercontent.com/$REPO/$TAG/config"
if editions=$(curl -fsSL "$raw/xbe_editions.h" 2>/dev/null); then
  known=$(sed -n 's/.*X("\([a-z-]*\)", *0x\([0-9a-fA-F]*\)ull.*/\1 \2/p' <<<"$editions" | tr A-F a-f)
else
  facts=$(curl -fsSL "$raw/xbe_facts.h")
  known="$(sed -n 's/^#define MC3_EDITION *"\(.*\)"/\1/p' <<<"$facts") $(sed -n 's/^#define MC3_XBE_FNV64 *0x\([0-9a-fA-F]*\)ull/\1/p' <<<"$facts" | tr A-F a-f)"
fi
while read -r id fnv; do
  grep -qx "$id $fnv" <<<"$known" \
    || { echo "release/editions.json: edition $id (FNV $fnv) is not one $TAG's game accepts:"; echo "$known"; exit 1; }
done < <(jq -r '.editions[] | select(.released) | "\(.id) \(.xbe_fnv64)"' release/manifest.json)

jq --arg v "${TAG#v}" '.version = $v' release/manifest.json > release/manifest.tmp && mv release/manifest.tmp release/manifest.json
ls -l release
