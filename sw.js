// Caché de la app para usarla instalada. Subir la versión cada vez que cambie un archivo.
const C = "ocr-traduccion-v7";
const FILES = ["./", "index.html", "styles.css", "manifest.webmanifest", "icon.svg", "icon-192.png",
  "js/app.js", "js/engine.js", "js/gemini.js", "js/claude.js", "js/pdf.js", "js/store.js", "js/export.js", "js/docx.js", "js/layout.js",
  "lib/pdf.min.mjs", "lib/pdf.worker.min.mjs", "lib/pdf-lib.esm.min.js",
  "lib/katex/katex.min.mjs", "lib/katex/katex.min.css"];
self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(C).then(c => c.addAll(FILES)).catch(() => {}));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return;
  e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(C).then(c => c.put(r, cp)); return res; }).catch(() => caches.match(r)));
});
