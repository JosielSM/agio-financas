const CACHE_NAME = "credmais-admin-v6";
const SHELL = [
  "/admin/",
  "/admin/index.html",
  "/admin/styles.css",
  "/admin/app.js",
  "/admin/manifest.webmanifest",
  "/firebase-config.js",
  "/firebase-bridge.js",
  "/supabase-config.js",
  "/supabase-bridge.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png"
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("credmais-admin-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/admin/index.html"))),
  );
});
