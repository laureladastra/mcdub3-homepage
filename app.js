import { gameFiles, identify, TITLE_ID } from './lib/game.js';

const $ = (id) => document.getElementById(id);
const create = $('create');
const status = $('status');
const logBox = $('log');

const manifest = fetch('release/manifest.json', { cache: 'no-cache' }).then((r) => r.json());
manifest.then((m) => {
  $('version').textContent = `v${m.version}`;
  $('releaseLink').href = `https://github.com/${m.repo}/releases/tag/v${m.version}`;
  // one line per game; an edition whose NRO is not in this release yet is still listed, with when it comes
  const games = new Map();
  for (const e of m.editions) {
    games.set(e.game, [...(games.get(e.game) ?? []), e]);
  }
  $('editionList').replaceChildren(...[...games].map(([game, editions]) => {
    const line = document.createElement('div');
    const names = editions.map((e) => (e.released ? e.name : `${e.name} (with the next release)`));
    line.textContent = `${game}: ${names.join(', ')}`;
    return line;
  }));
});

// mcdub3-nx-eur.nro -> mcdub3-nx-eur.zip
const zipName = (e) => (e ? e.nro.replace(/\.nro$/, '.zip') : 'the package');

let source = null;
let edition = null;
let check = 0;
let busy = false;

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function log(text, kind = '') {
  const line = document.createElement('div');
  line.textContent = text;
  line.className = kind;
  logBox.appendChild(line);
}

function showStatus(state, title, detail = '') {
  status.hidden = false;
  status.className = `status ${state}`;
  $('statusTitle').textContent = title;
  $('statusDetail').textContent = detail;
  $('cover').hidden = state !== 'good';
}

async function choose(newSource, label) {
  const id = ++check;
  source = newSource;
  edition = null;
  create.disabled = true;
  create.textContent = `Create ${zipName(null)}`;
  showStatus('', 'Checking…', label);
  try {
    const m = await manifest;
    const game = await identify(await gameFiles(newSource), m);
    if (id !== check) {
      return;
    }
    const summary = `${label} · ${game.count} files, ${formatSize(game.total)}`;
    if (game.info && game.info.titleId !== TITLE_ID) {
      showStatus('bad', 'This is not Midnight Club 3',
        `Its default.xbe is “${game.info.titleName || 'unknown'}” (title ID ${game.info.titleId.toUpperCase()}).`);
    } else if (game.edition && !game.edition.released) {
      showStatus('bad', `${game.edition.game}, ${game.edition.name}: not in this release yet`,
        `This disc is recognised, but release v${m.version} does not include ${game.edition.nro}. ` +
        'It will work here as soon as a release with that build is published.');
    } else if (!game.edition) {
      const supported = m.editions.filter((e) => e.released).map((e) => `${e.game} ${e.name}`).join(', ');
      showStatus('bad', 'This edition is not supported yet',
        `Its default.xbe (${game.size} bytes, FNV-1a ${game.hash}) is another edition or a modified file. ` +
        `Supported: ${supported}. Please open an issue with these numbers.`);
    } else if (game.missing.length) {
      showStatus('bad', 'The copy is incomplete', `Missing ${game.missing.join(', ')}. Choose the whole extracted disc.`);
    } else {
      edition = game.edition;
      $('cover').src = edition.cover;
      showStatus('good', `${edition.game}, ${edition.name}`,
        `${summary} · installs to sdmc:/${edition.install_dir}/${edition.game_dir}/, starts with ${edition.nro}` +
        (edition.note ? `. ${edition.note}` : ''));
      create.textContent = `Create ${zipName(edition)}`;
      create.disabled = busy;
    }
  } catch (error) {
    if (id === check) {
      showStatus('bad', 'Could not read this copy', error.message);
    }
  }
}

$('iso').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) {
    choose({ kind: 'iso', file }, file.name);
  }
});

$('folder').addEventListener('change', (event) => {
  const list = [...event.target.files];
  if (!list.length) {
    return;
  }
  // webkitRelativePath starts with the chosen folder's own name
  const top = list[0].webkitRelativePath.split('/')[0];
  const files = list.map((file) => ({ path: file.webkitRelativePath.slice(top.length + 1), file }));
  choose({ kind: 'folder', files }, `${top}/`);
});

// sw.js serves the zip as a download while worker.js generates it.
const helper = (async () => {
  if (!('serviceWorker' in navigator)) {
    throw new Error('This browser cannot stream downloads (no service workers; private windows in Firefox disable them). Try Chrome, Edge or a normal Firefox window.');
  }
  await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
  const registration = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    // the first visit, or a forced reload: the worker takes this page over
    const claimed = new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    registration.active.postMessage({ type: 'claim' });
    await claimed;
  }
  return navigator.serviceWorker.controller;
})();
helper.catch(() => {});

create.addEventListener('click', async () => {
  if (!source || !edition || busy) {
    return;
  }
  logBox.textContent = '';
  let controller;
  try {
    controller = await helper;
  } catch (error) {
    log(error.message, 'error');
    return;
  }
  // the edition at the click: choosing another copy during the download must not change this package
  const chosen = edition;
  busy = true;
  create.disabled = true;
  $('progress').hidden = false;
  $('fill').style.width = '0';
  $('progressText').textContent = '';

  const started = Date.now();
  const channel = new MessageChannel();
  const worker = new Worker('worker.js', { type: 'module' });
  const keepAlive = setInterval(() => controller.postMessage({ type: 'ping' }), 10000);
  const warnLeave = (event) => event.preventDefault();
  window.addEventListener('beforeunload', warnLeave);
  const finish = () => {
    busy = false;
    clearInterval(keepAlive);
    window.removeEventListener('beforeunload', warnLeave);
    worker.terminate();
    create.disabled = !edition;
  };

  worker.onmessage = async ({ data }) => {
    if (data.type === 'log') {
      log(data.text);
    } else if (data.type === 'size') {
      const id = crypto.randomUUID();
      const filename = zipName(chosen);
      const ready = new MessageChannel();
      const registered = new Promise((resolve) => (ready.port1.onmessage = resolve));
      controller.postMessage({ type: 'download', id, filename, size: data.size }, [channel.port2, ready.port2]);
      await registered;
      // a navigation always reaches the service worker (a plain <a download> may go straight to the network)
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.src = `download/${id}/${filename}`;
      document.body.appendChild(frame);
      log(`Saving ${filename} (${formatSize(data.size)}, ${data.count} files)…`);
    } else if (data.type === 'progress') {
      const fraction = data.sent / data.total;
      const seconds = (Date.now() - started) / 1000;
      $('fill').style.width = `${(fraction * 100).toFixed(1)}%`;
      $('progressText').textContent =
        `${formatSize(data.sent)} of ${formatSize(data.total)} · ${formatSize(data.sent / Math.max(seconds, 1))}/s`;
    } else if (data.type === 'done') {
      $('fill').style.width = '100%';
      log(`Done in ${Math.round((Date.now() - started) / 1000)} s. Continue with step 3 once the download has finished.`, 'ok');
      finish();
    } else if (data.type === 'error') {
      log(data.message, 'error');
      finish();
    }
  };
  worker.onerror = (event) => {
    log(event.message || 'The packager stopped unexpectedly.', 'error');
    finish();
  };

  const downloads = [
    { url: new URL(`release/${chosen.nro}`, location.href).href, path: `${chosen.install_dir}/${chosen.nro}` },
    // the one settings template, named after this game's app (scripts/fetch-release.sh)
    { url: new URL('release/settings.example.txt', location.href).href, path: `${chosen.install_dir}/${chosen.settings}` },
  ];
  const gameDir = `${chosen.install_dir}/${chosen.game_dir}`;
  worker.postMessage({ source, downloads, gameDir, port: channel.port1 }, [channel.port1]);
});
