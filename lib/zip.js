// Streaming ZIP writer: stored (no compression), CRC-32 computed while the data passes through, sizes and CRC in a
// data descriptor after each file. Every file must be under 4 GB (FAT32 has the same limit); ZIP64 records are
// added only when the archive itself passes 4 GB.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256 * 8);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  for (let i = 0; i < 256; i++) {
    for (let s = 1; s < 8; s++) {
      t[s * 256 + i] = (t[(s - 1) * 256 + i] >>> 8) ^ t[t[(s - 1) * 256 + i] & 0xff];
    }
  }
  return t;
})();

// Slicing-by-8 CRC-32: fast enough to keep up with an SSD.
export function crc32(crc, data) {
  const t = CRC_TABLE;
  let c = ~crc >>> 0;
  let i = 0;
  const n = data.length;
  for (; i + 8 <= n; i += 8) {
    c ^= data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    c = t[1792 + (c & 0xff)] ^ t[1536 + ((c >>> 8) & 0xff)] ^ t[1280 + ((c >>> 16) & 0xff)] ^ t[1024 + (c >>> 24)] ^
      t[768 + data[i + 4]] ^ t[512 + data[i + 5]] ^ t[256 + data[i + 6]] ^ t[data[i + 7]];
  }
  for (; i < n; i++) {
    c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

const U32 = 0xffffffff;
const encoder = new TextEncoder();

function plan(entries) {
  let offset = 0;
  let central = 0;
  const offsets = [];
  for (const e of entries) {
    const name = encoder.encode(e.path).length;
    offsets.push(offset);
    central += 46 + name + (offset >= U32 ? 12 : 0);
    offset += 30 + name + e.size + 16;
  }
  const zip64 = offset + central >= U32 || entries.length >= 0xffff;
  return { offsets, centralStart: offset, central, zip64, total: offset + central + (zip64 ? 56 + 20 : 0) + 22 };
}

// Exact size of the archive zipStream produces for these entries ([{ path, size }]).
export function zipSize(entries) {
  return plan(entries).total;
}

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function setU64(view, at, value) {
  view.setUint32(at, value % 0x100000000, true);
  view.setUint32(at + 4, Math.floor(value / 0x100000000), true);
}

// Yields the archive as Uint8Array chunks. entries: [{ path, size, chunks: () => AsyncIterable<Uint8Array> }].
export async function* zipStream(entries) {
  const { offsets, centralStart, central, zip64 } = plan(entries);
  const { time, day } = dosDateTime(new Date());
  const crcs = [];

  for (const e of entries) {
    const name = encoder.encode(e.path);
    const head = new Uint8Array(30 + name.length);
    const h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0808, true); // data descriptor follows, UTF-8 names
    h.setUint16(10, time, true);
    h.setUint16(12, day, true);
    h.setUint16(26, name.length, true);
    head.set(name, 30);
    yield head;

    let crc = 0;
    let written = 0;
    for await (const chunk of e.chunks()) {
      crc = crc32(crc, chunk);
      written += chunk.length;
      yield chunk;
    }
    if (written !== e.size) {
      throw new Error(`${e.path}: read ${written} bytes, expected ${e.size}.`);
    }
    crcs.push(crc);

    const desc = new DataView(new ArrayBuffer(16));
    desc.setUint32(0, 0x08074b50, true);
    desc.setUint32(4, crc, true);
    desc.setUint32(8, e.size, true);
    desc.setUint32(12, e.size, true);
    yield new Uint8Array(desc.buffer);
  }

  const dir = new Uint8Array(central + (zip64 ? 56 + 20 : 0) + 22);
  const d = new DataView(dir.buffer);
  let p = 0;
  entries.forEach((e, i) => {
    const name = encoder.encode(e.path);
    const far = offsets[i] >= U32;
    d.setUint32(p, 0x02014b50, true);
    d.setUint16(p + 4, far ? 45 : 20, true);
    d.setUint16(p + 6, far ? 45 : 20, true);
    d.setUint16(p + 8, 0x0808, true);
    d.setUint16(p + 12, time, true);
    d.setUint16(p + 14, day, true);
    d.setUint32(p + 16, crcs[i], true);
    d.setUint32(p + 20, e.size, true);
    d.setUint32(p + 24, e.size, true);
    d.setUint16(p + 28, name.length, true);
    d.setUint16(p + 30, far ? 12 : 0, true);
    d.setUint32(p + 42, far ? U32 : offsets[i], true);
    dir.set(name, p + 46);
    p += 46 + name.length;
    if (far) {
      d.setUint16(p, 0x0001, true);
      d.setUint16(p + 2, 8, true);
      setU64(d, p + 4, offsets[i]);
      p += 12;
    }
  });

  const count = entries.length;
  if (zip64) {
    const end64 = centralStart + central;
    d.setUint32(p, 0x06064b50, true);
    setU64(d, p + 4, 44);
    d.setUint16(p + 12, 45, true);
    d.setUint16(p + 14, 45, true);
    setU64(d, p + 24, count);
    setU64(d, p + 32, count);
    setU64(d, p + 40, central);
    setU64(d, p + 48, centralStart);
    p += 56;
    d.setUint32(p, 0x07064b50, true);
    setU64(d, p + 8, end64);
    d.setUint32(p + 16, 1, true);
    p += 20;
  }
  d.setUint32(p, 0x06054b50, true);
  d.setUint16(p + 8, Math.min(count, 0xffff), true);
  d.setUint16(p + 10, Math.min(count, 0xffff), true);
  d.setUint32(p + 12, zip64 ? U32 : central, true);
  d.setUint32(p + 16, zip64 ? U32 : centralStart, true);
  yield dir;
}
