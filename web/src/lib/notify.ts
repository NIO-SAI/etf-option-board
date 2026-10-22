/**
 * Chrome 浏览器通知（Web Notifications）封装。
 *
 * 关键约束：Notification API 只在「安全上下文」可用——https:// 或 localhost。
 * 本机经 Tailscale 走 http://100.x.x.x:6799 时 `Notification` 直接不可用，
 * 故这里显式判定 isSecureContext，不可用时降级让调用方走页面内提示。
 * 跨设备请用 HTTPS 入口：https://<机器名>.<tailnet>.ts.net:8443（tailscale serve）。
 */

export type NotifyPermission = "unsupported" | "default" | "denied" | "granted";

function secure(): boolean {
  if (typeof window === "undefined") return false;
  if (window.isSecureContext) return true;
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

export function notifySupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window && secure();
}

export function notifyPermission(): NotifyPermission {
  if (!notifySupported()) return "unsupported";
  return Notification.permission as NotifyPermission;
}

export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (!notifySupported()) return "unsupported";
  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return "denied";
  }
}

/**
 * 首次用户交互（任意点击/触摸）时自动请求通知权限——只做一次。
 * 浏览器的权限框需要用户手势，自动请求可避免用户找不到「开启浏览器通知」按钮；
 * 被拒绝后不再纠缠（返回的 once 标记保证只调一次）。
 */
let _autoPromptDone = false;
export function autoPromptPermissionOnce(): void {
  if (_autoPromptDone || notifyPermission() !== "default") return;
  const kick = async () => {
    if (_autoPromptDone) return;
    _autoPromptDone = true;
    cleanup();
    await requestNotifyPermission();
  };
  const cleanup = () => {
    document.removeEventListener("pointerdown", kick, true);
    document.removeEventListener("keydown", kick, true);
  };
  document.addEventListener("pointerdown", kick, true);
  document.addEventListener("keydown", kick, true);
}

/** 诊断信标：把来源/安全上下文/通知权限写进一次 /api/health 请求，便于从服务端日志核对。 */
export function reportNotifyState(tag = "notify"): void {
  try {
    const info = {
      origin: location.origin,
      secure: typeof window !== "undefined" ? window.isSecureContext : false,
      perm: notifyPermission(),
      ua: navigator.userAgent.slice(0, 48),
    };
    void fetch(`/api/health?dbg=${tag}:${encodeURIComponent(JSON.stringify(info))}`).catch(() => {});
  } catch {
    /* ignore */
  }
}

export interface AlertLike {
  id?: number;
  title?: string;
  text?: string;
  level?: string;
  dir?: string;
  etf_code?: string;
  etf_name?: string;
  type?: string;
}

/** 通知图标：站点 favicon 的 PNG 版（PWA 安装后同时用作应用图标）。 */
const NOTIFY_ICON = "/icons/icon-192.png";

let _swReg: ServiceWorkerRegistration | null = null;

/**
 * 注册 Service Worker（仅用于「安装为应用」与通知点击回跳，不做离线缓存）。
 * SW 点击通知后会 postMessage {type:"etf:select", code}，这里转成 window 事件，
 * 由 AlertCenter 接手切到对应标的。
 */
export function initNotifications(): void {
  if (!secure() || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then((reg) => {
      _swReg = reg;
    })
    .catch(() => {
      /* 注册失败则退回 new Notification */
    });
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: string; code?: string } | null;
    if (d?.type === "etf:select" && d.code) {
      window.dispatchEvent(new CustomEvent("etf:select", { detail: d.code }));
    }
  });
}

/**
 * 同一条告警只弹一次。
 * 多个标签页/多个窗口都在收同一条 SSE，若都弹就成了重复通知；
 * 用 localStorage 做 30 秒租约，先到者弹、后来者静默（仍显示列表）。
 */
function claimAlert(a: AlertLike): boolean {
  if (a.id == null) return true;
  try {
    const key = `etf-notify:${a.id}`;
    const now = Date.now();
    const prev = Number(localStorage.getItem(key) || 0);
    if (prev && now - prev < 30_000) return false;
    localStorage.setItem(key, String(now));
  } catch {
    /* 隐私模式等拿不到 storage 时不做去重 */
  }
  return true;
}

function notifyOptions(a: AlertLike): NotificationOptions {
  return {
    body: a.text,
    icon: NOTIFY_ICON,
    badge: NOTIFY_ICON,
    tag: a.id != null ? `etf-alert-${a.id}` : undefined,
    // critical（主力资金 / 变盘）需要用户确认，不自动消失
    requireInteraction: a.level === "critical",
    silent: false,
    data: { etf_code: a.etf_code, id: a.id },
  };
}

function popupFallback(a: AlertLike, opts: NotificationOptions): boolean {
  try {
    const n = new Notification(a.title || "", opts);
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      if (a.etf_code) window.dispatchEvent(new CustomEvent("etf:select", { detail: a.etf_code }));
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * 弹一条浏览器通知。
 * 返回 false 表示「未授权/不支持」——调用方走页面内提示；
 * 返回 true 表示已交给系统（含被其它标签页抢先弹、本次静默的情况）。
 */
export function showNotification(a: AlertLike): boolean {
  if (notifyPermission() !== "granted" || !a.title) return false;
  if (!claimAlert(a)) return true;
  const opts = notifyOptions(a);
  if (_swReg) {
    // 走 Service Worker：安装为应用后，通知由本应用发出（图标/名称是看板自己的）
    _swReg.showNotification(a.title, opts).catch(() => popupFallback(a, opts));
    return true;
  }
  return popupFallback(a, opts);
}
