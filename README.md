# mcdub3-nx installer

A static web page that builds the Nintendo Switch package of
[mcdub3-nx](https://github.com/laureladastra/mcdub3-nx) from the player's own copy of *Midnight Club 3: DUB Edition*.
The player picks a disc image (Redump or XISO) or an extracted folder, and the page:

1. reads the disc's file system in the browser (`lib/xdvdfs.js`, a port of the toolkit's `tools/xiso`);
2. checks `default.xbe` the way the game does at boot (size + FNV-1a 64, `lib/xbe.js`) against `release/manifest.json`;
3. streams a `mcdub3-nx.zip` to the downloads folder (`worker.js` + `lib/zip.js`, served by `sw.js`) holding

   ```
   switch/mcdub3-nx/mcdub3-nx-usa.nro
   switch/mcdub3-nx/mcdub3_env.example.txt
   switch/mcdub3-nx/game/…            (the disc)
   ```

Nothing is uploaded. No build step and no dependencies: plain HTML, CSS and ES modules.

## Run it locally

```sh
scripts/fetch-release.sh        # stages the latest release's NRO into release/ (needs gh, jq)
python3 -m http.server 8000     # then open http://localhost:8000
```

Service workers need `localhost` or HTTPS, so opening `index.html` as a file does not work.

## Deploying

`.github/workflows/pages.yml` publishes the site on GitHub Pages (Settings > Pages > Source: **GitHub Actions**). It
runs on every push to `main`, daily, by hand, and on a `mcdub3-release` repository dispatch. Each run copies the
latest release's NRO into `release/`, because GitHub's release downloads have no CORS headers and the page can't
fetch them itself.

To redeploy right after a release, the game's release workflow can send the dispatch (with a token that can write to
this repository):

```sh
gh api repos/<owner>/<this-repo>/dispatches -f event_type=mcdub3-release
```

## A new edition

Add it to `editions` in `release/manifest.json`: its `id` (MC3_EDITION), `xbe_size` and `xbe_fnv64` from that lift's
`config/xbe_facts.h`, and the NRO's file name. `scripts/fetch-release.sh` refuses to deploy when the manifest
doesn't match the release's `xbe_facts.h`.

## Artwork

`assets/background.jpg` is the source of `img/background.webp`, cropped below the artwork's own logo:

```sh
magick assets/background.jpg -crop 1200x655+0+305 +repage png:- | cwebp -q 82 -o img/background.webp -- -
```
