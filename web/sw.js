// Push notifications for the web UI (PP-127): the service worker shows what the server pushes (`src/server/web-push.ts`)
// and opens its session on a tap. Push only: no fetch handler and no cache, so the app loads as it always does.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
    let message = {};

    try {
        message = event.data ? event.data.json() : {};
    } catch {
        message = { body: event.data ? event.data.text() : "" };
    }

    event.waitUntil(
        self.registration.showNotification(message.title || "pi-phone", {
            body: message.body || "",
            // One per session: the newest replaces the one before, and says so again.
            tag: message.tag || "pi-phone",
            renotify: true,
            icon: "icon-192.png",
            badge: "icon-192.png",
            data: { url: message.url || "/" },
        }),
    );
});

// A tap: an open pi-phone tab goes to the session (and comes to the front); with none open, one opens there.
self.addEventListener("notificationclick", (event) => {
    event.notification.close();

    const url = new URL(event.notification.data?.url || "/", self.registration.scope).href;

    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            const open = windows.find((each) => each.url.startsWith(self.registration.scope));

            if (open) {
                await open.focus();
                open.postMessage({ type: "pi-phone-open", url });

                return;
            }

            await self.clients.openWindow(url);
        })(),
    );
});
