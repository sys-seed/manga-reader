/* zip.js — lecture de .cbz/.zip en JS pur, sans dépendance.
   Lit le répertoire central via File.slice (le fichier n'est jamais chargé en entier).
   Décompression : DecompressionStream('deflate-raw') si dispo (iOS 16.4+), sinon inflate JS intégré. */
"use strict";
const MRZip = (() => {
  const u16 = (d, o) => d[o] | (d[o + 1] << 8);
  const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
  const readBytes = async (blob, start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());

  async function entries(file) {
    const size = file.size;
    const tailLen = Math.min(size, 65557 + 20);
    const tail = await readBytes(file, size - tailLen, size);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Archive ZIP invalide (fin de répertoire introuvable)");
    let count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16);
    if (cdOff === 0xffffffff || count === 0xffff) {           // ZIP64
      const loc = eocd - 20;
      if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
        const z64off = Number(new DataView(tail.buffer, tail.byteOffset + loc + 8, 8).getBigUint64(0, true));
        const z = await readBytes(file, z64off, z64off + 56);
        const dv = new DataView(z.buffer);
        count = Number(dv.getBigUint64(32, true)); cdSize = Number(dv.getBigUint64(40, true)); cdOff = Number(dv.getBigUint64(48, true));
      }
    }
    const cd = await readBytes(file, cdOff, cdOff + cdSize);
    const out = [];
    let p = 0;
    const dec = new TextDecoder("utf-8");
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (u32(cd, p) !== 0x02014b50) break;
      const flags = u16(cd, p + 8), method = u16(cd, p + 10);
      let csize = u32(cd, p + 20), usize = u32(cd, p + 24);
      const nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32);
      let off = u32(cd, p + 42);
      const nameBytes = cd.subarray(p + 46, p + 46 + nlen);
      let name;
      try { name = (flags & 0x800) ? dec.decode(nameBytes) : new TextDecoder("utf-8", {fatal: true}).decode(nameBytes); }
      catch (e) { name = Array.from(nameBytes, b => String.fromCharCode(b)).join(""); }
      // champ extra ZIP64
      let x = p + 46 + nlen, xe = x + xlen;
      while (x + 4 <= xe) {
        const id = u16(cd, x), sz = u16(cd, x + 2);
        if (id === 0x0001) {
          const dv = new DataView(cd.buffer, cd.byteOffset + x + 4, sz); let q = 0;
          if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
          if (off === 0xffffffff) { off = Number(dv.getBigUint64(q, true)); }
        }
        x += 4 + sz;
      }
      if (!name.endsWith("/")) out.push({name, method, csize, usize, offset: off, encrypted: !!(flags & 1)});
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  async function read(file, e, type) {
    if (e.encrypted) throw new Error("Archive chiffrée non supportée");
    const h = await readBytes(file, e.offset, e.offset + 30);
    if (u32(h, 0) !== 0x04034b50) throw new Error("En-tête local invalide : " + e.name);
    const start = e.offset + 30 + u16(h, 26) + u16(h, 28);
    const raw = file.slice(start, start + e.csize);
    if (e.method === 0) return new Blob([await raw.arrayBuffer()], {type});
    if (e.method !== 8) throw new Error("Méthode de compression non supportée (" + e.method + ")");
    if (typeof DecompressionStream !== "undefined") {
      try {
        const ds = raw.stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Blob([await new Response(ds).arrayBuffer()], {type});
      } catch (err) { /* repli JS */ }
    }
    return new Blob([inflateRaw(new Uint8Array(await raw.arrayBuffer()), e.usize)], {type});
  }

  /* ---- inflate (RFC 1951) en JS pur, utilisé si DecompressionStream est absent ---- */
  function inflateRaw(src, sizeHint) {
    let out = new Uint8Array(sizeHint > 0 ? sizeHint : src.length * 4), op = 0;
    let bp = 0, bitbuf = 0, bitcnt = 0;
    const need = n => { while (bitcnt < n) { if (bp >= src.length) throw new Error("données deflate tronquées"); bitbuf |= src[bp++] << bitcnt; bitcnt += 8; } };
    const bits = n => { if (!n) return 0; need(n); const v = bitbuf & ((1 << n) - 1); bitbuf >>>= n; bitcnt -= n; return v; };
    const ensure = n => { if (op + n > out.length) { const o = new Uint8Array(Math.max(out.length * 2, op + n)); o.set(out); out = o; } };
    const build = lens => {
      const counts = new Uint16Array(16), offs = new Uint16Array(16), syms = new Uint16Array(lens.length);
      for (const l of lens) counts[l]++;
      counts[0] = 0;
      for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
      for (let i = 0; i < lens.length; i++) if (lens[i]) syms[offs[lens[i]]++] = i;
      return {counts, syms};
    };
    const decode = t => {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len < 16; len++) {
        code |= bits(1);
        const c = t.counts[len];
        if (code - first < c) return t.syms[index + code - first];
        index += c; first += c; first <<= 1; code <<= 1;
      }
      throw new Error("code Huffman invalide");
    };
    const LB = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    const LE = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    const DB = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    const DE = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    let fixedL = null, fixedD = null;
    let final = 0;
    while (!final) {
      final = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;
        const len = src[bp] | (src[bp + 1] << 8); bp += 4;
        ensure(len); out.set(src.subarray(bp, bp + len), op); op += len; bp += len;
        continue;
      }
      let lt, dt;
      if (type === 1) {
        if (!fixedL) {
          const l = new Uint8Array(288);
          l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
          fixedL = build(l); fixedD = build(new Uint8Array(30).fill(5));
        }
        lt = fixedL; dt = fixedD;
      } else if (type === 2) {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const ord = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[ord[i]] = bits(3);
        const ct = build(cl);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const s = decode(ct);
          if (s < 16) lens[i++] = s;
          else if (s === 16) { const prev = lens[i - 1]; for (let r = bits(2) + 3; r; r--) lens[i++] = prev; }
          else if (s === 17) { for (let r = bits(3) + 3; r; r--) lens[i++] = 0; }
          else { for (let r = bits(7) + 11; r; r--) lens[i++] = 0; }
        }
        lt = build(lens.subarray(0, hlit)); dt = build(lens.subarray(hlit));
      } else throw new Error("bloc deflate invalide");
      for (;;) {
        const s = decode(lt);
        if (s < 256) { ensure(1); out[op++] = s; }
        else if (s === 256) break;
        else {
          const li = s - 257, len = LB[li] + bits(LE[li]);
          const di = decode(dt), dist = DB[di] + bits(DE[di]);
          ensure(len);
          for (let k = 0; k < len; k++, op++) out[op] = out[op - dist];
        }
      }
    }
    return out.subarray(0, op);
  }
  return {entries, read, inflateRaw};
})();
if (typeof module !== "undefined") module.exports = MRZip;
