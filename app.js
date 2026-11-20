/* MangaReader PWA — interface (vanilla JS). Données : db.js (IndexedDB), archives : zip.js */
"use strict";
const $app = document.getElementById("app");
const enc = encodeURIComponent;
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem("mr_" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("mr_" + k, JSON.stringify(v)); } catch (e) {} }
};
const isStandalone = () => window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

function toast(msg, ms) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms || 2200);
}
function modal(html) {
  const m = document.getElementById("modal");
  document.getElementById("modal-card").innerHTML = html;
  m.classList.remove("hidden");
  m.onclick = e => { if (e.target === m && !m.dataset.lock) closeModal(); };
  return document.getElementById("modal-card");
}
function closeModal() { const m = document.getElementById("modal"); m.classList.add("hidden"); delete m.dataset.lock; }
function fmtDur(s) {
  s = Math.round(s || 0); if (s <= 0) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return h + "h " + String(m).padStart(2, "0") + "m";
  if (m) return m + "m " + String(r).padStart(2, "0") + "s";
  return r + "s";
}
const fmtNum = n => n == null ? "" : String(n);
function fmtSize(b) { if (b == null) return "—"; const u = ["o", "Ko", "Mo", "Go", "To"]; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return b.toFixed(i > 1 ? 1 : 0) + " " + u[i]; }

/* ---------- URLs d'objets (libérées à chaque changement de vue) ---------- */
const URLS = new Set();
function objURL(blob) { const u = URL.createObjectURL(blob); URLS.add(u); return u; }
function revokeAll() { URLS.forEach(u => URL.revokeObjectURL(u)); URLS.clear(); }
function coverImg(id) { return `<img class="cover" alt="" data-cover="${esc(id)}" src="${placeholder(id)}">`; }
function placeholder(id) {
  const l = esc((String(id).replace(/[^\p{L}\p{N}]/gu, "")[0] || "?").toUpperCase());
  return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="#2a2a2a"/><text x="100" y="175" font-size="110" text-anchor="middle" fill="#f0a500" font-family="-apple-system,Helvetica,sans-serif">${l}</text></svg>`);
}
let coverIO = null;
function hydrateCovers(root) {
  if (coverIO) coverIO.disconnect();
  coverIO = new IntersectionObserver(ents => ents.forEach(async e => {
    if (!e.isIntersecting) return;
    const img = e.target; coverIO.unobserve(img);
    try { const b = await MRDB.coverBlob(img.dataset.cover); if (b) img.src = typeof b === "string" ? b : objURL(b); } catch (x) {}
  }), {rootMargin: "300px"});
  (root || document).querySelectorAll("img[data-cover]").forEach(i => coverIO.observe(i));
}

/* ---------- Routage ---------- */
let cleanup = null;
async function route() {
  if (cleanup) { try { await cleanup(); } catch (e) {} cleanup = null; }
  closeModal(); revokeAll();
  document.body.classList.remove("reading");
  const p = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  try {
    if (p[0] === "m" && p[1]) return await viewManga(p[1]);
    if (p[0] === "r" && p[1] && p[2]) return await viewReader(p[1], p[2]);
    if (p[0] === "stats") return await viewStats();
    if (p[0] === "settings") return await viewSettings();
    return await viewLibrary();
  } catch (e) { errorView(e); }
}
window.addEventListener("hashchange", route);
function go(h) { location.hash = h; }
function tabbar(active) {
  const t = (id, icon, label, href) => `<a href="${href}" class="${active === id ? "on" : ""}"><b>${icon}</b>${label}</a>`;
  return `<nav class="tabbar">${t("lib", "📚", "Bibliothèque", "#/")}${t("import", "➕", "Importer", "#/settings")}${t("stats", "📊", "Stats", "#/stats")}</nav>`;
}
function errorView(e) {
  console.error(e);
  $app.innerHTML = `<header class="top"><h1>MangaReader</h1></header><main><div class="empty">⚠️ ${esc(e.message || e)}<br><br><button class="primary" onclick="go('#/')">Retour</button></div></main>` + tabbar("");
}

/* ---------- Bibliothèque ---------- */
async function viewLibrary() {
  const LIB = await MRDB.library();
  const st = LS.get("filters", {q: "", genre: "", sort: "recent", hideEmpty: false});
  $app.innerHTML = `
  <header class="top">
    <div class="row"><h1 class="grow">📚 Bibliothèque</h1><a class="btn ghost" href="#/settings">➕</a></div>
    <div class="row" style="margin-top:8px">
      <input class="search grow" id="q" type="search" placeholder="Rechercher un titre…" value="${esc(st.q)}" autocomplete="off">
      <select id="sort"><option value="recent">Récents</option><option value="title">Titre</option><option value="score">Note</option><option value="chapters">Chapitres</option><option value="unread">Non lus</option></select>
    </div>
    <div class="chips" id="chips"></div>
  </header>
  <main>${!isStandalone() && !LS.get("hideA2HS") ? `<div class="banner" id="a2hs">📲 Ajoute l'appli à l'écran d'accueil (Partager › « Sur l'écran d'accueil ») : elle s'ouvrira en plein écran et Safari ne risquera pas d'effacer tes mangas. <button class="ghost" id="a2hsx">✕</button></div>` : ""}
  <div id="cont"></div><div id="grid"></div></main>` + tabbar("lib");
  const x = document.getElementById("a2hsx"); if (x) x.onclick = () => { LS.set("hideA2HS", true); document.getElementById("a2hs").remove(); };
  const q = document.getElementById("q"), sort = document.getElementById("sort"), chips = document.getElementById("chips");
  sort.value = st.sort;
  chips.innerHTML = `<span class="chip" data-g="">Tous</span><span class="chip" data-g="__progress">En cours</span><span class="chip" data-g="__empty">Masquer vides</span>` +
    LIB.genres.map(g => `<span class="chip" data-g="${esc(g)}">${esc(g)}</span>`).join("");
  const render = () => {
    st.q = q.value; st.sort = sort.value; LS.set("filters", st);
    chips.querySelectorAll(".chip").forEach(c => { const g = c.dataset.g; c.classList.toggle("on", g === "__empty" ? st.hideEmpty : g === st.genre); });
    const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = LIB.mangas.filter(m => {
      const hay = (m.title + " " + m.id + " " + m.genres.join(" ")).toLowerCase();
      if (!words.every(w => hay.includes(w))) return false;
      if (st.hideEmpty && !m.nb_chapters) return false;
      if (st.genre === "__progress") return m.read_count > 0 && m.read_count < m.nb_chapters;
      return !st.genre || m.genres.includes(st.genre);
    });
    const ts = m => (m.last && m.last.ts) || 0;
    list.sort({recent: (a, b) => ts(b) - ts(a) || a.title.localeCompare(b.title), title: (a, b) => a.title.localeCompare(b.title, "fr", {numeric: true}),
      score: (a, b) => (b.score || 0) - (a.score || 0), chapters: (a, b) => b.nb_chapters - a.nb_chapters,
      unread: (a, b) => (b.nb_chapters - b.read_count) - (a.nb_chapters - a.read_count)}[st.sort]);
    const card = m => {
      const pct = m.nb_chapters ? Math.round(100 * m.read_count / m.nb_chapters) : 0;
      const newer = m.last_known != null && m.max_local != null && m.last_known > m.max_local ? Math.round(m.last_known - m.max_local) : 0;
      return `<a class="card" href="#/m/${enc(m.id)}">${coverImg(m.id)}${m.score != null ? `<span class="badge">${m.score}★</span>` : ""}
        ${newer > 0 ? `<span class="badge new">+${newer}</span>` : ""}<div class="t">${esc(m.title)}</div>
        <div class="s">${m.read_count}/${m.nb_chapters} lus${m.last ? " · " + esc(m.last.label) : ""}</div><div class="bar"><i style="width:${pct}%"></i></div></a>`;
    };
    const cont = LIB.mangas.filter(m => m.last && m.read_count < m.nb_chapters).sort((a, b) => ts(b) - ts(a)).slice(0, 12);
    document.getElementById("cont").innerHTML = !words.length && !st.genre && cont.length ? `<h2 style="margin-top:4px">▶️ Continuer la lecture</h2><div class="hscroll">${cont.map(m =>
      `<a class="card" href="#/r/${enc(m.id)}/${enc(m.last.chapter)}">${coverImg(m.id)}<div class="t">${esc(m.title)}</div><div class="s">${esc(m.last.label)}</div></a>`).join("")}</div><h2>Tous les mangas (${list.length})</h2>` : "";
    document.getElementById("grid").innerHTML = list.length ? `<div class="grid">${list.map(card).join("")}</div>` :
      `<div class="empty">${LIB.mangas.length ? "Aucun résultat." : "Bibliothèque vide.<br><br>Importe tes .cbz/.zip, un dossier de chapitres ou des images depuis l'app Fichiers.<br><br><a class='btn primary' href='#/settings'>➕ Importer</a>"}</div>`;
    hydrateCovers();
  };
  q.oninput = render; sort.onchange = render;
  chips.onclick = e => { const c = e.target.closest(".chip"); if (!c) return; const g = c.dataset.g; if (g === "__empty") st.hideEmpty = !st.hideEmpty; else st.genre = st.genre === g ? "" : g; render(); };
  render();
}

/* ---------- Fiche manga ---------- */
async function viewManga(id, delMode) {
  const m = await MRDB.manga(id);
  const desc = LS.get("desc_" + id, true), chs = desc ? m.chapters.slice().reverse() : m.chapters;
  const readN = m.chapters.filter(c => c.read).length, first = m.chapters[0], lastC = m.chapters[m.chapters.length - 1];
  const cont = m.last ? m.chapters.find(c => c.id === m.last.chapter) : m.chapters.find(c => !c.read);
  const nums = m.chapters.map(c => c.number).filter(n => n != null), maxLocal = nums.length ? Math.max(...nums) : null;
  $app.innerHTML = `
  <header class="top"><div class="row"><button class="ghost" onclick="go('#/')">‹ Bibliothèque</button><div class="grow"></div><button class="ghost" id="ani">✨ AniList</button></div></header>
  <main>
    <div class="hero">${coverImg(m.id)}<div class="grow"><h1 style="font-size:19px">${esc(m.title)}</h1>
      <div class="meta">${m.score != null ? `<span class="score">${m.score}/5 ★</span> · ` : ""}${m.chapters.length} chapitres · ${readN} lus · ${fmtSize(m.size)}</div>
      <div class="meta">${m.last_known != null ? "Dernier publié connu : ch. " + fmtNum(m.last_known) : ""}${m.last_known != null && maxLocal != null && m.last_known > maxLocal ? ` <span style="color:var(--red)">(${fmtNum(Math.round((m.last_known - maxLocal) * 10) / 10)} de plus que tes fichiers)</span>` : ""}</div>
      <div class="meta">${m.read_seconds ? "Temps de lecture : " + fmtDur(m.read_seconds) : ""}</div>
      ${m.anilist && m.anilist.url ? `<div class="meta"><a href="${esc(m.anilist.url)}" target="_blank" rel="noopener" style="color:var(--accent)">Fiche AniList ↗</a></div>` : ""}</div></div>
    <div class="chips">${m.genres.map(g => `<span class="chip">${esc(g)}</span>`).join("")}</div>
    ${m.summary ? `<div class="summary" id="sum">${esc(m.summary)}</div>` : ""}
    <div class="actions">
      ${cont ? `<button class="primary" onclick="go('#/r/${enc(m.id)}/${enc(cont.id)}')">▶ ${m.last ? "Continuer" : "Lire"} · ${esc(cont.label)}</button>` : ""}
      ${first ? `<button onclick="go('#/r/${enc(m.id)}/${enc(first.id)}')">⏮ Début</button>` : ""}
      ${lastC && lastC !== first ? `<button onclick="go('#/r/${enc(m.id)}/${enc(lastC.id)}')">⏭ Dernier</button>` : ""}
      <button id="more">⋯</button>
    </div>
    ${delMode ? `<div class="banner">🗑 Mode suppression : touche 🗑 pour effacer un chapitre de l'appareil. <button class="ghost" onclick="viewManga('${esc(id).replace(/'/g, "\\'")}')">Terminer</button></div>` : ""}
    <div class="row" style="margin:14px 0 8px"><h2 class="grow" style="margin:0">Chapitres</h2><button class="ghost" id="order">${desc ? "↓ Récents d'abord" : "↑ Anciens d'abord"}</button></div>
    <div class="list" id="chl">${chs.map(c => `
      <div class="li ${c.read ? "read" : ""} ${m.last && m.last.chapter === c.id ? "cur" : ""}">
        <a class="grow lbl" href="#/r/${enc(m.id)}/${enc(c.id)}">${esc(c.label)} <span class="meta">· ${c.pageCount} p.${m.last && m.last.chapter === c.id ? " · en cours" : ""}</span></a>
        ${delMode ? `<button class="ghost dot" data-del="${esc(c.id)}">🗑</button>` : `<button class="ghost dot" data-toggle="${esc(c.id)}">${c.read ? "✅" : "○"}</button>`}
      </div>`).join("") || `<div class="empty">Aucun chapitre. Importe des fichiers via ⋯</div>`}</div>
    <input type="file" id="file" multiple class="hidden">
  </main>` + tabbar("lib");
  hydrateCovers();
  const sum = document.getElementById("sum"); if (sum) sum.onclick = () => sum.classList.toggle("open");
  document.getElementById("order").onclick = () => { LS.set("desc_" + id, !desc); viewManga(id, delMode); };
  document.getElementById("chl").onclick = async e => {
    const t = e.target.closest("[data-toggle]");
    if (t) { const c = m.chapters.find(x => x.id === t.dataset.toggle); c.read = !c.read; t.textContent = c.read ? "✅" : "○"; t.parentElement.classList.toggle("read", c.read); await MRDB.setRead(id, c.id, c.read); return; }
    const d = e.target.closest("[data-del]");
    if (d && confirm("Supprimer ce chapitre de l'appareil ? (la progression est conservée)")) { await MRDB.deleteChapter(id, d.dataset.del); toast("Chapitre supprimé"); viewManga(id, true); }
  };
  document.getElementById("ani").onclick = () => aniDialog(m);
  const file = document.getElementById("file");
  file.onchange = async () => { await runImport(file.files, {mangaId: id}); viewManga(id); };
  document.getElementById("more").onclick = () => {
    const card = modal(`<h2 style="margin-top:0">${esc(m.title)}</h2><div class="list">
      <div class="li"><button class="grow" id="m-imp">📦 Ajouter des chapitres (.cbz, .zip, images)</button></div>
      <div class="li"><button class="grow" id="m-all">✅ Tout marquer comme lu</button></div>
      <div class="li"><button class="grow" id="m-none">○ Tout marquer comme non lu</button></div>
      ${cont ? `<div class="li"><button class="grow" id="m-upto">✅ Marquer lus jusqu'à ${esc(cont.label)} (exclu)</button></div>` : ""}
      <div class="li"><button class="grow" id="m-ren">✏️ Renommer</button></div>
      <div class="li"><button class="grow" id="m-ani">✨ Métadonnées AniList</button></div>
      <div class="li"><button class="grow" id="m-del">🗑 Supprimer des chapitres</button></div>
      <div class="li"><button class="grow danger" id="m-delall">🗑 Supprimer ce manga de l'appareil</button></div>
    </div><div class="meta" style="margin-top:10px">Identifiant : ${esc(m.id)}</div>`);
    const bulk = async (ids, read) => { await MRDB.setRead(id, ids, read); closeModal(); viewManga(id); };
    card.querySelector("#m-imp").onclick = () => { closeModal(); file.click(); };
    card.querySelector("#m-all").onclick = () => bulk(m.chapters.map(c => c.id), true);
    card.querySelector("#m-none").onclick = () => bulk(m.chapters.map(c => c.id), false);
    const up = card.querySelector("#m-upto"); if (up) up.onclick = () => bulk(m.chapters.slice(0, m.chapters.indexOf(cont)).map(c => c.id), true);
    card.querySelector("#m-ren").onclick = async () => { const t = prompt("Nouveau titre", m.title); if (t) { await MRDB.renameManga(id, t.trim()); closeModal(); viewManga(id); } };
    card.querySelector("#m-ani").onclick = () => aniDialog(m);
    card.querySelector("#m-del").onclick = () => { closeModal(); viewManga(id, true); };
    card.querySelector("#m-delall").onclick = async () => {
      if (!confirm(`Supprimer « ${m.title} » et ses ${m.chapters.length} chapitres (${fmtSize(m.size)}) de l'appareil ?`)) return;
      const keep = confirm("Garder la progression et les stats de ce manga (utile si tu le réimportes) ?");
      await MRDB.deleteManga(id, keep); closeModal(); toast("Manga supprimé"); go("#/");
    };
  };
}

/* ---------- AniList ---------- */
function aniDialog(m) {
  const card = modal(`<h2 style="margin-top:0">✨ AniList</h2><div class="meta">Résumé, genres, note et couverture depuis l'API publique AniList (Internet requis).</div>
    <div class="row" style="margin:10px 0"><input class="search grow" id="aq" value="${esc(m.title)}"><button class="primary" id="ago">Chercher</button></div><div id="ares"></div>`);
  let seq = 0;
  const doSearch = async () => {
    const my = ++seq, res = card.querySelector("#ares"); res.innerHTML = `<div class="empty">Recherche…</div>`;
    try {
      const r = await MRDB.aniSearch(card.querySelector("#aq").value);
      if (my !== seq) return;   // une recherche plus récente a été lancée
      res.innerHTML = r.map(x => `<div class="res">${x.cover_url ? `<img src="${esc(x.cover_url)}" alt="">` : ""}<div class="grow"><b>${esc(x.title)}</b>
        <div class="meta">${esc([x.format, x.year, x.country, x.status].filter(Boolean).join(" · "))}${x.score ? " · " + x.score + "/5" : ""}${x.chapters ? " · " + x.chapters + " ch." : ""}</div>
        <div class="meta">${esc(x.genres.join(", "))}</div><button class="primary" style="margin-top:6px" data-aid="${x.id}">Utiliser</button></div></div>`).join("") ||
        `<div class="empty">Aucun résultat. Essaie le titre anglais, romaji ou un mot-clé plus court.</div>`;
    } catch (e) { res.innerHTML = `<div class="empty">Erreur (hors ligne ?) : ${esc(e.message)}</div>`; }
  };
  card.querySelector("#ago").onclick = doSearch;
  card.querySelector("#aq").onkeydown = e => { if (e.key === "Enter") doSearch(); };
  card.querySelector("#ares").onclick = async e => {
    const b = e.target.closest("[data-aid]"); if (!b) return;
    b.disabled = true; b.textContent = "…";
    try { const r = await MRDB.aniApply(m.id, b.dataset.aid); toast("Métadonnées enregistrées" + (r.cover_saved ? " + couverture" : "")); closeModal(); viewManga(m.id); }
    catch (err) { toast("Erreur : " + err.message, 4000); b.disabled = false; b.textContent = "Utiliser"; }
  };
  doSearch();
}

/* ---------- Import ---------- */
async function askManga(fileName) {
  const lib = await MRDB.library(), idx = await MRDB.kvGet("library_index", []);
  const ids = [...new Set([...lib.mangas.map(m => m.id), ...(idx || []).map(e => e.slug)])].sort();
  return new Promise(res => {
    const card = modal(`<h2 style="margin-top:0">À quel manga correspond ${esc(fileName)} ?</h2>
      <div class="meta">Safari ne donne pas le nom du dossier d'un fichier choisi seul. Choisis le manga (dossier) d'origine.</div>
      <select id="am" style="width:100%;margin:10px 0">${ids.map(i => `<option>${esc(i)}</option>`).join("")}</select>
      <input class="search" id="amt" placeholder="…ou tape l'identifiant du dossier (slug)">
      <div class="actions"><button class="primary" id="amok">Valider</button><button id="amskip">Ignorer ce fichier</button></div>`);
    document.getElementById("modal").dataset.lock = "1";
    card.querySelector("#amok").onclick = () => { const v = card.querySelector("#amt").value.trim() || card.querySelector("#am").value; closeModal(); res(v || null); };
    card.querySelector("#amskip").onclick = () => { closeModal(); res(null); };
  });
}
async function runImport(files, opts) {
  files = Array.from(files || []); if (!files.length) return null;
  await MRDB.persist();
  const card = modal(`<h2 style="margin-top:0">Import en cours…</h2><div class="meta" id="istep">Préparation (${files.length} fichier(s))</div><div class="meta" style="margin-top:10px">Garde l'appli ouverte jusqu'à la fin.</div>`);
  document.getElementById("modal").dataset.lock = "1";
  const step = card.querySelector("#istep");
  let res;
  try { res = await MRDB.importFiles(files, Object.assign({askManga}, opts), msg => { step.textContent = msg; }); }
  catch (e) { closeModal(); toast("Erreur : " + e.message, 5000); return null; }
  const st = await MRDB.storage();
  const c2 = modal(`<h2 style="margin-top:0">✅ Import terminé</h2>
    <div>${res.chapters} chapitre(s), ${res.pages} page(s) dans ${res.mangas.length} manga(s).</div>
    ${res.data.length ? `<h3>Données</h3><div class="meta">${res.data.map(esc).join("<br>")}</div>` : ""}
    ${res.errors.length ? `<h3 style="color:var(--red)">Erreurs</h3><div class="meta">${res.errors.map(esc).join("<br>")}</div>` : ""}
    ${res.skipped.length ? `<div class="meta" style="margin-top:8px">${res.skipped.length} fichier(s) ignoré(s).</div>` : ""}
    <div class="meta" style="margin-top:8px">Stockage utilisé : ${fmtSize(st.usage)}${st.quota ? " / " + fmtSize(st.quota) : ""}</div>
    <div class="actions"><button class="primary" id="iok">OK</button></div>`);
  c2.querySelector("#iok").onclick = () => { closeModal(); if (res.mangas.length === 1 && !opts.mangaId) go("#/m/" + enc(res.mangas[0])); else route(); };
  return res;
}

/* ---------- Lecteur (chargement paresseux + libération mémoire) ---------- */
async function viewReader(mid, cid) {
  document.body.classList.add("reading");
  const d = await MRDB.chapter(mid, cid), N = d.pages.length;
  $app.innerHTML = `
  <div class="rprog" id="rprog"></div>
  <div class="rbar top" id="rtop"><div class="row"><button class="ghost" onclick="go('#/m/${enc(mid)}')">‹</button>
    <div class="grow"><div class="ttl">${esc(d.title)}</div><div class="sub">${esc(d.chapter.label)} · ${d.index + 1}/${d.count} · ${N} pages</div></div>
    <button class="ghost" onclick="go('#/m/${enc(mid)}')">☰</button></div></div>
  <div class="reader" id="reader"><div style="height:calc(env(safe-area-inset-top) + 56px)"></div>
    ${d.pages.map((p, i) => `<img class="page" data-i="${i}" alt="" style="aspect-ratio:${p.w && p.h ? p.w + "/" + p.h : "720/1100"}">`).join("")}
    <div class="chend" id="chend"><div>Fin de ${esc(d.chapter.label)}</div><div class="actions">
      ${d.prev ? `<button onclick="go('#/r/${enc(mid)}/${enc(d.prev)}')">‹ Précédent</button>` : ""}
      ${d.next ? `<button class="primary" onclick="go('#/r/${enc(mid)}/${enc(d.next)}')">Chapitre suivant ›</button>` : `<button onclick="go('#/m/${enc(mid)}')">Dernier chapitre — retour à la fiche</button>`}
    </div></div></div>
  <div class="rbar bot" id="rbot"><div class="row">
    <button ${d.prev ? "" : "disabled"} onclick="go('#/r/${enc(mid)}/${enc(d.prev || "")}')">‹ Préc.</button>
    <div class="grow" style="text-align:center"><span class="sub" id="rpage">1 / ${N}</span></div>
    <button ${d.next ? "" : "disabled"} onclick="go('#/r/${enc(mid)}/${enc(d.next || "")}')">Suiv. ›</button></div></div>`;
  window.scrollTo(0, 0);
  const imgs = Array.from(document.querySelectorAll("img.page"));
  const live = new Map();     // index -> objectURL
  const load = async i => {
    if (live.has(i)) return; live.set(i, null);
    const b = await MRDB.pageBlob(d.key, i);
    if (!live.has(i) || !b) { live.delete(i); return; }
    const u = URL.createObjectURL(b); live.set(i, u);
    const im = imgs[i];
    im.onload = () => { im.classList.add("ok"); if (!d.pages[i].w) { im.style.aspectRatio = im.naturalWidth + "/" + im.naturalHeight; } };
    im.src = u;
  };
  const unload = i => { const u = live.get(i); live.delete(i); if (u) { imgs[i].removeAttribute("src"); imgs[i].classList.remove("ok"); URL.revokeObjectURL(u); } };
  // charge à ±3 écrans, libère au-delà de ±10 écrans
  const near = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) load(+e.target.dataset.i); }), {rootMargin: "300% 0px"});
  const far = new IntersectionObserver(es => es.forEach(e => { if (!e.isIntersecting) unload(+e.target.dataset.i); }), {rootMargin: "1000% 0px"});
  imgs.forEach(im => { near.observe(im); far.observe(im); });

  const ratioNow = () => {
    const y = window.scrollY + window.innerHeight * 0.3;
    for (let i = imgs.length - 1; i >= 0; i--) { const t = imgs[i].offsetTop; if (y >= t) { const h = imgs[i].offsetHeight || 1; return Math.min(1, (i + Math.min(1, (y - t) / h)) / N); } }
    return 0;
  };
  let lastSaved = -1;
  const resume = d.resume > 0.001 && d.resume < 0.98 ? d.resume : 0;
  if (resume) {   // la mise en page est connue d'avance (dimensions stockées) : reprise immédiate
    const tgt = resume * N, i = Math.min(N - 1, Math.floor(tgt)), im = imgs[i];
    window.scrollTo(0, Math.max(0, im.offsetTop + (tgt - i) * im.offsetHeight - window.innerHeight * 0.3));
    lastSaved = resume; toast("Reprise à la page " + (i + 1));
  }
  const startTs = Math.floor(Date.now() / 1000);
  let active = 0, since = document.hidden ? null : Date.now(), markedRead = d.read;
  const flushSession = async () => {
    if (since) { active += Date.now() - since; since = document.hidden ? null : Date.now(); }
    const secs = Math.round(active / 1000);
    if (secs >= 5) { active = 0; await MRDB.recordSession(mid, cid, secs, N, startTs); }
  };
  const savePos = force => { const r = Math.round(ratioNow() * 1000) / 1000; if (force || Math.abs(r - lastSaved) > 0.02) { lastSaved = r; return MRDB.savePosition(mid, cid, r); } };
  if (!resume) savePos(true);
  const onVis = () => { if (document.hidden) { flushSession(); savePos(true); since = null; } else since = Date.now(); };
  document.addEventListener("visibilitychange", onVis); window.addEventListener("pagehide", onVis);
  const top = document.getElementById("rtop"), bot = document.getElementById("rbot"), prog = document.getElementById("rprog"), rpage = document.getElementById("rpage");
  let lastY = window.scrollY, ticking = false, saveT = null;
  const setBars = on => { top.classList.toggle("off", !on); bot.classList.toggle("off", !on); };
  const onScroll = () => {
    if (ticking) return; ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = window.scrollY, r = ratioNow();
      if (Math.abs(y - lastY) > 12) { setBars(y < lastY || y < 80); lastY = y; }
      prog.style.width = (r * 100).toFixed(1) + "%";
      rpage.textContent = Math.min(N, Math.floor(r * N) + 1) + " / " + N;
      const atEnd = window.innerHeight + y >= document.getElementById("chend").offsetTop + 40;
      if (atEnd) setBars(true);
      if (!markedRead && (r >= 0.9 || atEnd)) { markedRead = true; MRDB.setRead(mid, cid, true); }
      clearTimeout(saveT); saveT = setTimeout(() => savePos(false), 800);
    });
  };
  window.addEventListener("scroll", onScroll, {passive: true});
  document.getElementById("reader").onclick = e => { if (!e.target.closest("button")) setBars(top.classList.contains("off")); };
  setTimeout(() => setBars(false), 2500);
  cleanup = async () => {
    near.disconnect(); far.disconnect();
    document.removeEventListener("visibilitychange", onVis); window.removeEventListener("pagehide", onVis); window.removeEventListener("scroll", onScroll);
    clearTimeout(saveT);
    await Promise.all([flushSession(), savePos(true)]);
    for (const i of [...live.keys()]) unload(i);
  };
}

/* ---------- Statistiques ---------- */
async function viewStats() {
  const s = await MRDB.stats(), st = await MRDB.storage();
  const max = Math.max(1, ...s.days.map(x => x.seconds));
  const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  const dt = ts => new Date(ts * 1000).toLocaleString("fr-FR", {day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"});
  const link = (slug, inner, href) => s.local_mangas.has(slug) ? `<a class="li" href="${href}">${inner}</a>` : `<div class="li">${inner}</div>`;
  $app.innerHTML = `<header class="top"><h1>📊 Statistiques</h1></header><main>
    <div class="stat-grid">
      ${stat(s.mangas, "📚 Mangas sur l'appareil")}${stat(s.chapters, "📄 Chapitres sur l'appareil")}
      ${stat(s.chapters_read, "✅ Chapitres lus")}${stat(fmtDur(s.total_read_seconds), "🕐 Temps total de lecture")}
      ${stat(fmtDur(s.avg_chapter_sec), "📖 Moyenne par chapitre")}${stat(fmtDur(s.avg_page_sec), "🖼️ Moyenne par image")}
      ${stat(s.sessions, "Chapitres chronométrés")}${stat(s.pages_read, "Pages lues")}
      ${stat(fmtSize(s.size_bytes), "💾 Taille des mangas")}${stat(fmtSize(st.usage) + (st.quota ? " / " + fmtSize(st.quota) : ""), "Stockage utilisé / quota")}
    </div>
    <h2>30 derniers jours</h2>
    <div class="days">${s.days.map(x => `<i title="${x.day} : ${fmtDur(x.seconds)}" style="height:${(100 * x.seconds / max).toFixed(1)}%"></i>`).join("")}</div>
    <h2>Mangas les plus lus</h2>
    <div class="list">${s.top.map(t => link(t.slug, `<span class="grow">${esc(t.title || t.slug)}</span><span class="meta">${t.chapters} ch. · ${fmtDur(t.seconds)}</span>`, "#/m/" + enc(t.slug))).join("") || `<div class="empty">Pas encore de lecture.</div>`}</div>
    <h2>Dernières lectures</h2>
    <div class="list">${s.recent.map(r => link(r.slug, `<span class="grow">${esc(r.title || r.slug)} · ch. ${fmtNum(r.chapter_number)}</span><span class="meta">${dt(r.last_ts || r.start_ts)} · ${fmtDur(r.duration_sec)}</span>`, `#/r/${enc(r.slug)}/${enc(r.chapter_folder)}`)).join("")}</div>
  </main>` + tabbar("stats");
}

/* ---------- Import & réglages ---------- */
async function viewSettings() {
  const st = await MRDB.storage(), lib = await MRDB.library();
  const pct = st.quota ? Math.min(100, 100 * st.usage / st.quota) : 0;
  const dirOK = "webkitdirectory" in document.createElement("input");
  $app.innerHTML = `<header class="top"><h1>➕ Importer & réglages</h1></header><main>
    <h2 style="margin-top:4px">📦 Importer des mangas</h2>
    <div class="meta">Depuis l'app Fichiers (iCloud Drive, Sur mon iPhone…). Formats : .cbz, .zip, images (jpg, png, webp…).
      Le manga et le chapitre sont déduits des noms (ex. <code>solo-leveling/chapter_012/page_001.jpg</code> ou <code>Mon Manga - Ch.03.cbz</code>).</div>
    <input class="search" id="iname" placeholder="Nom du manga (optionnel : impose le manga pour tout l'import)" style="margin:10px 0">
    <div class="actions">
      <button class="primary" id="bfiles">📄 Fichiers .cbz / .zip / images</button>
      ${dirOK ? `<button id="bdir">📁 Un dossier</button>` : ""}
    </div>
    <div class="meta">${dirOK ? "« Un dossier » : choisis un dossier de chapitre, de manga, ou ton dossier <code>mangas</code> entier (les JSON d'origine sont repris au passage). Si Safari ne propose pas le choix de dossier, compresse le dossier en .zip dans Fichiers (appui long › Compresser) et importe le zip." : "Choix de dossier non pris en charge ici : compresse le dossier en .zip dans Fichiers (appui long › Compresser) puis importe le .zip."}</div>
    <input type="file" id="ifiles" multiple class="hidden">
    <input type="file" id="idir" multiple webkitdirectory class="hidden">

    <h2>💾 Stockage</h2>
    <div class="list">
      <div class="li"><div class="grow"><div>Utilisé : ${fmtSize(st.usage)}${st.quota ? " sur " + fmtSize(st.quota) : ""}</div><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div></div></div>
      <div class="li"><div class="grow">Stockage persistant ${st.persisted ? "✅ accordé" : "⚠️ non accordé"}<div class="meta">${isStandalone() ? "Appli ouverte depuis l'écran d'accueil ✅" : "Ouvre l'appli depuis l'écran d'accueil pour limiter les purges de Safari."}</div></div>${st.persisted ? "" : `<button id="bpersist">Demander</button>`}</div>
      ${lib.mangas.sort((a, b) => b.size - a.size).slice(0, 50).map(m => `<div class="li"><a class="grow" href="#/m/${enc(m.id)}">${esc(m.title)} <span class="meta">· ${m.nb_chapters} ch.</span></a><span class="meta">${fmtSize(m.size)}</span><button class="ghost" data-delm="${esc(m.id)}">🗑</button></div>`).join("")}
    </div>

    <h2>🗂 Données de lecture</h2>
    <div class="meta">Importe les JSON de l'ancienne appli Pythonista : <code>reading_stats.json</code>, <code>library_index.json</code>, <code>last_chapters_seen.json</code>, et dans chaque dossier manga <code>progress.json</code> / <code>.last_chapter</code> (le manga te sera demandé). Ou restaure une sauvegarde.</div>
    <div class="actions"><button id="bjson">⬆️ Importer des JSON</button><button class="primary" id="bexport">⬇️ Exporter une sauvegarde</button></div>
    <input type="file" id="ijson" multiple class="hidden">

    <h2>✨ AniList</h2>
    <div class="meta">Complète les mangas sans genres avec le 1er résultat AniList (vérifie ensuite sur chaque fiche).</div>
    <div class="actions"><button id="aniall">Enrichir les fiches incomplètes</button></div><div class="meta" id="anilog"></div>

    <h2>⚠️ Zone dangereuse</h2>
    <div class="actions"><button class="danger" id="bwipe">Tout effacer (mangas + données)</button></div>
    <div class="meta" style="margin:16px 0 0">MangaReader PWA ${esc(window.MR_VERSION || "")} · tout est stocké sur cet appareil, rien n'est envoyé en ligne (sauf les recherches AniList).</div>
  </main>` + tabbar("import");
  const name = () => document.getElementById("iname").value.trim();
  const ifiles = document.getElementById("ifiles"), idir = document.getElementById("idir"), ijson = document.getElementById("ijson");
  document.getElementById("bfiles").onclick = () => ifiles.click();
  ifiles.onchange = () => runImport(ifiles.files, {manga: name()});
  const bdir = document.getElementById("bdir");
  if (bdir) { bdir.onclick = () => idir.click(); idir.onchange = () => runImport(idir.files, {manga: name()}); }
  const bp = document.getElementById("bpersist");
  if (bp) bp.onclick = async () => { const ok = await MRDB.persist(); toast(ok ? "Stockage persistant accordé" : "Refusé par le navigateur (ajoute l'appli à l'écran d'accueil)", 4000); viewSettings(); };
  $app.querySelectorAll("[data-delm]").forEach(b => b.onclick = async () => {
    const m = lib.mangas.find(x => x.id === b.dataset.delm);
    if (!confirm(`Supprimer « ${m.title} » (${fmtSize(m.size)}) de l'appareil ? La progression est conservée.`)) return;
    await MRDB.deleteManga(m.id, true); toast("Supprimé"); viewSettings();
  });
  document.getElementById("bjson").onclick = () => ijson.click();
  ijson.onchange = async () => {
    const out = await MRDB.importData(ijson.files, askManga);
    modal(`<h2 style="margin-top:0">Données importées</h2><div class="meta">${out.map(esc).join("<br>")}</div><div class="actions"><button class="primary" onclick="closeModal()">OK</button></div>`);
  };
  document.getElementById("bexport").onclick = async () => {
    const b = await MRDB.backup();
    const blob = new Blob([JSON.stringify(b, null, 2)], {type: "application/json"});
    const fname = "mangareader-sauvegarde-" + new Date().toISOString().slice(0, 10) + ".json";
    const file = new File([blob], fname, {type: "application/json"});
    if (navigator.canShare && navigator.canShare({files: [file]})) {
      try { await navigator.share({files: [file], title: fname}); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fname; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast("Sauvegarde exportée : " + fname, 3000);
  };
  document.getElementById("aniall").onclick = async e => {
    const btn = e.target; btn.disabled = true;
    const log = document.getElementById("anilog"), todo = (await MRDB.library()).mangas.filter(m => !m.genres.length);
    let n = 0;
    for (const m of todo) {
      log.textContent = `(${++n}/${todo.length}) ${m.title}…`;
      try { const r = await MRDB.aniSearch(m.title); if (r.length) await MRDB.aniApply(m.id, r[0].id); } catch (err) { log.textContent += " erreur : " + err.message; }
      await new Promise(r => setTimeout(r, 2500));
    }
    log.textContent = todo.length ? `Terminé (${todo.length} fiches).` : "Toutes les fiches ont déjà des genres.";
    btn.disabled = false;
  };
  document.getElementById("bwipe").onclick = async () => {
    if (!confirm("Effacer TOUS les mangas, la progression et les stats de cet appareil ? Exporte une sauvegarde avant.")) return;
    if (!confirm("Vraiment tout effacer ?")) return;
    await MRDB.wipe(); localStorage.clear(); toast("Tout a été effacé"); go("#/");
  };
}

/* ---------- Démarrage ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(e => console.warn("SW", e)));
  navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.type === "updated") toast("Nouvelle version installée", 3000); });
}
route();
