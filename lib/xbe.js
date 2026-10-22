// default.xbe: the same check the game runs at boot (src/main.c, xbe_matches_lift), size + FNV-1a 64, and the
// title fields of its certificate, to tell another edition from another game.

// FNV-1a 64 in two 32-bit halves: prime 0x100000001b3 = 2^40 + 0x1b3.
export function fnv1a64(bytes) {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let i = 0; i < bytes.length; i++) {
    lo ^= bytes[i];
    const low = (lo >>> 0) * 0x1b3;
    const carry = Math.floor(low / 0x100000000);
    hi = (Math.imul(hi, 0x1b3) + carry + (lo << 8)) >>> 0;
    lo = low >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

export function xbeInfo(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 0x178 || view.getUint32(0, true) !== 0x48454258) { // "XBEH"
    return null;
  }
  const cert = view.getUint32(0x118, true) - view.getUint32(0x104, true);
  if (cert < 0 || cert + 0xb0 > bytes.length) {
    return null;
  }
  let name = '';
  for (let i = 0; i < 40; i++) {
    const c = view.getUint16(cert + 0x0c + i * 2, true);
    if (!c) break;
    name += String.fromCharCode(c);
  }
  return {
    titleId: view.getUint32(cert + 0x08, true).toString(16).padStart(8, '0'),
    titleName: name.trim(),
    region: view.getUint32(cert + 0xa0, true),
    version: view.getUint32(cert + 0xac, true),
  };
}
