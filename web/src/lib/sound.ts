let ctx: AudioContext | null = null;

/** 浏览器自动播放策略：没有用户手势前 AudioContext 是 suspended，所有声音都是静音。
 *  首次 pointerdown/keydown 时补一次 resume（页面加载后很快就点，不影响后续告警）。 */
function unlock() {
  try {
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    /* ignore */
  }
}
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
}

function tone(freq: number, dur: number, type: OscillatorType, gain: number, delay = 0) {
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch {
    /* ignore */
  }
}

export const sound = {
  enabled: true,
  ding() {
    if (!this.enabled) return;
    tone(880, 0.18, "sine", 0.14);
    tone(1320, 0.22, "sine", 0.1, 0.08);
  },
  alert() {
    if (!this.enabled) return;
    tone(660, 0.16, "triangle", 0.16);
    tone(880, 0.16, "triangle", 0.16, 0.16);
    tone(1174, 0.26, "triangle", 0.16, 0.32);
  },
  critical() {
    if (!this.enabled) return;
    for (let i = 0; i < 3; i++) tone(1046, 0.12, "square", 0.12, i * 0.16);
    tone(1568, 0.3, "square", 0.12, 0.5);
  },
  play(level: string) {
    if (!this.enabled) return;
    const fire = () => {
      if (level === "critical") this.critical();
      else if (level === "warn") this.alert();
      else this.ding();
    };
    try {
      if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      // 首次告警早于用户手势时先恢复上下文再播放，否则振荡器跑在 suspended 上下文里没有声音
      if (ctx.state === "suspended") {
        ctx.resume().then(fire).catch(() => {});
        return;
      }
    } catch {
      /* 没有 AudioContext 时静默降级（toast 仍然可见） */
    }
    fire();
  },
};
