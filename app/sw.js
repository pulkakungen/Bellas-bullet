const CACHE_NAME = "bullet-v2";
const CORE_FILES = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("bullet-") && k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Nätverk först för appens egna filer, och förbi webbläsarens HTTP-cache
// (GitHub Pages låter filer ligga kvar i 10 minuter), så en ny version syns
// direkt. Cachen här är bara offline-reserv. Workern och Google går direkt.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request.url, { cache: "no-cache", credentials: "same-origin" })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "Bellas Bullet", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }
  const hash = data.tag === "bullet-kvall" ? "#kvall" : data.tag === "bullet-jobb" ? "#jobb" : "#day";
  event.waitUntil(
    self.registration.showNotification(data.title || "Bellas Bullet", {
      body: data.body,
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: data.tag || "bullet",
      data: { url: "./" + hash }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && "focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});
