// Keeps the Calorie Calendar app shell available offline.
// Network first: while the server is reachable you always get the latest files (so edits show up
// straight away); the cached copies are only used when a request fails.

// Bump the version when the cached files or caching rules change; old caches are deleted when the
// new worker activates.
const cacheName = "calorieCalendar-v3";
const logPrefix = "[calorieCalendar service worker]";
const picoStylesheetUrl = "https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css";
const appShellPaths = [
    "./",
    "index.html",
    "config.js",
    "css/style.css",
    "js/app.js",
    "manifest.json",
    "icons/icon192.png",
    "icons/icon512.png",
    "icons/iconMaskable512.png",
];
const appShellUrls = new Set(appShellPaths.map((path) => new URL(path, self.location).href));

self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(cacheName);
            // "no-cache" for the same reason as in networkFirst: store current files, not HTTP-cached ones.
            await cache.addAll(appShellPaths.map((path) => new Request(path, { cache: "no-cache" })));
            // Pico comes from a CDN; offline styling is a bonus, so don't fail installation over it.
            try {
                await cache.add(picoStylesheetUrl);
            } catch (error) {
                console.warn(logPrefix, "Couldn't cache Pico CSS:", error);
            }
            await self.skipWaiting();
        })(),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const oldCacheNames = (await caches.keys()).filter(
                (name) => name.startsWith("calorieCalendar-") && name !== cacheName,
            );
            await Promise.all(oldCacheNames.map((name) => caches.delete(name)));
            await self.clients.claim();
        })(),
    );
});

self.addEventListener("fetch", (event) => {
    const { request } = event;
    // Backend API calls, product images and anything else not listed above go straight to the network.
    if (request.method !== "GET" || (request.mode !== "navigate" && !isCachedFile(request))) {
        return;
    }
    event.respondWith(networkFirst(request));
});

function isAppShellRequest(request) {
    const url = new URL(request.url);
    return appShellUrls.has(url.origin + url.pathname);
}

function isCachedFile(request) {
    return isAppShellRequest(request) || request.url === picoStylesheetUrl;
}

async function networkFirst(request) {
    try {
        // The dev server sends no caching headers, so the browser's HTTP cache can hand back an old copy
        // without asking the server. "no-cache" makes it check first (a cheap 304 when nothing changed).
        // Pico is a versioned CDN file, so normal HTTP caching is fine for it.
        const response = await fetch(request, request.url === picoStylesheetUrl ? undefined : { cache: "no-cache" });
        // Only refresh same-origin app files; the page's Pico request is opaque (no-cors) and can't be checked.
        if (response.ok && isAppShellRequest(request)) {
            await updateCache(request, response.clone());
        }
        return response;
    } catch (networkError) {
        const cachedResponse = await findCachedResponse(request);
        if (cachedResponse) {
            return cachedResponse;
        }
        console.warn(logPrefix, "Offline and not cached:", request.url, networkError);
        return Response.error();
    }
}

async function updateCache(request, response) {
    try {
        const cache = await caches.open(cacheName);
        await cache.put(request, response);
    } catch (error) {
        console.warn(logPrefix, "Couldn't update the offline copy of", request.url, error);
    }
}

async function findCachedResponse(request) {
    try {
        const cache = await caches.open(cacheName);
        return (
            (await cache.match(request, { ignoreSearch: true })) ??
            // Any page navigation (e.g. /index.html?x) falls back to the cached app page.
            (request.mode === "navigate" ? await cache.match("index.html") : undefined)
        );
    } catch (error) {
        console.warn(logPrefix, "Couldn't read the offline copy of", request.url, error);
        return undefined;
    }
}
