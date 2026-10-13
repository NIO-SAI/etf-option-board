"""标的宇宙：9 只可交易期权的 ETF、期权链前缀、关联指数、外围市场。

东财 secid 约定：
  上交所 1.xxxxxx   深交所 0.xxxxxx   全球指数 100.XXX
  期权市场：上交所 10，深交所 12
"""

# ---- 9 只 ETF 期权标的 --------------------------------------------------
# prefix 为东财期权简称前缀（用于把 m:10 / m:12 全量期权列表切分为各标的的链）
ETFS = [
    # code,        secid,       market, name,                  option_prefix, exchange
    {"code": "510050", "secid": "1.510050", "opt_market": 10, "name": "上证50ETF华夏",     "prefix": "50ETF",       "exch": "SH", "track": "上证50"},
    {"code": "510300", "secid": "1.510300", "opt_market": 10, "name": "沪深300ETF华泰柏瑞", "prefix": "300ETF",      "exch": "SH", "track": "沪深300"},
    {"code": "510500", "secid": "1.510500", "opt_market": 10, "name": "中证500ETF南方",     "prefix": "500ETF",      "exch": "SH", "track": "中证500"},
    {"code": "588000", "secid": "1.588000", "opt_market": 10, "name": "科创50ETF华夏",      "prefix": "科创50",       "exch": "SH", "track": "科创50"},
    {"code": "588080", "secid": "1.588080", "opt_market": 10, "name": "科创50ETF易方达",    "prefix": "科创板50",     "exch": "SH", "track": "科创50"},
    {"code": "159919", "secid": "0.159919", "opt_market": 12, "name": "沪深300ETF嘉实",     "prefix": "沪深300ETF",   "exch": "SZ", "track": "沪深300"},
    {"code": "159915", "secid": "0.159915", "opt_market": 12, "name": "创业板ETF易方达",    "prefix": "创业板ETF",    "exch": "SZ", "track": "创业板指"},
    {"code": "159922", "secid": "0.159922", "opt_market": 12, "name": "中证500ETF嘉实",     "prefix": "中证500ETF",   "exch": "SZ", "track": "中证500"},
    {"code": "159901", "secid": "0.159901", "opt_market": 12, "name": "深证100ETF易方达",   "prefix": "深证100ETF",   "exch": "SZ", "track": "深证100"},
]

ETF_BY_CODE = {e["code"]: e for e in ETFS}

# 前缀 → ETF（用于期权链归属；按长度倒序匹配，避免「科创50」误吞「科创板50」）
PREFIX_TO_ETF = {e["prefix"]: e for e in ETFS}


def etf_of_prefix(name: str) -> dict | None:
    for e in sorted(ETFS, key=lambda x: -len(x["prefix"])):
        if name.startswith(e["prefix"]):
            return e
    return None


# ---- 关联宽基指数 -------------------------------------------------------
INDICES = [
    {"secid": "1.000001", "name": "上证指数",   "short": "上证"},
    {"secid": "1.000016", "name": "上证50",     "short": "上证50"},
    {"secid": "1.000300", "name": "沪深300",    "short": "沪深300"},
    {"secid": "1.000905", "name": "中证500",    "short": "中证500"},
    {"secid": "1.000852", "name": "中证1000",   "short": "中证1000"},
    {"secid": "1.000688", "name": "科创50",     "short": "科创50"},
    {"secid": "0.399006", "name": "创业板指",   "short": "创业板"},
    {"secid": "0.399001", "name": "深证成指",   "short": "深证成指"},
    {"secid": "1.000985", "name": "中证全指",   "short": "全A"},
    {"secid": "0.899050", "name": "北证50",     "short": "北证50"},
]

# 与各标的关联的指数（判断期权方向与指数正相关）
TRACK_INDEX = {
    "上证50": "1.000016",
    "沪深300": "1.000300",
    "中证500": "1.000905",
    "科创50": "1.000688",
    "创业板指": "0.399006",
    "深证100": "0.399001",
}

# ---- 外围市场因子 -------------------------------------------------------
EXTERNAL = [
    {"secid": "100.NDX",  "name": "纳斯达克100", "key": "ndx"},
    {"secid": "100.SPX",  "name": "标普500",     "key": "spx"},
    {"secid": "100.DJIA", "name": "道琼斯",      "key": "dji"},
    {"secid": "100.HSI",  "name": "恒生指数",    "key": "hsi"},
    {"secid": "100.N225", "name": "日经225",     "key": "n225"},
    {"secid": "100.UDI",  "name": "美元指数",    "key": "dxy"},
    {"secid": "101.GC00Y", "name": "COMEX黄金",  "key": "gold"},
    {"secid": "102.CL00Y", "name": "NYMEX原油",  "key": "oil"},
    {"secid": "100.BDI",  "name": "波罗的海BDI", "key": "bdi"},
]

# 国家队护盘常买的宽基 ETF（判断护盘信号）
NATIONAL_TEAM_ETFS = [
    {"code": "510300", "secid": "1.510300", "name": "沪深300ETF"},
    {"code": "510050", "secid": "1.510050", "name": "上证50ETF"},
    {"code": "510500", "secid": "1.510500", "name": "中证500ETF"},
    {"code": "512100", "secid": "1.512100", "name": "中证1000ETF"},
    {"code": "159919", "secid": "0.159919", "name": "沪深300ETF嘉实"},
    {"code": "588000", "secid": "1.588000", "name": "科创50ETF"},
    {"code": "159915", "secid": "0.159915", "name": "创业板ETF"},
]

# 国家队护盘常拉动的板块（东财板块代码）
NATIONAL_TEAM_BOARDS = {
    "银行": "BK0475",
    "证券": "BK0473",
    "保险": "BK0474",
    "白酒": "BK0896",
    "食品饮料": "BK0438",
}
