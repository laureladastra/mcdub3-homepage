// Builds the zip off the main thread: reads the game from the player's file, the NRO from this site, and hands
// the archive to sw.js one chunk per "pull" through a MessagePort, so memory stays flat however big the game is.

import { gameFiles, INSTALL_DIR } from './lib/game.js';
import { zipSize, zipStream } from './lib/zip.js';

function owned(chunk) {
  // a chunk can be transferred only if it is the whole of its buffer
  return chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength ? chunk : chunk.slice();
}

async function fetchFile(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Could not download ${url.split('/').pop()} from this site (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

self.onmessage = async ({ data: { source, downloads, gameDir, port } }) => {
  try {
    self.postMessage({ type: 'log', text: 'Downloading the Switch build…' });
    const entries = [];
    for (const { url, path } of downloads) {
      const bytes = await fetchFile(url);
      entries.push({ path: INSTALL_DIR + path, size: bytes.length, chunks: async function* () { yield bytes; } });
    }
    self.postMessage({ type: 'log', text: 'Reading the game files…' });
    for (const f of await gameFiles(source)) {
      entries.push({ path: `${INSTALL_DIR}${gameDir}/${f.path}`, size: f.size, chunks: f.chunks });
    }

    const total = zipSize(entries);
    self.postMessage({ type: 'size', size: total, count: entries.length });

    const stream = zipStream(entries);
    let sent = 0;
    port.onmessage = async ({ data }) => {
      if (data === 'cancel') {
        self.postMessage({ type: 'error', message: 'The download was cancelled.' });
        return;
      }
      try {
        const { value, done } = await stream.next();
        if (done) {
          port.postMessage({ done: true });
          self.postMessage({ type: 'done' });
          return;
        }
        const chunk = owned(value);
        sent += chunk.length;
        port.postMessage({ chunk }, [chunk.buffer]);
        self.postMessage({ type: 'progress', sent, total });
      } catch (error) {
        port.postMessage({ error: error.message });
        self.postMessage({ type: 'error', message: error.message });
      }
    };
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
