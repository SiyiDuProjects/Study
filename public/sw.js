const CACHE_NAME = "study-lecture-v4";
const APP_SHELL = ["/", "/manifest.webmanifest", "/icons/subtitle-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  const isPrivateApi =
    url.origin === self.location.origin &&
    (url.pathname === "/api" || url.pathname.startsWith("/api/") ||
      url.pathname === "/internal" || url.pathname.startsWith("/internal/"));
  if (isPrivateApi) {
    return;
  }

  if (event.request.mode === "navigate" && url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const contentType = response.headers.get("content-type") || "";
          if (response.ok && response.type === "basic" && contentType.includes("text/html")) {
            const copy = response.clone();
            return caches
              .open(CACHE_NAME)
              .then((cache) => cache.put("/", copy))
              .catch(() => undefined)
              .then(() => response);
          }
          return response;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(event.request);
    })
  );
});
