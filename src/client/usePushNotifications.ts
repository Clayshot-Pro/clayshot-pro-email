import { useEffect, useState } from "react";
import { base64UrlToArrayBuffer, needsHomeScreenInstall, notificationControlsDisabled } from "./appModel";
import type { NotificationState } from "./mailTypes";

/** Web push: detects support, re-binds an existing subscription on start, and toggles alerts. */
export function usePushNotifications(onError: (message: string) => void) {
  const [notificationState, setNotificationState] = useState<NotificationState>("checking");
  const [pushPublicKey, setPushPublicKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (needsHomeScreenInstall(navigator, matchMedia("(display-mode: standalone)").matches)) {
        setNotificationState("install");
        return;
      }
      if (
        !("serviceWorker" in navigator)
        || !("PushManager" in window)
        || !("Notification" in window)
      ) {
        setNotificationState("unsupported");
        return;
      }

      try {
        const response = await fetch("/api/push/config", { cache: "no-store" });
        const config = await response.json() as {
          configured: boolean;
          publicKey: string | null;
        };
        if (!config.configured || !config.publicKey) {
          setNotificationState("unconfigured");
          return;
        }

        setPushPublicKey(config.publicKey);
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });
        const subscription = await registration.pushManager.getSubscription();
        // A subscription belongs to the sign-in it was made in. Re-register it on
        // every start, so a new sign-in (or an expired one) keeps receiving alerts.
        if (subscription && Notification.permission === "granted") {
          await fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(subscription.toJSON()),
          }).catch(() => undefined);
        }
        if (!cancelled) {
          setNotificationState(
            Notification.permission === "denied"
              ? "blocked"
              : subscription
                ? "on"
                : "off",
          );
        }
      } catch {
        if (!cancelled) setNotificationState("unsupported");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const toggleNotifications = async () => {
    if (
      !pushPublicKey
      || notificationControlsDisabled(notificationState)
    ) {
      return;
    }

    setNotificationState("working");
    try {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: existing.endpoint }),
        });
        await existing.unsubscribe();
        setNotificationState("off");
        return;
      }

      if (await Notification.requestPermission() !== "granted") {
        setNotificationState("off");
        return;
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToArrayBuffer(pushPublicKey),
      });
      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) throw new Error();
      setNotificationState("on");
    } catch {
      setNotificationState("off");
      onError("Could not update notifications");
    }
  };

  return { notificationState, toggleNotifications };
}
