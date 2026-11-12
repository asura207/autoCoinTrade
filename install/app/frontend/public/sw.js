// Service Worker for Upbit AutoCoinTrade Web Push Notifications

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { body: event.data.text() };
    }
  }

  const title = data.title || "AI 뉴스 분석 완료";
  const body = data.body || "ai 분석이 완료되었습니다";
  const options = {
    body: body,
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    tag: "ai-news-analysis-done",
    renotify: true,
    data: data.data || { url: "/?menu=news" },
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/?menu=news";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          try {
            client.postMessage({ type: "NAVIGATE_MENU", menu: "news" });
          } catch (e) {}
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SHOW_NOTIFICATION") {
    const title = event.data.title || "AI 뉴스 분석 완료";
    const options = event.data.options || {
      body: "ai 분석이 완료되었습니다",
      icon: "/favicon.ico",
      tag: "ai-news-analysis-done",
      renotify: true,
    };
    self.registration.showNotification(title, options);
  }
});
