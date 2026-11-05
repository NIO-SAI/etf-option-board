"""财联社热门板块匹配的纯函数单测（不触网）。"""

import hashlib
import urllib.parse

from services import cls_hot


def test_sign_matches_cls_rule():
    params = {"app": "CailianpressWeb", "os": "web", "sv": "8.4.6", "name": "telegraphList"}
    qs = urllib.parse.urlencode(sorted(params.items()))
    expect = hashlib.md5(hashlib.sha1(qs.encode()).hexdigest().encode()).hexdigest()
    assert cls_hot.sign_params(params) == expect


class TestNormalizeName:
    def test_strips_suffix_and_space(self):
        assert cls_hot.normalize_name("半导体 概念") == "半导体"
        assert cls_hot.normalize_name("TOPCon电池板块") == "TOPCon电池"
        assert cls_hot.normalize_name("电池") == "电池"
        assert cls_hot.normalize_name("") == ""

    def test_keeps_suffix_when_name_is_only_suffix(self):
        assert cls_hot.normalize_name("概念") == "概念"


class TestMatchName:
    boards = [
        {"code": "BK1", "name": "半导体概念", "kind": "concept"},
        {"code": "BK2", "name": "电池", "kind": "industry"},
        {"code": "BK3", "name": "异质结电池", "kind": "concept"},
        {"code": "BK4", "name": "中字头", "kind": "concept"},
        {"code": "BK5", "name": "IT服务Ⅲ", "kind": "industry"},
    ]

    def test_exact_after_normalize(self):
        assert cls_hot.match_name("半导体", self.boards)["code"] == "BK1"
        assert cls_hot.match_name("中字头概念", self.boards)["code"] == "BK4"

    def test_containment_needs_half_overlap(self):
        # 「异质结电池」优先命中同名概念，而不是因为含「电池」命中 2 字行业
        assert cls_hot.match_name("异质结电池", self.boards)["code"] == "BK3"
        # 「IT服务」是「IT服务Ⅲ」的子串，长度占比够高才能命中
        assert cls_hot.match_name("IT服务", self.boards)["code"] == "BK5"

    def test_no_weak_match(self):
        assert cls_hot.match_name("AI玩具", self.boards) is None

    def test_empty_name(self):
        assert cls_hot.match_name("", self.boards) is None


class TestMatchAll:
    def test_dedup_and_source(self):
        names = [("半导体概念", "异动"), ("半导体", "热门概念"), ("中字头", "热门行业")]
        out = cls_hot.match_all(names, TestMatchName.boards)
        assert [r["code"] for r in out] == ["BK1", "BK4"]
        assert out[0]["source"] == "异动"
        assert out[0]["cls_name"] == "半导体概念"
