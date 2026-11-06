"""Kronos 时序预测推理桥 —— 复用 facecat-kronos 常驻子进程（JSON 行协议）。

与 stock-webui/services/kronos.py 同构：不阻塞事件循环，子进程不可用时降级返回 error。
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import os

from config import settings

log = logging.getLogger("kronos")

KRONOS_REPO = settings.kronos_repo
KRONOS_PYTHON = settings.kronos_python
KRONOS_CACHE = settings.kronos_cache
PREDICT_TIMEOUT = settings.kronos_timeout


def available() -> bool:
    return (
        os.path.exists(KRONOS_PYTHON)
        and os.path.isdir(KRONOS_CACHE)
        and os.path.exists(f"{KRONOS_REPO}/model")
    )


class _Worker:
    def __init__(self) -> None:
        self._proc: asyncio.subprocess.Process | None = None
        self._stderr_task: asyncio.Task | None = None
        self._stderr_tail: list[str] = []
        self._lock = asyncio.Lock()
        self._load_lock = asyncio.Lock()
        self._req_id = 0

    async def _ensure(self) -> asyncio.subprocess.Process:
        if self._proc is not None and self._proc.returncode is None:
            return self._proc
        async with self._load_lock:
            if self._proc is not None and self._proc.returncode is None:
                return self._proc
            if not available():
                raise RuntimeError(f"Kronos 推理环境未就位（{KRONOS_PYTHON} / {KRONOS_CACHE}）")
            env = dict(os.environ)
            env["PYTHONUNBUFFERED"] = "1"
            env["KRONOS_CACHE"] = KRONOS_CACHE
            self._proc = await asyncio.create_subprocess_exec(
                KRONOS_PYTHON, "-u", "-m", "services.kronos_worker",
                cwd=KRONOS_REPO, env=env,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, limit=1 << 20,
            )
            self._stderr_task = asyncio.create_task(self._drain_stderr(self._proc))
            log.info("Kronos 子进程已启动 pid=%s", self._proc.pid)
            return self._proc

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        """持续消费子进程 stderr，避免管道写满后子进程阻塞在写操作上。

        模型加载时 transformers/torch 会往 stderr 打大量 warning，超过管道缓冲
        （Linux 64KB）后子进程 write 阻塞，主进程等 stdout 永远等不到，表现为
        「推理超时且日志无任何线索」。这里全程读空，只留尾部供报错时定位。
        """
        tail: collections.deque[str] = collections.deque(maxlen=20)
        try:
            while True:
                line = await proc.stderr.readline()
                if not line:
                    break
                text = line.decode("utf-8", "replace").rstrip()
                if text:
                    tail.append(text)
                    log.debug("kronos stderr: %s", text)
        except Exception:  # noqa: BLE001 — 读取失败不应影响推理主流程
            pass
        finally:
            self._stderr_tail = list(tail)

    def _stderr_hint(self) -> str:
        """把 stderr 尾部拼进错误信息，便于排查模型加载失败。"""
        if not self._stderr_tail:
            return ""
        return "；子进程 stderr 末行: " + self._stderr_tail[-1][:300]

    def _cancel_stderr(self) -> None:
        task, self._stderr_task = self._stderr_task, None
        if task is not None and not task.done():
            task.cancel()

    async def close(self) -> None:
        if self._proc is None or self._proc.returncode is not None:
            return
        try:
            self._proc.stdin.close()
            await asyncio.wait_for(self._proc.wait(), timeout=5)
        except Exception:  # noqa: BLE001
            try:
                self._proc.kill()
            except Exception:  # noqa: BLE001
                pass
        finally:
            self._cancel_stderr()

    async def call(self, payload: dict, timeout: int = PREDICT_TIMEOUT) -> dict:
        async with self._lock:
            proc = await self._ensure()
            self._req_id += 1
            payload = {**payload, "id": self._req_id}
            try:
                proc.stdin.write((json.dumps(payload) + "\n").encode())
                await proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                self._proc = None
                raise RuntimeError("Kronos 子进程连接中断")
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
            except asyncio.TimeoutError:
                hint = self._stderr_hint()
                await self._reset()
                raise RuntimeError(f"Kronos 推理超时（>{timeout}s）{hint}")
            if not line:
                await self._reset()
                raise RuntimeError("Kronos 子进程无响应")
            resp = json.loads(line)
            if not resp.get("ok"):
                raise RuntimeError(resp.get("error") or "Kronos 推理失败")
            return resp.get("result", {})

    async def _reset(self) -> None:
        proc, self._proc = self._proc, None
        self._cancel_stderr()
        if proc and proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except Exception:  # noqa: BLE001
                pass


_WORKER = _Worker()


async def warmup() -> None:
    if not available():
        log.warning("Kronos 环境未就位，跳过预热")
        return
    try:
        await _WORKER.call({"op": "ping"}, timeout=300)
        log.info("Kronos 模型预热完成")
    except Exception as exc:  # noqa: BLE001
        log.warning("Kronos 预热失败（不影响功能）: %s", exc)


async def shutdown() -> None:
    await _WORKER.close()


async def predict(bars: list[dict], lookback: int = 120, pred_len: int = 20,
                  temperature: float = 1.0, top_p: float = 0.9,
                  frequency: str = "1m") -> dict:
    """bars: [{date, open, high, low, close, volume, amount}] 时间升序。

    日内分时预测：lookback 40~200，pred_len 10~40，frequency "1m"/"3m"/"5m"。
    """
    if not available():
        return {"error": "Kronos 推理环境未就位"}
    lookback = max(20, min(int(lookback), 400))
    pred_len = max(1, min(int(pred_len), 120))
    if len(bars) < lookback:
        return {"error": f"K线不足：需 {lookback} 根，实际 {len(bars)} 根"}
    try:
        res = await _WORKER.call({
            "op": "predict", "bars": bars[-lookback:],
            "lookback": lookback, "pred_len": pred_len,
            "temperature": float(temperature), "top_p": float(top_p),
            "frequency": frequency,
        })
        return res
    except Exception as exc:  # noqa: BLE001
        log.warning("Kronos 推理失败: %s", exc)
        return {"error": str(exc)}


def summarize(pred: dict, base_price: float) -> dict:
    """把 Kronos 预测压缩成方向/幅度/路径摘要。"""
    rows = (pred or {}).get("predictions") or []
    if not rows:
        return {"ok": False, "error": pred.get("error", "无预测")}
    closes = [r["close"] for r in rows]
    last = closes[-1]
    hi = max(r["high"] for r in rows)
    lo = min(r["low"] for r in rows)
    up = sum(1 for c in closes if c > base_price)
    return {
        "ok": True,
        "base": base_price,
        "pred_close": last,
        "pred_high": hi,
        "pred_low": lo,
        "pred_pct": round((last / base_price - 1) * 100, 2) if base_price else None,
        "bias": "up" if last > base_price else "down" if last < base_price else "flat",
        "up_ratio": round(up / len(closes), 2),
        "path": closes,
    }
