// XDVDFS (Xbox DVD File System) reader over a Blob/File, for a plain XISO or a full Redump dump. A port of
// mcdub3-nx's xboxrecomp/tools/xiso/xdvdfs.py: same partition bases, same linear directory walk. Only the
// directory tables are read up front; file data is read in slices while the package is written.

const SECTOR = 2048;
const MAGIC = 'MICROSOFT*XBOX*MEDIA';

// 0x00000000 bare game partition (XISO), 0x18300000 Redump (behind the DVD-video partition), others seen in the wild.
const BASES = [0x00000000, 0x0000fd90, 0x00030600, 0x0fd90000, 0x18300000];

async function read(blob, offset, length) {
  return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

async function findBase(blob) {
  for (const base of BASES) {
    const at = base + 32 * SECTOR;
    if (at + SECTOR <= blob.size) {
      const desc = await read(blob, at, SECTOR);
      if (ascii(desc, 0, MAGIC.length) === MAGIC) {
        const view = new DataView(desc.buffer);
        return { base, rootSector: view.getUint32(0x14, true), rootSize: view.getUint32(0x18, true) };
      }
    }
  }
  throw new Error('This is not an Xbox disc image (no XDVDFS file system found).');
}

// Entries form a binary tree but are also packed in order inside each sector, so a linear walk with a resync
// at every sector reads them all, even when a tree link is broken.
function parseDirectory(table) {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const entries = [];
  for (let start = 0; start < table.length; start += SECTOR) {
    const end = Math.min(start + SECTOR, table.length);
    let off = start;
    while (off + 14 <= end) {
      const left = view.getUint16(off, true);
      const right = view.getUint16(off + 2, true);
      const length = table[off + 13];
      if ((left === 0xffff && right === 0xffff) || length === 0 || off + 14 + length > end) {
        break;
      }
      entries.push({
        sector: view.getUint32(off + 4, true),
        size: view.getUint32(off + 8, true),
        directory: (table[off + 12] & 0x10) !== 0,
        name: ascii(table, off + 14, length),
      });
      off += (14 + length + 3) & ~3;
    }
  }
  return entries;
}

// Every file of the image: [{ path, size, offset }], offset in bytes from the start of the image.
export async function listIso(blob) {
  const { base, rootSector, rootSize } = await findBase(blob);
  const files = [];
  const walk = async (sector, size, prefix, depth) => {
    if (depth > 32 || size === 0) {
      return;
    }
    const offset = base + sector * SECTOR;
    if (offset + size > blob.size) {
      throw new Error('The disc image is truncated (a directory lies past its end).');
    }
    for (const e of parseDirectory(await read(blob, offset, size))) {
      const path = prefix + e.name;
      if (e.directory) {
        await walk(e.sector, e.size, path + '/', depth + 1);
      } else {
        const at = base + e.sector * SECTOR;
        if (at + e.size > blob.size) {
          throw new Error(`The disc image is truncated (${path} lies past its end).`);
        }
        files.push({ path, size: e.size, offset: at });
      }
    }
  };
  await walk(rootSector, rootSize, '', 0);
  return files;
}
