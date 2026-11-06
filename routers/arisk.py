"""arisk 风险监控面板接入（外部项目 `~/workspace/arisk` 的同源外壳）。

把 a-share-risk-monitor 的单文件 HTML 面板原样嵌进本看板，作为一个独立一级导航页
（`#/arisk`，前端页面 `web/src/pages/Arisk.tsx` 用 iframe 承载）。

为什么不让 iframe 直接连 arisk 的 8788：
- 面板里把实时接口硬编码成 `http://localhost:8899/...`，换成别的设备访问（Tailscale /
  局域网）时 `localhost` 指向客户端，接口全挂；走 HTTPS 入口还会被「混合内容」拦掉。
- 所以这里由本后端把 **HTML + 日更数据 + 实时接口** 一起收成同源：
    * `GET  /arisk/page`         面板 HTML（改写外部依赖为同源路径后返回，no-store）
    * `GET  /arisk/data.json`    日更数据 `arisk_data.json`（直接读磁盘，不走 8788）
    * `ANY  /arisk/live/<path>`  反代 arisk 本地实时代理 `127.0.0.1:8899`
    * `GET  /arisk/chart.umd.js` Chart.js 静态资源（`web/public/arisk/chart.umd.js`，构建带出）

arisk 自己的采集/更新链路（LaunchAgent `com.arisk.update` + `update_arisk_data.py`）
保持独立运行，本项目只读不写，所以上游 `git pull` 不会影响这里。
环境变量：`ARISK_DIR`（默认 `~/workspace/arisk`）、`ARISK_LIVE`（默认 `http://127.0.0.1:8899`）。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response

log = logging.getLogger("arisk")

router = APIRouter(prefix="/arisk", tags=["arisk"])

ARISK_DIR = Path(os.environ.get("ARISK_DIR", str(Path.home() / "workspace" / "arisk")))
ARISK_LIVE = os.environ.get("ARISK_LIVE", "http://127.0.0.1:8899").rstrip("/")

_HTML_NAME = "arisk_monitor_local.html"
_DATA_NAME = "arisk_data.json"

# HTML 内的外部依赖 → 同源路径。顺序敏感：先做具体串替换，最后再做域名级替换。
_REWRITES: list[tuple[str, str]] = [
    # Chart.js：构建时随 web/public/arisk 一起出（离线可用，避开 cdnjs 在国内的抖动）
    (
        "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js",
        "/arisk/chart.umd.js",
    ),
    # 日更数据：改成后端直读磁盘，不再依赖 8788 静态服务器
    ("'./arisk_data.json'", "'/arisk/data.json'"),
    ('"./arisk_data.json"', '"/arisk/data.json"'),
    # 实时接口：硬编码的 localhost:8899 → 同源反代
    ("http://localhost:8899", "/arisk/live"),
    ("http://127.0.0.1:8899", "/arisk/live"),
]

_NO_STORE = {"Cache-Control": "no-store"}


def _rewrite_html(html: str) -> str:
    for old, new in _REWRITES:
        html = html.replace(old, new)
    # Google Fonts 的 @import：国内常年超时，会拖住首屏；改用系统等宽字体兜底
    kept = [ln for ln in html.splitlines() if "fonts.googleapis.com" not in ln]
    return "\n".join(kept)


@router.get("/page", response_class=HTMLResponse)
async def page() -> Response:
    """面板 HTML（依赖改写后的同源版）。"""
    src = ARISK_DIR / _HTML_NAME
    try:
        html = src.read_text(encoding="utf-8")
    except OSError as exc:
        log.warning("arisk 面板读取失败 %s: %s", src, exc)
        return JSONResponse(
            {"error": f"找不到 arisk 面板：{src}", "hint": "确认 ~/workspace/arisk 存在"},
            status_code=200,
            headers=_NO_STORE,
        )
    return HTMLResponse(_rewrite_html(html), headers=_NO_STORE)


@router.get("/data.json")
async def data_json() -> Response:
    """日更数据快照（arisk update 脚本写盘后立刻生效，不缓存）。"""
    src = ARISK_DIR / _DATA_NAME
    try:
        raw = src.read_bytes()
    except OSError as exc:
        log.warning("arisk 数据读取失败 %s: %s", src, exc)
        return JSONResponse({"error": f"找不到 arisk 数据：{src}"}, headers=_NO_STORE)
    return Response(raw, media_type="application/json; charset=utf-8", headers=_NO_STORE)


@router.api_route("/live/{path:path}", methods=["GET", "POST", "OPTIONS"])
async def live(path: str, request: Request) -> Response:
    """反代 arisk 本地实时代理（浏览器端不能跨设备访问 localhost:8899）。

    上游异常一律降级成 `{"error": ...}` 的 200，前端代码本身有 `r.ok` 判断与静态兜底，
    不会因为代理没起就把整页打空。
    """
    url = f"{ARISK_LIVE}/{path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"
    body = await request.body() if request.method == "POST" else None
    headers = {}
    ctype = request.headers.get("content-type")
    if ctype:
        headers["content-type"] = ctype
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            upstream = await client.request(request.method, url, content=body, headers=headers)
    except Exception as exc:  # noqa: BLE001
        log.warning("arisk 实时代理不可用 %s: %s", url, exc)
        return JSONResponse(
            {"error": f"arisk 实时代理不可用（{ARISK_LIVE}）", "detail": str(exc)},
            headers=_NO_STORE,
        )
    return Response(
        upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/json"),
        headers=_NO_STORE,
    )
