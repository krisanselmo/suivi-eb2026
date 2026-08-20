/* Service worker — the page has to work at Val Pelouse at 3am with no signal.
 *
 * Two caches with opposite lifetimes:
 *   - the shell (html/css/js/data/icons) is versioned and replaced on every deploy;
 *   - the map tiles are not versioned at all, because a tile does not change and
 *     re-downloading 10 MB of them on each deploy would be absurd.
 *
 * VERSION is written by scripts/build_crew.py, from the same stamp it puts in data.js. The
 * page compares the two: if the worker is newer than the JS running, the tab is stale and a
 * reload is offered. Never edit it by hand — a mismatch is what raises the banner.
 */

const VERSION = "2026-08-20T1145";  // BUILD_STAMP
const SHELL = `eb-shell-${VERSION}`;
const TILES = "eb-tiles";
const TILE_CAP = 900; // ~20 MB; the whole course at z9-13 is 443 tiles

const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./sim.js",
  "./app.js",
  "./data.js",
  "./manifest.webmanifest",
  "./vendor/leaflet.css",
  "./vendor/leaflet.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-16.png",
  "./icons/favicon-32.png",
  "./icons/favicon-48.png",
  "./favicon.ico",
];

const isTile = (url) => url.hostname.endsWith("tile.opentopomap.org");

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // one by one: a single 404 must not void the whole precache
    await Promise.all(SHELL_FILES.map(async (f) => {
      try { await c.add(new Request(f, { cache: "reload" })); } catch (_) { /* skip */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== SHELL && k !== TILES) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

/** Serve from cache at once, refresh in the background: instant offline, fresh next time. */
async function staleWhileRevalidate(req) {
  const c = await caches.open(SHELL);
  const hit = await c.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => {
    if (res && res.ok) c.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  return hit || (await net) || new Response("", { status: 504, statusText: "hors ligne" });
}

/** Tiles: cache first, and trim oldest-inserted when the cap is passed. */
async function tileFirst(req) {
  const c = await caches.open(TILES);
  const hit = await c.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) {
      await c.put(req, res.clone());
      const keys = await c.keys();
      if (keys.length > TILE_CAP) {
        for (const k of keys.slice(0, keys.length - TILE_CAP)) await c.delete(k);
      }
    }
    return res;
  } catch (_) {
    // no signal and never seen: a transparent 1x1 beats a broken-image icon on the map
    return new Response(
      Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (ch) => ch.charCodeAt(0)),
      { headers: { "Content-Type": "image/gif" } },
    );
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (isTile(url)) { e.respondWith(tileFirst(req)); return; }
  if (url.origin !== self.location.origin) return;      // anything else: straight to network
  if (req.mode === "navigate") {
    e.respondWith(staleWhileRevalidate(new Request("./index.html")));
    return;
  }
  e.respondWith(staleWhileRevalidate(req));
});

self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") { self.skipWaiting(); return; }
  if (e.data && e.data.type === "VERSION" && e.ports && e.ports[0]) {
    e.ports[0].postMessage(VERSION);
  }
});
