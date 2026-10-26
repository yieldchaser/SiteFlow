"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function PwaControls() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [status, setStatus] = useState("Ready for offline punch capture");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };

    const handleOnline = () => {
      setIsOnline(true);
      setStatus("Online - cloud sync operational");
    };

    const handleOffline = () => {
      setIsOnline(false);
      setStatus("Offline - queued locally for background sync");
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    setIsOnline(navigator.onLine);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) {
      setStatus("Use browser menu to install SiteFlow on this device");
      return;
    }

    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setStatus(outcome === "accepted" ? "App installed successfully" : "Install dismissed");
    setDeferredPrompt(null);
  };

  const handleEnableNotifications = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setStatus("Notifications are not supported in this browser");
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      setStatus("Notifications allowed on this device");
    } else {
      setStatus("Notifications blocked");
    }
  };

  return (
    <div className="rounded-lg border border-border-custom bg-elevated p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted">Mobile PWA</div>
          <div className="mt-1 text-sm font-semibold text-foreground">Installable shell and offline punch capture</div>
          <div className="mt-1 text-[11px] text-muted">{status}</div>
        </div>
        <Badge tone={isOnline ? "success" : "warning"}>
          {isOnline ? "Online" : "Offline"}
        </Badge>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={handleInstall}
          className="rounded-lg bg-primary px-3 py-2 text-[11px] font-bold text-white transition-opacity hover:opacity-90"
        >
          Install App
        </button>
        <button
          onClick={handleEnableNotifications}
          className="rounded-lg border border-border-custom bg-white/[0.03] px-3 py-2 text-[11px] font-bold text-foreground transition-colors hover:bg-elevated"
        >
          Enable Notifications
        </button>
      </div>
    </div>
  );
}
