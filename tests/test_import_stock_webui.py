"""stock-webui 历史数据导入脚本（回归：分时图无数据）的测试。

用临时源库/目标库，不碰真实数据。
"""

import importlib.util
import os
import sqlite3

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "import_stock_webui.py")


def load_script():
    spec = importlib.util.spec_from_file_location("import_stock_webui", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def dbs(tmp_path):
    src_path = str(tmp_path / "src.db")
    dst_path = str(tmp_path / "dst.db")
    c = sqlite3.connect(src_path)
    c.executescript("""
    CREATE TABLE boards(code TEXT PRIMARY KEY, name TEXT, type TEXT);
    CREATE TABLE flow_points(date TEXT, code TEXT, time TEXT, flow REAL, PRIMARY KEY(date,code,time));
    CREATE TABLE rank_snapshots(date TEXT, code TEXT, name TEXT, type TEXT, flow REAL, PRIMARY KEY(date,code));
    CREATE TABLE etf_boards(code TEXT PRIMARY KEY, name TEXT, type TEXT);
    CREATE TABLE etf_flow_points(date TEXT, code TEXT, time TEXT, flow REAL, PRIMARY KEY(date,code,time));
    CREATE TABLE etf_rank_snapshots(date TEXT, code TEXT, name TEXT, type TEXT, flow REAL, PRIMARY KEY(date,code));
    CREATE TABLE em_flow_points(date TEXT, code TEXT, time TEXT,
        inst_flow REAL, large_flow REAL, medium_flow REAL, retail_flow REAL,
        PRIMARY KEY(date,code,time));
    """)
    c.executemany("INSERT INTO boards VALUES(?,?,?)", [("BK1", "甲", "concept"), ("BK2", "乙", "industry")])
    c.executemany("INSERT INTO flow_points VALUES(?,?,?,?)",
                  [("2026-11-04", "BK1", "09:31", 1.0), ("2026-11-04", "BK1", "09:32", 2.0)])
    c.executemany("INSERT INTO rank_snapshots VALUES(?,?,?,?,?)",
                  [("2026-11-04", "BK1", "甲", "concept", 2.0),
                   ("2026-11-04", "BK2", "乙", "industry", 5.0)])
    c.executemany("INSERT INTO etf_boards VALUES(?,?,?)",
                  [("sh510300", "沪深300ETF", "index"), ("sz159915", "创业板ETF", "industry")])
    c.executemany("INSERT INTO etf_flow_points VALUES(?,?,?,?)",
                  [("2026-11-04", "sh510300", "09:30", 3.0)])
    c.executemany("INSERT INTO etf_rank_snapshots VALUES(?,?,?,?,?)",
                  [("2026-11-04", "sh510300", "沪深300ETF", "index", 3.0)])
    c.executemany("INSERT INTO em_flow_points VALUES(?,?,?,?,?,?,?)",
                  [("2026-11-04", "1.000300", "09:30", 11.0, 22.0, 33.0, 44.0)])
    c.commit()
    c.close()
    return src_path, dst_path


def test_import_maps_schema_and_strips_prefix(dbs):
    src, dst = dbs
    mod = load_script()
    res = mod.run_import(dst, src, "2026-11-01")
    assert res["stats"]["flow_points"] == 2

    c = sqlite3.connect(dst)
    assert c.execute("SELECT code, type FROM etf_boards ORDER BY code").fetchall() == [
        ("159915", "sector"), ("510300", "broad")]
    assert c.execute("SELECT code, time, main FROM etf_flow_points").fetchall() == [("510300", "09:30", 3.0)]
    assert c.execute("SELECT code, inst, large, medium, retail FROM em_flow_points").fetchall() == [
        ("1.000300", 11.0, 22.0, 33.0, 44.0)]
    # 排行按类型分别编号
    assert c.execute("SELECT code, rank FROM rank_snapshots ORDER BY code").fetchall() == [
        ("BK1", 1), ("BK2", 1)]
    c.close()


def test_import_is_idempotent_and_keeps_existing_rank(dbs):
    src, dst = dbs
    mod = load_script()
    mod.run_import(dst, src, "2026-11-01")

    # 目标库已有该日排行（带真实 pct），再次导入不应覆盖
    c = sqlite3.connect(dst)
    c.execute("UPDATE rank_snapshots SET pct=9.9 WHERE date='2026-11-04'")
    c.commit()
    c.close()

    mod.run_import(dst, src, "2026-11-01")
    c = sqlite3.connect(dst)
    assert c.execute("SELECT COUNT(*) FROM flow_points").fetchone()[0] == 2
    assert c.execute("SELECT COUNT(*) FROM rank_snapshots").fetchone()[0] == 2
    assert c.execute("SELECT DISTINCT pct FROM rank_snapshots").fetchall() == [(9.9,)]
    c.close()


def test_missing_source_raises(tmp_path):
    mod = load_script()
    with pytest.raises(FileNotFoundError):
        mod.run_import(str(tmp_path / "dst.db"), str(tmp_path / "nope.db"), "2026-11-01")
