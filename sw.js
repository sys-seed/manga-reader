/* Service worker : met l'appli en cache pour fonctionner hors ligne.
   Les mangas eux-mêmes sont dans IndexedDB, pas dans ce cache. */
const VERSION = "pwa-1.1.0";
const CACHE = "mangareader-" + VERSION;
const ASSETS = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "db.js",
  "zip.js",
  "manifest.webmanifest",
  "icon.svg",
  "apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const old = keys.filter(k => k.startsWith("mangareader-") && k !== CACHE);
    await Promise.all(old.map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({type: "window"});
    clients.forEach(c => c.postMessage({type: "updated", version: VERSION}));
  })());
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // data/*.json et navigations : réseau d'abord pour éviter de servir une vieille appli
  const isNav = e.request.mode === "navigate";
  const isData = url.pathname.includes("/data/");
  const isShell = ASSETS.some(a => a !== "./" && url.pathname.endsWith("/" + a.replace(/^\.\//, "")));

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isNav || isData) {
      try {
        const r = await fetch(e.request);
        if (isNav && r.ok) cache.put("index.html", r.clone());
        return r;
      } catch (err) {
        return (await cache.match("index.html")) || (await cache.match("./")) || Response.error();
      }
    }
    const hit = await cache.match(e.request, {ignoreSearch: true});
    if (hit) {
      // Stale-while-revalidate pour le shell JS/CSS
      if (isShell) fetch(e.request).then(r => { if (r && r.ok) cache.put(e.request, r.clone()); }).catch(() => {});
      return hit;
    }
    try {
      const r = await fetch(e.request);
      if (r.ok && r.type === "basic") cache.put(e.request, r.clone());
      return r;
    } catch (err) {
      return (await cache.match("index.html")) || Response.error();
    }
  })());
});
