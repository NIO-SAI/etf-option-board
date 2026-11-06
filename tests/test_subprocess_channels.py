"""子进程通道的并发与管道约束（不触网：curl 与子进程全部打桩）。

两条回归：
1. em 的 IPv6 兜底通道：信号量必须覆盖「起进程 + 读结果」全程，
   否则注释里承诺的并发上限失效；
2. kronos 的 stderr 管道：必须有人持续消费，否则子进程写满缓冲后阻塞，
   表现为「推理超时且无日志」。
"""

import asyncio
import json
import sys
import time

from services import em
from services import kronos


def test_v6_semaphore_caps_concurrent_processes(monkeypatch):
    """9 个并发请求，同时在跑的 curl 进程数不得超过 _V6_SEM 的上限。"""
    state = {"live": 0, "peak": 0}

    class FakeProc:
        returncode = 0

        async def communicate(self):
            await asyncio.sleep(0.05)
            return json.dumps({"data": {"ok": 1}}).encode(), b""

    async def fake_exec(*args, **kwargs):
        # 在「进程创建瞬间」采样，修复前信号量在创建之后才抢，峰值会等于并发数
        state["live"] += 1
        state["peak"] = max(state["peak"], state["live"])
        return FakeProc()

    monkeypatch.setattr(em.asyncio, "create_subprocess_exec", fake_exec)
    # 命中 AAAA 缓存 → 跳过 DoH 解析；放开熔断阈值，避免干扰计数
    monkeypatch.setitem(em._V6_ADDR, "push2.eastmoney.com", ("2408::1", time.time() + 600))
    monkeypatch.setattr(em, "_V6_FAIL_LIMIT", 999)

    async def one():
        try:
            await em._curl_json_v6("https://push2.eastmoney.com/api/qt/stock/get")
        finally:
            state["live"] -= 1

    async def run():
        await asyncio.gather(*[one() for _ in range(9)])

    asyncio.run(run())
    assert state["peak"] <= em._V6_SEM._value  # noqa: SLF001 — 上限即信号量初值


def test_kronos_drains_stderr_so_child_never_blocks():
    """子进程狂写 stderr 时，只读 stdout 也应能拿到结果（修复前会卡到超时）。"""
    flood = (
        "import sys\n"
        "for i in range(4000):\n"
        "    sys.stderr.write('warn %d ' % i + 'x' * 80 + chr(10))\n"
        "sys.stderr.flush()\n"
        "print('{\"ok\": true}', flush=True)\n"
    )

    async def main():
        worker = kronos._Worker()  # noqa: SLF001 — 只测管道消费，不起真模型
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-u", "-c", flood,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        worker._stderr_task = asyncio.create_task(  # noqa: SLF001
            worker._drain_stderr(proc))  # noqa: SLF001
        try:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=20)
            await proc.wait()
            await asyncio.wait_for(worker._stderr_task, timeout=5)  # noqa: SLF001
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
        return line, worker

    line, worker = asyncio.run(main())
    assert json.loads(line.decode()) == {"ok": True}
    # 尾部 20 行保留，用于超时/失败时拼错误信息
    assert len(worker._stderr_tail) == 20  # noqa: SLF001
    assert worker._stderr_tail[-1].startswith("warn 3999")  # noqa: SLF001
    assert "warn 3999" in worker._stderr_hint()  # noqa: SLF001
