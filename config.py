"""ETF 期权日内决策看板 — 配置集中管理。"""

import os
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Settings:
    # Server
    host: str = "127.0.0.1"
    port: int = 6799

    # Paths
    data_dir: str = "data"

    # HTTP
    http_timeout: float = 6.0
    user_agent: str = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )

    # 东方财富 token / referer
    em_token: str = "b2884a393a55266487d223057490786e"

    # Kronos 本地预测模型（facecat-kronos 仓库）
    kronos_repo: str = field(default_factory=lambda: os.getenv("KRONOS_REPO", "/Users/xinxin/workspace/facecat-kronos"))
    kronos_python: str = field(default_factory=lambda: os.getenv("KRONOS_PYTHON", "/Users/xinxin/workspace/facecat-kronos/.venv/bin/python3"))
    kronos_cache: str = field(default_factory=lambda: os.getenv("KRONOS_CACHE", "/Users/xinxin/workspace/facecat-kronos/model/hf-cache"))
    kronos_timeout: int = 180

    # LLM 决策（opencode zen / OpenAI 兼容端点）
    llm_api_base: str = field(default_factory=lambda: os.getenv("LLM_API_BASE", "https://opencode.ai/zen/go/v1"))
    llm_model: str = field(default_factory=lambda: os.getenv("LLM_MODEL", "deepseek-v4.1-flash"))
    llm_timeout: int = 120
    llm_auth_json: str = field(default_factory=lambda: os.path.expanduser("~/.local/share/opencode/auth.json"))
    llm_auth_key: str = field(default_factory=lambda: os.getenv("LLM_API_KEY", ""))

    # 无风险利率（期权定价用，年化）
    risk_free_rate: float = 0.018

    # 监控轮询间隔（秒）
    poll_interval: int = 3
    # 交易时段
    session_am = ("09:30", "11:30")
    session_pm = ("13:00", "15:00")

    # 关键变盘时点（HH:MM）
    key_times: tuple = ("10:30", "11:30", "13:00", "14:30")

    @property
    def etf_root(self) -> str:
        return os.path.dirname(os.path.abspath(__file__))


settings = Settings()
