/* ETF 看板 Service Worker：仅用于通知与安装为应用（PWA），不做离线缓存。 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// 只做透传，且必须跳过 /api（SSE 与动态接口交给浏览器/后端，避免流被拦截）
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).catch(() => Response.error()));
});

self.addEventListener("notificationclick", (e) => {
  const data = e.notification.data || {};
  const code = data.etf_code;
  e.notification.close();
  e.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const target = list.find((c) => c.url.includes(location.host)) || list[0];
      if (target) {
        await target.focus();
        if (code) target.postMessage({ type: "etf:select", code });
        return;
      }
      const win = await self.clients.openWindow("/");
      if (win && code) win.postMessage({ type: "etf:select", code });
    })(),
  );
});
