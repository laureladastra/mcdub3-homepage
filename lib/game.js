// The player's copy of the game, from a disc image or an extracted folder, as one list of files, and which edition
// it is. Used by the page (to identify the copy) and by worker.js (to package it).

import { listIso } from './xdvdfs.js';
import { fnv1a64, xbeInfo } from './xbe.js';

export const TITLE_ID = '54540079';
// Files the game needs besides default.xbe: a folder without them is not the whole disc.
const REQUIRED = ['assets_x.dat', 'banks.dat'];
// Clutter an operating system leaves in a folder, and what mcdub3-nx writes beside an extracted disc on a computer:
// saves (UDATA), title data and cache drive (TDATA, CACHE), the lift's default_analysis.json. None is on the disc.
const JUNK = /(^|\/)(\.DS_Store|\._[^/]*|Thumbs\.db|desktop\.ini)$|^(UDATA|TDATA|CACHE)\/|^[^/]*_analysis\.json$/i;
const CHUNK = 4 << 20;

function sliceReader(blob, start, size) {
  return {
    read: async (offset, length) => new Uint8Array(await blob.slice(start + offset, start + offset + length).arrayBuffer()),
    async *chunks() {
      for (let at = 0; at < size; at += CHUNK) {
        yield new Uint8Array(await blob.slice(start + at, start + Math.min(at + CHUNK, size)).arrayBuffer());
      }
    },
  };
}

// source: { kind: 'iso', file } or { kind: 'folder', files: [{ path, file }] } (path relative to the chosen folder).
// Returns [{ path, size, read(offset, length), chunks() }], paths relative to the disc root.
export async function gameFiles(source) {
  if (source.kind === 'iso') {
    return (await listIso(source.file)).map((f) => ({ path: f.path, size: f.size, ...sliceReader(source.file, f.offset, f.size) }));
  }
  // the disc root is the folder holding default.xbe, wherever it is inside the chosen folder
  const xbes = source.files.filter((f) => /(^|\/)default\.xbe$/i.test(f.path));
  if (!xbes.length) {
    throw new Error('No default.xbe in this folder. Choose the folder with the extracted disc.');
  }
  const xbe = xbes.reduce((a, b) => (a.path.length <= b.path.length ? a : b));
  const root = xbe.path.slice(0, xbe.path.length - 'default.xbe'.length);
  return source.files
    .filter((f) => f.path.startsWith(root) && !JUNK.test(f.path.slice(root.length)))
    .map((f) => ({ path: f.path.slice(root.length), size: f.file.size, ...sliceReader(f.file, 0, f.file.size) }));
}

// { edition, info, hash, size, total, count, missing }: edition is the manifest's entry when default.xbe matches a
// build (the same size + FNV-1a 64 check the game makes at boot), null otherwise.
export async function identify(files, manifest) {
  const find = (name) => files.find((f) => f.path.toLowerCase() === name);
  const xbe = find('default.xbe');
  if (!xbe) {
    throw new Error('This copy has no default.xbe at its root.');
  }
  const bytes = await xbe.read(0, xbe.size);
  const hash = fnv1a64(bytes);
  const edition = manifest.editions.find((e) => e.xbe_size === xbe.size && e.xbe_fnv64 === hash) ?? null;
  return {
    edition,
    info: xbeInfo(bytes),
    hash,
    size: xbe.size,
    total: files.reduce((sum, f) => sum + f.size, 0),
    count: files.length,
    missing: REQUIRED.filter((name) => !find(name)),
  };
}
