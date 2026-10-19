self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "New email received" };
  }

  const title = payload.title || "New mail";
  const options = {
    body: payload.body || "New email received",
    tag: payload.tag || "ltm-mail-new-message",
    renotify: true,
    data: { url: payload.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// The browser can replace a subscription (expiry, key rotation). Register the
// new one at once, or alerts would silently stop until the app is opened.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const options = event.oldSubscription?.options;
    const subscription = event.newSubscription
      ?? (options?.applicationServerKey
        ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey })
        : null);
    if (!subscription) return;
    await fetch("/api/push/subscribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;

  // Bring an open app window forward as it is: navigating it would reload the
  // page (losing an open compose) and rejects for a window this worker does
  // not control. The app refreshes the mailbox when it regains focus.
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      try {
        return await client.focus();
      } catch {
        // This window cannot be focused; try the next one or open a new one.
      }
    }
    return clients.openWindow(target);
  })());
});
