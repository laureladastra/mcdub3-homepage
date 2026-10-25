#!/usr/bin/env bash
# Stages the latest mcdub3-nx release into release/: the NRO of every edition in release/editions.json (DUB Edition
# and DUB Edition Remix) and the settings template, and writes release/manifest.json, which the page reads: every
# edition, marked "released" when the release has its NRO, and the release's version. GitHub's release downloads send
# no CORS headers, so the page cannot fetch them itself; they are served from this site instead.
# Used by the Pages workflow; run it locally (needs gh, jq, curl) before testing the page.
#
#   scripts/fetch-release.sh [tag]     (default: the latest release)
set -euo pipefail
cd "$(dirname "$0")/.."

cp release/editions.json release/manifest.json
REPO=$(jq -r .repo release/manifest.json)
TAG=${1:-$(gh release view --repo "$REPO" --json tagName --jq .tagName)}
RAW="https://raw.githubusercontent.com/$REPO/$TAG"
echo "mcdub3-nx $TAG from $REPO"

# The page packages only released editions, and recognises the others' discs to say their build is still to come
# (instead of calling them unknown).
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

# One template for every game; each package names it after its app (mcdub3remix_env.example.txt, ...).
template=$(jq -r .settings_template release/manifest.json)
curl -fsSL "$RAW/$template" -o release/settings.example.txt \
  || { echo "$TAG has no $template"; exit 1; }

# The page accepts a disc when default.xbe matches the manifest; the game checks the same at boot. Make sure both
# agree, for the released editions only (an older release cannot know a newer edition). Each edition names where
# mcdub3-nx lists its XBEs, newest layout first: config/<game>/xbe_editions.h since v0.3.0, config/xbe_editions.h
# for v0.2.0, config/xbe_facts.h (the lifted disc alone) before that. The first one the tag has is used.
accepted() {  # <path>: "<name> <fnv>" lines of the XBEs that list accepts, nothing if the tag lacks it
  local text
  text=$(curl -fsSL "$RAW/$1" 2>/dev/null) || return 0
  case "$1" in
    *xbe_facts.h)
      echo "$(sed -n 's/^#define MC3_EDITION *"\(.*\)"/\1/p' <<<"$text")" \
        "$(sed -n 's/^#define MC3_XBE_FNV64 *0x\([0-9a-fA-F]*\)ull/\1/p' <<<"$text" | tr A-F a-f)" ;;
    *) sed -n 's/.*X("\([a-z-]*\)", *0x\([0-9a-fA-F]*\)ull.*/\1 \2/p' <<<"$text" | tr A-F a-f ;;
  esac
}
while read -r id xbe_id fnv lists; do
  known=
  for list in $lists; do
    known=$(accepted "$list")
    [ -n "$known" ] && break
  done
  [ -n "$known" ] || { echo "$TAG has none of $lists: where did $id's edition list go?"; exit 1; }
  grep -qx "$xbe_id $fnv" <<<"$known" \
    || { echo "release/editions.json: $id (FNV $fnv) is not one $TAG's game accepts ($list):"; echo "$known"; exit 1; }
done < <(jq -r '.editions[] | select(.released) | "\(.id) \(.xbe_id) \(.xbe_fnv64) \(.xbe_lists | join(" "))"' \
  release/manifest.json)

jq --arg v "${TAG#v}" '.version = $v' release/manifest.json > release/manifest.tmp && mv release/manifest.tmp release/manifest.json
ls -l release
