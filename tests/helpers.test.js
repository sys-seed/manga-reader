/* Node tests for MRDB helpers + MRZip (no browser). Run: node tests/helpers.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = (c, m) => { if (!c) throw new Error(m); };

function load(file, extra) {
  const sandbox = Object.assign({
    console, URL, Blob, Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder,
    Math, Number, String, Object, Array, Map, Set, Promise, Date, JSON, Error, parseFloat, isNaN,
    Response, DecompressionStream: global.DecompressionStream,
    IDBKeyRange: { bound: () => ({}) },
    indexedDB: { open() { return { set onupgradeneeded(f) {}, set onsuccess(f) {}, set onerror(f) {}, set onblocked(f) {} }; } },
    navigator: { storage: null },
    document: { createElement: () => ({ getContext() { return null; }, toBlob(cb) { cb(null); } }) },
    Image: function () {},
    createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
    fetch: async () => { throw new Error("net"); },
    MRZip: {},
    setTimeout, clearTimeout
  }, extra || {});
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8") + `\nthis.EXPORT = typeof MRDB !== "undefined" ? MRDB : MRZip;`, sandbox);
  return sandbox.EXPORT;
}

const MRZip = load("zip.js");
const MRDB = load("db.js", { MRZip });
const t = MRDB._t;

assert(t.parseChapterNumber("chapter_012") === 12, "parse chapter_012");
assert(t.parseChapterNumber("chapter_012_5") === 12.5, "parse chapter_012_5");
assert(t.parseChapterNumber("Chapitre 233") === 233, "parse Chapitre 233");
assert(t.parseChapterNumber("ch.03") === 3, "parse ch.03");
assert(t.parseChapterNumber("tome_03") === 3, "parse tome_03");
assert(t.numKey(233) === "233.0", "numKey int → .0 comme Python");
assert(t.numKey(12.5) === "12.5", "numKey float");
assert(t.looksLikeChapterDir("chapter_001"), "looksLike chapter_");
assert(t.looksLikeChapterDir("Chapitre 12"), "looksLike Chapitre");
assert(t.slugify("Solo Leveling!") === "solo-leveling", "slugify");
assert(t.mangaNameFromArchive("Mon Manga - Ch.03.cbz") === "Mon Manga", "mangaNameFromArchive");
assert(t.chapterLabel("chapter_012", 12) === "Chapitre 12", "label chapitre");
assert(t.chapterLabel("tome_03", 3) === "Tome 3", "label tome_03");
assert(t.chapterLabel("vol.12", 12) === "Tome 12", "label vol");
assert(t.chapterLabel("_root", null) === "Pages", "label root");

(async () => {
  const buf = fs.readFileSync("/tmp/test_manga.zip");
  const file = new Blob([buf]);
  const ents = await MRZip.entries(file);
  assert(ents.length === 3, "zip entries count");
  assert(ents[0].name.includes("page_001"), "zip first name");
  const blob = await MRZip.read(file, ents[0], "image/png");
  assert(blob.size === 70, "zip read size");
  console.log("OK —", 16, "assertions");
})().catch(e => { console.error(e); process.exit(1); });
