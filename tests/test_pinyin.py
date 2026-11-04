"""拼音首字母搜索索引（板块列表搜索用）。"""

from services.pinyin import initials


class TestInitials:
    def test_chinese_initials(self):
        assert initials("半导体") == "bdt"
        assert initials("融资融券") == "rzrq"
        assert initials("高带宽内存") == "gdknc"

    def test_mixed_text_keeps_alnum(self):
        assert initials("沪深300") == "hs300"
        assert initials("中证A500") == "zza500"
        assert initials("科创50ETF") == "kc50etf"

    def test_empty_and_non_chinese(self):
        assert initials("") == ""
        assert initials(None) == ""
        assert initials("BK0475") == "bk0475"

    def test_cache_is_transparent(self):
        # 缓存只是加速，重复调用必须给出同样结果
        assert initials("半导体") == initials("半导体")
