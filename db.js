/* db.js — stockage local (IndexedDB) + logique métier de MangaReader PWA.
   Tout reste dans le navigateur : pages (Blob), progression, stats, métadonnées. */
"use strict";
const MRDB = (() => {
  const DB_NAME = "mangareader-pwa", DB_VER = 1, SEP = "\u0001";
  const IMG_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i, ZIP_RE = /\.(cbz|zip)$/i;
  let dbp = null;

  /* ---------- IndexedDB ---------- */
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("mangas")) db.createObjectStore("mangas", {keyPath: "id"});
        if (!db.objectStoreNames.contains("chapters")) db.createObjectStore("chapters", {keyPath: "key"}).createIndex("manga", "manga");
        if (!db.objectStoreNames.contains("pages")) db.createObjectStore("pages");
        if (!db.objectStoreNames.contains("covers")) db.createObjectStore("covers");
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("Base de données bloquée : ferme les autres onglets de l'appli"));
    });
    return dbp;
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function tx(stores, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(stores, mode);
      let out;
      Promise.resolve(fn(t)).then(v => { out = v; }, e => { try { t.abort(); } catch (x) {} rej(e); });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("transaction annulée"));
    });
  }
  const get = (store, key) => tx([store], "readonly", t => reqP(t.objectStore(store).get(key)));
  const put = (store, val, key) => tx([store], "readwrite", t => { t.objectStore(store).put(val, key); });
  const all = store => tx([store], "readonly", t => reqP(t.objectStore(store).getAll()));
  const kvGet = async (k, d) => { const v = await get("kv", k); return v === undefined ? d : v; };
  const kvSet = (k, v) => put("kv", v, k);
  const kvAll = async prefix => tx(["kv"], "readonly", t => new Promise((res, rej) => {
    const out = {}, r = t.objectStore("kv").openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
    r.onsuccess = () => { const c = r.result; if (c) { out[c.key.slice(prefix.length)] = c.value; c.continue(); } else res(out); };
    r.onerror = () => rej(r.error);
  }));

  /* ---------- Outils ---------- */
  const naturalKey = s => String(s).toLowerCase().split(/(\d+)/).map((t, i) => i % 2 ? t.padStart(12, "0") : t).join("");
  const natCmp = (a, b) => naturalKey(a) < naturalKey(b) ? -1 : naturalKey(a) > naturalKey(b) ? 1 : 0;
  const numKey = n => { const f = parseFloat(n); return Number.isInteger(f) ? f.toFixed(1) : String(f); };   // "233.0" comme Python
  const chKey = (mid, cid) => mid + SEP + cid;
  const fmtNum = n => n == null ? "" : (Number.isInteger(n) ? String(n) : String(n));
  // Ne retire que les vraies extensions (lettres), pas ".12" dans "vol.12" / "ch.03"
  const stripExt = n => n.replace(/\.(?:jpe?g|png|webp|gif|avif|bmp|cbz|zip|json)$/i, "");
  const baseName = p => p.split("/").pop();
  const titleFromSlug = s => stripExt(s).replace(/[-_]+/g, " ").trim().replace(/\b\p{L}/gu, c => c.toUpperCase());
  const slugify = s => (s.normalize("NFC").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().toLowerCase().replace(/[\s_]+/g, "-")) || "manga";
  const mimeOf = n => ({jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp"})[(n.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

  function parseChapterNumber(name) {
    const stem = ZIP_RE.test(name) ? stripExt(name) : name;
    let m = stem.match(/^chapter_(\d+)(?:_(\d+))?$/);
    if (m) return parseFloat(m[1] + (m[2] ? "." + m[2] : ""));
    m = stem.match(/(?:chapitre|chapter|chap|ch|c|episode|épisode|ep)[\s._#-]*(\d+(?:[.,]\d+)?)/i);
    if (m) return parseFloat(m[1].replace(",", "."));
    const nums = stem.match(/\d+(?:[.,]\d+)?/g);
    return nums ? parseFloat(nums[nums.length - 1].replace(",", ".")) : null;
  }
  function chapterLabel(id, number) {
    if (id === "_root") return "Pages";
    if (number == null) return stripExt(baseName(id));
    const stem = stripExt(baseName(id));
    // Accepte tome_03 / vol.3 / T.12 (séparateurs espace, point, tiret, underscore)
    const isVol = /(?:^|[^a-z])(vol(?:ume)?|tome|t)[\s._#-]*\d/i.test(stem)
      && !/(?:chapitre|chapter|chap|ch|episode|épisode|ep)[\s._#-]*\d/i.test(stem);
    return (isVol ? "Tome " : "Chapitre ") + fmtNum(number);
  }
  const looksLikeChapterDir = d => /^chapter_\d+/.test(d) || /(chapitre|chapter|chap|ch|episode|épisode|ep|vol(?:ume)?|tome)[\s._#-]*\d/i.test(d) || /^\d+([._,]\d+)?$/.test(d.trim());
  const mangaNameFromArchive = n => {
    const stem = stripExt(baseName(n));
    const t = stem.replace(/[\s._-]*(?:chapitre|chapter|chap|ch|episode|épisode|ep|vol(?:ume)?|tome|t|#)[\s._#-]*\d+(?:[.,]\d+)?.*$/i, "").replace(/[\s._-]+$/, "").trim();
    return t || stem;
  };

  /* Dimensions d'une image lues dans l'en-tête (évite de décoder) */
  async function imageSize(blob) {
    try {
      const d = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
      const be16 = o => (d[o] << 8) | d[o + 1], be32 = o => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
      const le16 = o => d[o] | (d[o + 1] << 8), le24 = o => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16);
      if (d[0] === 0x89 && d[1] === 0x50) return {w: be32(16), h: be32(20)};
      if (d[0] === 0x47 && d[1] === 0x49) return {w: le16(6), h: le16(8)};
      if (d[0] === 0xff && d[1] === 0xd8) {
        let o = 2;
        while (o + 9 < d.length) {
          if (d[o] !== 0xff) { o++; continue; }
          const mk = d[o + 1];
          if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return {h: be16(o + 5), w: be16(o + 7)};
          o += 2 + be16(o + 2);
        }
      }
      if (d[0] === 0x52 && d[8] === 0x57 && d[9] === 0x45) {           // RIFF....WEBP
        const fmt = String.fromCharCode(d[12], d[13], d[14], d[15]);
        if (fmt === "VP8 ") return {w: le16(26) & 0x3fff, h: le16(28) & 0x3fff};
        if (fmt === "VP8L") { const b = d[21] | (d[22] << 8) | (d[23] << 16) | (d[24] << 24); return {w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1}; }
        if (fmt === "VP8X") return {w: le24(24) + 1, h: le24(27) + 1};
      }
    } catch (e) {}
    try { const bm = await createImageBitmap(blob); const r = {w: bm.width, h: bm.height}; bm.close && bm.close(); return r; } catch (e) {}
    return {w: 0, h: 0};
  }

  /* Vignette de couverture 300x450 (haut de l'image) pour ne pas garder une page géante en mémoire */
  async function makeThumb(blob) {
    try {
      const url = URL.createObjectURL(blob);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const W = 300, H = 450, c = document.createElement("canvas"); c.width = W; c.height = H;
      const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
      const sw = W / s, sh = H / s, sx = (img.naturalWidth - sw) / 2;
      c.getContext("2d").drawImage(img, sx, 0, sw, sh, 0, 0, W, H);
      URL.revokeObjectURL(url);
      const out = await new Promise(res => c.toBlob(res, "image/jpeg", 0.85));
      return out && out.size ? out : blob;
    } catch (e) { return blob; }
  }

  /* ---------- Bibliothèque ---------- */
  async function chaptersOf(mid) {
    const list = await tx(["chapters"], "readonly", t => reqP(t.objectStore("chapters").index("manga").getAll(mid)));
    return sortChapters(list);
  }
  const sortChapters = list => list.sort((a, b) => (a.number == null) - (b.number == null) || (a.number || 0) - (b.number || 0) || natCmp(a.id, b.id));
  const lite = c => ({id: c.id, number: c.number, label: c.label, kind: c.kind, pageCount: c.pages.length, size: c.size});
  const progressKey = c => c.number != null ? numKey(c.number) : c.id;
  async function loadProgress(mid) {
    const raw = await kvGet("progress:" + mid, {}), out = {};
    for (const [k, v] of Object.entries(raw || {})) out[/^-?\d+(\.\d+)?$/.test(k) ? numKey(k) : k] = v;
    return out;
  }
  async function meta() {
    const [idx, ani, lastSeen, stats, state] = await Promise.all([kvGet("library_index", []), kvGet("anilist", {}), kvGet("last_seen", {}), kvGet("reading_stats", {sessions: []}), kvGet("reader_state", {})]);
    const li = {}; for (const e of idx || []) if (e && e.slug) li[e.slug] = e;
    const sl = {}; for (const s of (stats.sessions || [])) if (s.slug) (sl[s.slug] = sl[s.slug] || []).push(s);
    for (const v of Object.values(sl)) v.sort((a, b) => (b.last_ts || b.start_ts || 0) - (a.last_ts || a.start_ts || 0));
    return {li, ani: ani || {}, lastSeen: lastSeen || {}, stats, state: state || {}, sl};
  }
  function merged(m, M) {
    const li = M.li[m.id] || {}, al = M.ani[m.id] || {};
    const genres = [...(li.genres || [])]; for (const g of al.genres || []) if (!genres.includes(g)) genres.push(g);
    return {title: li.title || m.title || al.title || titleFromSlug(m.id), genres, score: li.score != null ? li.score : (al.score != null ? al.score : null),
      summary: li.summary || al.summary || "", anilist: al.id ? al : null};
  }
  async function lastPosition(mid, chapters, M) {
    const ids = chapters.map(c => c.id), st = M.state[mid];
    if (st && ids.includes(st.chapter)) return {chapter: st.chapter, ratio: st.ratio || 0, ts: st.ts || 0};
    const lc = await kvGet("lastchapter:" + mid, null);
    if (lc && typeof lc === "object") {
      if (ids.includes(lc.folder)) return {chapter: lc.folder, ratio: lc.ratio || 0, ts: lc.ts || 0};
      if (Number.isInteger(lc.index) && lc.index >= 0 && lc.index < chapters.length) return {chapter: chapters[lc.index].id, ratio: 0, ts: lc.ts || 0};
    }
    for (const s of M.sl[mid] || []) if (ids.includes(s.chapter_folder)) return {chapter: s.chapter_folder, ratio: 0, ts: s.last_ts || s.start_ts || 0};
    return null;
  }
  async function library() {
    const [mangas, chapters, M, allProg, allLastCh] = await Promise.all([
      all("mangas"), all("chapters"), meta(), kvAll("progress:"), kvAll("lastchapter:")
    ]);
    const byM = {}; for (const c of chapters) (byM[c.manga] = byM[c.manga] || []).push(c);
    const out = [], genres = new Set();
    for (const m of mangas) {
      const chs = sortChapters(byM[m.id] || []);
      const mm = merged(m, M);
      const raw = allProg[m.id] || {}, prog = {};
      for (const [k, v] of Object.entries(raw)) prog[/^-?\d+(\.\d+)?$/.test(k) ? numKey(k) : k] = v;
      const keys = new Set(chs.map(progressKey));
      const read = Object.entries(prog).filter(([k, v]) => v === "read" && keys.has(k)).length;
      const nums = chs.map(c => c.number).filter(n => n != null);
      // lastPosition sans aller-retour IDB (cache déjà chargé)
      let pos = null;
      const ids = chs.map(c => c.id), st = M.state[m.id];
      if (st && ids.includes(st.chapter)) pos = {chapter: st.chapter, ratio: st.ratio || 0, ts: st.ts || 0};
      else {
        const lc = allLastCh[m.id];
        if (lc && typeof lc === "object") {
          if (ids.includes(lc.folder)) pos = {chapter: lc.folder, ratio: lc.ratio || 0, ts: lc.ts || 0};
          else if (Number.isInteger(lc.index) && lc.index >= 0 && lc.index < chs.length) pos = {chapter: chs[lc.index].id, ratio: 0, ts: lc.ts || 0};
        }
        if (!pos) for (const s of M.sl[m.id] || []) if (ids.includes(s.chapter_folder)) { pos = {chapter: s.chapter_folder, ratio: 0, ts: s.last_ts || s.start_ts || 0}; break; }
      }
      if (pos) { const c = chs.find(x => x.id === pos.chapter); pos.label = c ? c.label : pos.chapter; }
      mm.genres.forEach(g => genres.add(g));
      out.push({id: m.id, title: mm.title, genres: mm.genres, score: mm.score, nb_chapters: chs.length, read_count: read,
        max_local: nums.length ? Math.max(...nums) : null, last_known: M.lastSeen[m.id] != null ? M.lastSeen[m.id] : null, last: pos,
        size: chs.reduce((s, c) => s + (c.size || 0), 0), read_seconds: (M.sl[m.id] || []).reduce((s, x) => s + (x.duration_sec || 0), 0)});
    }
    return {mangas: out, genres: [...genres].sort((a, b) => a.localeCompare(b, "fr"))};
  }
  async function manga(mid) {
    const m = await get("mangas", mid);
    if (!m) throw new Error("Manga introuvable");
    const [chs, M] = await Promise.all([chaptersOf(mid), meta()]);
    const prog = await loadProgress(mid), mm = merged(m, M);
    const secs = (M.sl[mid] || []).reduce((s, x) => s + (x.duration_sec || 0), 0);
    return Object.assign(mm, {id: mid, chapters: chs.map(c => Object.assign(lite(c), {read: prog[progressKey(c)] === "read"})),
      last: await lastPosition(mid, chs, M), last_known: M.lastSeen[mid] != null ? M.lastSeen[mid] : null, read_seconds: secs,
      size: chs.reduce((s, c) => s + (c.size || 0), 0)});
  }
  async function chapter(mid, cid) {
    const chs = await chaptersOf(mid), i = chs.findIndex(c => c.id === cid);
    if (i < 0) throw new Error("Chapitre introuvable");
    const M = await meta(), m = await get("mangas", mid), prog = await loadProgress(mid);
    const pos = await lastPosition(mid, chs, M);
    return {manga: mid, title: merged(m, M).title, chapter: lite(chs[i]), pages: chs[i].pages, key: chs[i].key, index: i, count: chs.length,
      prev: i > 0 ? chs[i - 1].id : null, next: i + 1 < chs.length ? chs[i + 1].id : null,
      resume: pos && pos.chapter === cid ? pos.ratio : 0, read: prog[progressKey(chs[i])] === "read"};
  }
  const pageBlob = (key, i) => get("pages", key + SEP + i);
  const coverBlob = async mid => (await get("covers", mid)) || ((await get("mangas", mid)) || {}).coverUrl || null;

  /* ---------- Progression / position / sessions (formats Pythonista) ---------- */
  async function setRead(mid, cids, read) {
    const chs = await chaptersOf(mid), raw = await kvGet("progress:" + mid, {}) || {};
    for (const cid of [].concat(cids)) {
      const c = chs.find(x => x.id === cid); if (!c) continue;
      const k = progressKey(c);
      for (const old of Object.keys(raw)) if (old !== k && !isNaN(parseFloat(old)) && numKey(old) === k) delete raw[old];
      raw[k] = read ? "read" : "unread";
    }
    await kvSet("progress:" + mid, raw);
  }
  async function savePosition(mid, cid, ratio) {
    const chs = await chaptersOf(mid), i = chs.findIndex(c => c.id === cid);
    if (i < 0) return;
    const now = Math.floor(Date.now() / 1000), r = Math.max(0, Math.min(1, +ratio || 0));
    const st = await kvGet("reader_state", {}) || {};
    st[mid] = {chapter: cid, ratio: Math.round(r * 1e4) / 1e4, ts: now};
    await kvSet("reader_state", st);
    await kvSet("lastchapter:" + mid, {index: i, folder: cid, number: chs[i].number, ratio: st[mid].ratio, ts: now});
  }
  async function recordSession(mid, cid, duration, pages, startTs) {
    duration = Math.min(Math.round(duration || 0), 4 * 3600);
    if (duration < 5) return false;
    const chs = await chaptersOf(mid), c = chs.find(x => x.id === cid); if (!c) return false;
    const M = await meta(), m = await get("mangas", mid);
    const data = await kvGet("reading_stats", null) || {total_read_seconds: 0, sessions: []};
    data.sessions = data.sessions || [];
    const ex = data.sessions.find(s => s.slug === mid && (c.number != null ? s.chapter_number === c.number : s.chapter_folder === cid));
    const now = Math.floor(Date.now() / 1000);
    if (ex) { ex.duration_sec = (ex.duration_sec || 0) + duration; ex.pages_count = pages || ex.pages_count || 0; ex.last_ts = now; }
    else data.sessions.push({slug: mid, title: merged(m, M).title, chapter_number: c.number, chapter_folder: cid,
      start_ts: Math.floor(startTs || now - duration), duration_sec: duration, pages_count: pages || 0, last_ts: now});
    data.total_read_seconds = (data.total_read_seconds || 0) + duration;
    await kvSet("reading_stats", data);
    return true;
  }
  async function stats() {
    const data = await kvGet("reading_stats", {sessions: []}) || {sessions: []};
    const S = data.sessions || [], lib = await library();
    const total = data.total_read_seconds || S.reduce((s, x) => s + (x.duration_sec || 0), 0);
    const pages = S.reduce((s, x) => s + (x.pages_count || 0), 0);
    const byM = {}, byDay = {};
    const dayOf = ts => { const d = new Date(ts * 1000); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
    for (const s of S) {
      const m = byM[s.slug] = byM[s.slug] || {slug: s.slug, title: s.title, seconds: 0, chapters: 0};
      m.seconds += s.duration_sec || 0; m.chapters++;
      const d = dayOf(s.last_ts || s.start_ts || 0); byDay[d] = (byDay[d] || 0) + (s.duration_sec || 0);
    }
    const days = []; for (let i = 29; i >= 0; i--) { const d = dayOf(Date.now() / 1000 - i * 86400); days.push({day: d, seconds: byDay[d] || 0}); }
    return {total_read_seconds: total, sessions: S.length, avg_chapter_sec: S.length ? total / S.length : 0, avg_page_sec: pages ? total / pages : 0,
      pages_read: pages, mangas: lib.mangas.length, chapters: lib.mangas.reduce((s, m) => s + m.nb_chapters, 0),
      chapters_read: lib.mangas.reduce((s, m) => s + m.read_count, 0), size_bytes: lib.mangas.reduce((s, m) => s + m.size, 0),
      top: Object.values(byM).sort((a, b) => b.seconds - a.seconds).slice(0, 10), days,
      recent: [...S].sort((a, b) => (b.last_ts || b.start_ts || 0) - (a.last_ts || a.start_ts || 0)).slice(0, 25),
      local_mangas: new Set(lib.mangas.map(m => m.id))};
  }

  /* ---------- Import de fichiers ---------- */
  async function ensureManga(id, title) {
    const m = await get("mangas", id);
    if (!m) await put("mangas", {id, title: title || null, addedAt: Date.now()});
    return id;
  }
  async function storeChapter(mid, cid, items, onPage) {
    // items : [{name, getBlob: async () => Blob}]
    // Prépare les blobs hors transaction, puis écrit tout d'un coup (évite chapitres partiels).
    items.sort((a, b) => natCmp(a.name, b.name));
    const key = chKey(mid, cid);
    const prepared = [];
    for (let i = 0; i < items.length; i++) {
      const blob = await items[i].getBlob();
      const dim = await imageSize(blob);
      prepared.push({blob, dim});
      onPage && onPage();
    }
    let coverThumb = null;
    if (prepared.length && !(await get("covers", mid))) coverThumb = await makeThumb(prepared[0].blob);
    await deleteChapterData(key);
    const pages = []; let size = 0;
    await tx(["pages", "chapters", "covers"], "readwrite", t => {
      const ps = t.objectStore("pages"), cs = t.objectStore("chapters"), cov = t.objectStore("covers");
      for (let i = 0; i < prepared.length; i++) {
        const {blob, dim} = prepared[i];
        ps.put(blob, key + SEP + i);
        pages.push({w: dim.w, h: dim.h, size: blob.size, type: blob.type});
        size += blob.size;
      }
      const number = cid === "_root" ? null : parseChapterNumber(baseName(cid));
      cs.put({key, manga: mid, id: cid, number, label: chapterLabel(cid, number), kind: ZIP_RE.test(cid) ? "zip" : "dir", pages, size, addedAt: Date.now()});
      if (coverThumb) cov.put(coverThumb, mid);
    });
    return pages.length;
  }
  async function deleteChapterData(key) {
    // Curseur : plus fiable que delete(range) sur certaines WebKit (clés hors ligne).
    await tx(["pages", "chapters"], "readwrite", t => new Promise((res, rej) => {
      const ps = t.objectStore("pages");
      const range = IDBKeyRange.bound(key + SEP, key + SEP + "\uffff");
      const r = ps.openCursor(range);
      r.onsuccess = () => { const c = r.result; if (c) { c.delete(); c.continue(); } else res(); };
      r.onerror = () => rej(r.error);
      t.objectStore("chapters").delete(key);
    }));
  }
  async function deleteChapter(mid, cid) { await deleteChapterData(chKey(mid, cid)); }
  async function deleteManga(mid, keepProgress) {
    const chs = await chaptersOf(mid);
    for (const c of chs) await deleteChapterData(c.key);
    await tx(["mangas", "covers"], "readwrite", t => { t.objectStore("mangas").delete(mid); t.objectStore("covers").delete(mid); });
    if (!keepProgress) await tx(["kv"], "readwrite", t => { t.objectStore("kv").delete("progress:" + mid); t.objectStore("kv").delete("lastchapter:" + mid); });
  }

  /* files : FileList/Array<File> ; opts.manga : nom imposé ; onStep(msg) */
  async function importFiles(files, opts, onStep) {
    opts = opts || {}; files = Array.from(files || []);
    const say = onStep || (() => {});
    const res = {mangas: new Set(), chapters: 0, pages: 0, data: [], skipped: [], errors: []};
    const path = f => (f.webkitRelativePath || f.name).split("/").filter(Boolean);
    // Précédence : un segment est caché s'il est __MACOSX, ou s'il commence par "." (sauf .last_chapter).
    const hidden = p => p.some(s => s === "__MACOSX" || (s.startsWith(".") && s !== ".last_chapter"));
    const forced = opts.manga ? opts.manga.trim() : "";
    const forcedId = opts.mangaId || (forced ? slugify(forced) : null);
    const defaultManga = forced || ("Import " + new Date().toLocaleDateString("fr-FR"));
    const groups = new Map(), covers = [], zips = [], jsons = [];
    for (const f of files) {
      const p = path(f), name = p[p.length - 1];
      if (hidden(p.slice(0, -1)) || (name.startsWith("._"))) { res.skipped.push(f.name); continue; }
      if (/\.json$/i.test(name) || name === ".last_chapter") { jsons.push(f); continue; }
      if (ZIP_RE.test(name)) { zips.push(f); continue; }
      if (!IMG_RE.test(name)) { res.skipped.push(name); continue; }
      let mid, title, cid;
      const dir = p.length >= 2 ? p[p.length - 2] : null;
      if (/^cover\./i.test(name) && dir) { covers.push({mid: forcedId || dir, f}); continue; }
      if (dir && looksLikeChapterDir(dir)) {
        cid = dir; const mdir = p.length >= 3 ? p[p.length - 3] : null;
        mid = forcedId || mdir || slugify(defaultManga); title = forced || (mdir ? null : defaultManga);
      } else if (dir) { cid = "_root"; mid = forcedId || dir; title = forced || null; }
      else { cid = opts.chapter || "_root"; mid = forcedId || slugify(defaultManga); title = defaultManga; }
      const gk = mid + SEP + cid;
      if (!groups.has(gk)) groups.set(gk, {mid, title, cid, items: []});
      groups.get(gk).items.push({name, getBlob: async () => new Blob([await f.arrayBuffer()], {type: f.type || mimeOf(name)})});
    }
    let gi = 0;
    for (const g of groups.values()) {
      gi++; let n = 0;
      try {
        await ensureManga(g.mid, g.title);
        const c = await storeChapter(g.mid, g.cid, g.items, () => say(`Images ${gi}/${groups.size} · ${g.title} · page ${++n}/${g.items.length}`));
        res.mangas.add(g.mid); res.chapters++; res.pages += c;
      } catch (e) { res.errors.push(g.title + " : " + e.message); }
    }
    let zi = 0;
    for (const f of zips) {
      zi++;
      const p = path(f), name = p[p.length - 1];
      try {
        say(`Archive ${zi}/${zips.length} : ${name}`);
        const ents = (await MRZip.entries(f)).filter(e => IMG_RE.test(e.name) && !e.name.includes("__MACOSX") && !baseName(e.name).startsWith("._"));
        if (!ents.length) throw new Error("aucune image dans l'archive");
        let mid, title;
        if (forcedId) { mid = forcedId; title = forced || null; }
        else if (p.length >= 2) { mid = p[p.length - 2]; title = null; }
        else { title = mangaNameFromArchive(name); mid = slugify(title); }
        await ensureManga(mid, title);
        const byDir = new Map();
        for (const e of ents) { const d = e.name.includes("/") ? e.name.slice(0, e.name.lastIndexOf("/")) : ""; if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(e); }
        const multi = byDir.size > 1;
        for (const [d, list] of byDir) {
          const cid = multi ? (baseName(d) || stripExt(name)) : name;
          let n = 0;
          const c = await storeChapter(mid, cid, list.map(e => ({name: e.name, getBlob: () => MRZip.read(f, e, mimeOf(e.name))})),
            () => say(`Archive ${zi}/${zips.length} · ${name} · page ${++n}/${list.length}`));
          res.chapters++; res.pages += c;
        }
        res.mangas.add(mid);
      } catch (e) { res.errors.push(name + " : " + e.message); }
    }
    for (const c of covers) {
      const m = await get("mangas", c.mid);
      if (m && !m.customCover) await put("covers", await makeThumb(new Blob([await c.f.arrayBuffer()], {type: c.f.type || mimeOf(c.f.name)})), c.mid);
    }
    if (jsons.length) {
      say("Données JSON…");
      res.data = await importData(jsons, opts.askManga);
    }
    res.mangas = [...res.mangas];
    return res;
  }

  /* ---------- Import / export des données de lecture ---------- */
  async function importData(files, askManga) {
    const out = [];
    for (const f of Array.from(files)) {
      const p = (f.webkitRelativePath || f.name).split("/"), name = p[p.length - 1];
      let obj;
      try { obj = JSON.parse(await f.text()); } catch (e) { out.push(name + " : JSON invalide"); continue; }
      try {
        if (obj && obj.app === "mangareader-pwa") { await restore(obj); out.push(name + " : sauvegarde restaurée"); continue; }
        if (name === "reading_stats.json" || (obj && Array.isArray(obj.sessions))) { const n = await mergeStats(obj); out.push(`${name} : ${n} sessions fusionnées`); continue; }
        if (Array.isArray(obj) && obj.length && obj[0] && obj[0].slug && ("summary" in obj[0] || "title" in obj[0])) { await kvSet("library_index", obj); out.push(`${name} : ${obj.length} fiches`); continue; }
        if (Array.isArray(obj) && name === "download_history.json") { out.push(name + " : ignoré (historique de téléchargement)"); continue; }
        if (name === "last_chapters_seen.json" || (obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).length && Object.values(obj).every(v => typeof v === "number"))) {
          const cur = await kvGet("last_seen", {}) || {}; Object.assign(cur, obj); await kvSet("last_seen", cur); out.push(`${name} : ${Object.keys(obj).length} mangas`); continue;
        }
        const isProgress = name === "progress.json" || (obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).length && Object.values(obj).every(v => v === "read" || v === "unread"));
        const isLast = name === ".last_chapter" || name === "last_chapter.json" || (obj && typeof obj === "object" && Number.isInteger(obj.index));
        if (isProgress || isLast) {
          let mid = p.length >= 2 ? p[p.length - 2] : null;
          if (!mid && askManga) mid = await askManga(name);
          if (!mid) { out.push(name + " : manga non précisé, ignoré"); continue; }
          if (isProgress) { const cur = await kvGet("progress:" + mid, {}) || {}; Object.assign(cur, obj); await kvSet("progress:" + mid, cur); out.push(`${name} → ${mid} : ${Object.keys(obj).length} chapitres`); }
          else { await kvSet("lastchapter:" + mid, obj); out.push(`${name} → ${mid}`); }
          continue;
        }
        if (name === "app_settings.json") { out.push(name + " : ignoré"); continue; }
        out.push(name + " : format non reconnu");
      } catch (e) { out.push(name + " : " + e.message); }
    }
    return out;
  }
  async function mergeStats(obj) {
    const cur = await kvGet("reading_stats", null);
    if (!cur || !(cur.sessions || []).length) { await kvSet("reading_stats", {total_read_seconds: obj.total_read_seconds || 0, sessions: obj.sessions || []}); return (obj.sessions || []).length; }
    const k = s => s.slug + SEP + (s.chapter_number != null ? s.chapter_number : s.chapter_folder);
    const map = new Map(cur.sessions.map(s => [k(s), s]));
    for (const s of obj.sessions || []) { const e = map.get(k(s)); if (!e || (s.duration_sec || 0) > (e.duration_sec || 0)) map.set(k(s), s); }
    const sessions = [...map.values()];
    await kvSet("reading_stats", {total_read_seconds: sessions.reduce((a, s) => a + (s.duration_sec || 0), 0), sessions});
    return (obj.sessions || []).length;
  }
  async function backup() {
    return {app: "mangareader-pwa", version: 1, exported_at: new Date().toISOString(),
      reading_stats: await kvGet("reading_stats", {total_read_seconds: 0, sessions: []}),
      progress: await kvAll("progress:"), last_chapter: await kvAll("lastchapter:"),
      reader_state: await kvGet("reader_state", {}), library_index: await kvGet("library_index", []),
      last_chapters_seen: await kvGet("last_seen", {}), anilist: await kvGet("anilist", {}),
      mangas: (await all("mangas")).map(m => ({id: m.id, title: m.title}))};
  }
  async function restore(b) {
    if (b.reading_stats) await mergeStats(b.reading_stats);
    for (const [mid, v] of Object.entries(b.progress || {})) { const cur = await kvGet("progress:" + mid, {}) || {}; await kvSet("progress:" + mid, Object.assign(cur, v)); }
    for (const [mid, v] of Object.entries(b.last_chapter || {})) await kvSet("lastchapter:" + mid, v);
    if (b.reader_state) await kvSet("reader_state", Object.assign(await kvGet("reader_state", {}) || {}, b.reader_state));
    if (b.library_index && b.library_index.length) await kvSet("library_index", b.library_index);
    if (b.last_chapters_seen) await kvSet("last_seen", Object.assign(await kvGet("last_seen", {}) || {}, b.last_chapters_seen));
    if (b.anilist) await kvSet("anilist", Object.assign(await kvGet("anilist", {}) || {}, b.anilist));
  }

  /* ---------- AniList (appel direct, CORS autorisé) ---------- */
  const ANI_FIELDS = "id title { romaji english native } description(asHtml: false) genres averageScore chapters status startDate { year } format countryOfOrigin coverImage { large extraLarge } siteUrl";
  async function aniQuery(query, variables) {
    const r = await fetch("https://graphql.anilist.co", {method: "POST", headers: {"Content-Type": "application/json", "Accept": "application/json"}, body: JSON.stringify({query, variables})});
    const d = await r.json();
    if (d.errors) throw new Error(d.errors.map(e => e.message).join("; "));
    return d.data;
  }
  const cleanDesc = t => { if (!t) return ""; const el = document.createElement("textarea"); el.innerHTML = t.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""); return el.value.replace(/\n{3,}/g, "\n\n").trim(); };
  const aniSimplify = m => { const t = m.title || {}, c = m.coverImage || {};
    return {id: m.id, title: t.english || t.romaji || t.native, title_romaji: t.romaji, summary: cleanDesc(m.description), genres: m.genres || [],
      score: m.averageScore ? Math.round(m.averageScore / 2) / 10 : null, chapters: m.chapters, status: m.status, year: (m.startDate || {}).year,
      format: m.format, country: m.countryOfOrigin, cover_url: c.extraLarge || c.large, url: m.siteUrl}; };
  async function aniSearch(q) { const d = await aniQuery(`query ($s: String) { Page(perPage: 8) { media(search: $s, type: MANGA) { ${ANI_FIELDS} } } }`, {s: q}); return d.Page.media.map(aniSimplify); }
  async function aniApply(mid, id) {
    const d = await aniQuery(`query ($id: Int) { Media(id: $id, type: MANGA) { ${ANI_FIELDS} } }`, {id: +id});
    const info = aniSimplify(d.Media); info._fetched_at = Math.floor(Date.now() / 1000);
    const allA = await kvGet("anilist", {}) || {}; allA[mid] = info; await kvSet("anilist", allA);
    let cover = false;
    if (info.cover_url) {
      const m = await get("mangas", mid);
      if (m && !m.customCover) {
        // cache: "reload" : l'image a déjà été affichée sans CORS dans les résultats, on évite la réponse en cache
        try { const b = await (await fetch(info.cover_url, {mode: "cors", cache: "reload"})).blob(); if (b.size) { await put("covers", b, mid); m.customCover = true; await put("mangas", m); cover = true; } }
        catch (e) { m.coverUrl = info.cover_url; await put("mangas", m); }
      }
    }
    info.cover_saved = cover;
    return info;
  }
  async function renameManga(mid, title) { const m = await get("mangas", mid); if (m) { m.title = title; await put("mangas", m); } }

  /* ---------- Stockage ---------- */
  async function storage() {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : {};
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return {usage: est.usage, quota: est.quota, persisted};
  }
  async function persist() { try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (e) { return false; } }
  async function wipe() { (await open()).close(); dbp = null; await reqP(indexedDB.deleteDatabase(DB_NAME)); }

  /* Import des JSON Pythonista fournis avec l'appli (data/*.json) — une seule fois ou à la demande. */
  async function importBundledPythonista() {
    const files = ["library_index.json", "reading_stats.json", "last_chapters_seen.json"];
    const blobs = [];
    for (const name of files) {
      try {
        const r = await fetch("./data/" + name, {cache: "no-cache"});
        if (!r.ok) continue;
        blobs.push(new File([await r.blob()], name, {type: "application/json"}));
      } catch (e) {}
    }
    if (!blobs.length) throw new Error("Fichiers data/ introuvables (hors ligne ?)");
    const out = await importData(blobs, null);
    await kvSet("bundled_imported_at", Date.now());
    return out;
  }

  return {open, library, manga, chapter, pageBlob, coverBlob, setRead, savePosition, recordSession, stats, importFiles, importData,
    importBundledPythonista, backup, restore, aniSearch, aniApply, deleteChapter, deleteManga, renameManga, storage, persist, wipe, kvGet, kvSet,
    _t: {parseChapterNumber, chapterLabel, looksLikeChapterDir, mangaNameFromArchive, numKey, imageSize, slugify}};
})();
