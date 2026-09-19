const CACHE_NAME = "credmais-shell-v49";
const APP_SHELL = [
  "/",
  "/index.html",
  "/auth-action.html",
  "/auth-action.js",
  "/styles.css",
  "/app.js",
  "/firebase-config.js",
  "/firebase-bridge.js",
  "/supabase-config.js",
  "/supabase-bridge.js",
  "/vendor/firebase-app-compat.js",
  "/vendor/firebase-auth-compat.js",
  "/vendor/supabase.min.js",
  "/vendor/html2pdf.bundle.min.js",
  "/manifest.webmanifest",
  "/offline.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/eye.svg",
  "/icons/eye-off.svg",
  "/icons/google.svg",
  "/icons/whatsapp.svg",
  "/icons/home.svg",
  "/icons/users.svg",
  "/icons/wallet.svg",
  "/icons/chart-up.svg",
  "/icons/circle-check.svg",
  "/icons/file-text.svg",
  "/icons/history.svg",
  "/icons/alert.svg",
  "/icons/plus.svg",
  "/icons/pencil.svg",
  "/icons/trash.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("credmais-shell-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin === self.location.origin && requestUrl.pathname.startsWith("/api/"))
    return;
  if (event.request.mode === "navigate") {
    const page = requestUrl.pathname.endsWith("/auth-action.html")
      ? "/auth-action.html"
      : "/index.html";
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => cache.put(page, copy)),
          );
          return response;
        })
        .catch(() =>
          caches
            .match(page)
            .then((response) => response || caches.match("/offline.html")),
        ),
    );
    return;
  }
  if (requestUrl.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(
              caches
                .open(CACHE_NAME)
                .then((cache) => cache.put(event.request, copy)),
            );
          }
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
  }
});
