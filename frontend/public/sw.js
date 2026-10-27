const SITEFLOW_BUILD_ID = "fad8c319f1cb0867";
const CACHE_NAME = `siteflow-shell-${SITEFLOW_BUILD_ID}`;
const OFFLINE_URL = "/offline";
const APP_SHELL = [
  "/",
  "/login",
  "/offline",
  "/manifest.json",
  "/images/logo.svg",
  "/favicon.ico",
];

function isCacheable(response) {
  return Boolean(response) && response.status === 200 && response.type === "basic";
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

function isRscRequest(request, url) {
  return url.searchParams.has("_rsc") || request.headers.get("RSC") === "1";
}

function isHtmlRequest(request) {
  return (
    request.mode === "navigate" ||
    request.destination === "document" ||
    request.destination === "iframe"
  );
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    if (request.mode === "navigate") {
      const offline = await cache.match(OFFLINE_URL);
      if (offline) {
        return offline;
      }
    }
    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (isCacheable(response)) {
        cache.put(request, response.clone());
      }
      return response;
    })
    // With nothing cached, hand back a network error rather than undefined,
    // which the browser rejects with "Failed to convert value to 'Response'".
    .catch(() => cached || Response.error());
  return cached || network;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (isHtmlRequest(event.request) || isRscRequest(event.request, url)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "SiteFlow alert",
    body: "You have a new project notification.",
    url: "/login",
  };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch (error) {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/images/logo.svg",
      badge: "/images/logo.svg",
      data: { url: payload.url || "/login" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/login";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) {
            return client.navigate(targetUrl);
          }
          return client;
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }

      return undefined;
    })
  );
});
