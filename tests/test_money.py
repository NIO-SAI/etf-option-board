"""资金金额口径：≥1 亿用「亿」，不足 1 亿用「万」（纯函数，不触网/不读时钟）。"""

import pytest

from services.money import money


class TestMoneyUnit:
    @pytest.mark.parametrize("v,expected", [
        (3.2e8, "3.20亿"),
        (1e8, "1.00亿"),          # 恰好 1 亿按亿
        (9_999_5000, "1.00亿"),   # 9999.5 万四舍五入后跨过 1 亿
        (5e7, "5000万"),
        (1.2e7, "1200万"),        # ≥100 万取整
        (3.5e6, "350万"),
        (3.2e4, "3.2万"),         # ≥1 万留 1 位
        (3.5e3, "0.35万"),        # 不足 1 万留 2 位，不抹成 0 万
        (0, "0.00万"),
    ])
    def test_units(self, v, expected):
        assert money(v) == expected

    def test_sign(self):
        assert money(1.23e8, sign=True) == "+1.23亿"
        assert money(-1.23e8, sign=True) == "-1.23亿"
        assert money(-5e7, sign=True) == "-5000万"
        assert money(0, sign=True) == "0.00万"

    def test_unsigned_is_absolute(self):
        # 配「流入/流出」文字时只取绝对值，符号由文字表达
        assert money(-5e7) == "5000万"

    @pytest.mark.parametrize("bad", [None, "abc", float("nan"), float("inf")])
    def test_invalid(self, bad):
        assert money(bad) == "—"
