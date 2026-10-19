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

/** 弹一条浏览器通知；不可用或未授权时返回 false（由调用方兜底）。 */
export function showNotification(a: AlertLike): boolean {
  if (notifyPermission() !== "granted" || !a.title) return false;
  try {
    const n = new Notification(a.title, {
      body: a.text,
      tag: a.id != null ? `etf-alert-${a.id}` : undefined,
      // critical（主力资金 / 变盘）需要用户确认，不自动消失
      requireInteraction: a.level === "critical",
      silent: false,
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
