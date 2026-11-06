"""全A逐笔分档的纯函数单测（不触网、不读时钟、不写盘）。"""

from services import tape_flow as tf


def test_minute_of_clamps_to_session():
    assert tf.minute_of("09:15:00") == "09:30"      # 集合竞价并到开盘
    assert tf.minute_of("09:30:00") == "09:30"
    assert tf.minute_of("10:03:59") == "10:03"
    assert tf.minute_of("11:45:00") == "11:30"      # 午休并入上午收盘
    assert tf.minute_of("12:59:00") == "11:30"
    assert tf.minute_of("14:59:00") == "14:59"
    assert tf.minute_of("15:19:58") == "15:00"      # 盘后固定价格并入收盘
    assert tf.minute_of("") is None
    assert tf.minute_of("abc") is None


def test_parse_tick_direction_and_amount():
    # 东财字段：time,price,volume(手),笔数,direction；"2"=主动买、"1"=主动卖、"4"=集合竞价
    assert tf.parse_tick("10:00:00,10.00,3,2,2") == ("10:00", 3000.0, 1)
    assert tf.parse_tick("10:00:00,10.00,3,2,1") == ("10:00", 3000.0, -1)
    assert tf.parse_tick("09:15:00,10.00,100,0,4") is None
    assert tf.parse_tick("10:00:00,10.00,0,0,2") is None
    assert tf.parse_tick("garbage") is None


def test_bin_of_boundaries():
    assert tf.bin_of(0) == 0
    assert tf.bin_of(9_000) == 0            # 0.9 万 < 第一档 1 万
    assert tf.bin_of(10_000) == 1           # 正好 1 万
    assert tf.bin_of(200_000) == tf.CUTS.index(20) + 1
    assert tf.bin_of(500_000_000) == len(tf.CUTS)   # 超过最大档并入末档


def test_norm_thresholds_sorts_and_appends_zero():
    assert tf.norm_thresholds([50, 200, 200, "x", -3]) == [200.0, 50.0, 0.0]
    assert tf.norm_thresholds([]) == [0.0]


def test_norm_thresholds_snap_to_bin_edges():
    # 140 万吸附到 150 万档（档位表里没有 140），50 万本身就在边界上
    assert tf.norm_thresholds([140, 50]) == [150.0, 50.0, 0.0]
    assert tf.snap_threshold(0) == 0.0
    assert tf.snap_threshold(99999) == float(tf.CUTS[-1])


def test_bucket_of_bin():
    ths = [200.0, 50.0, 0.0]
    assert tf.bucket_of_bin(tf.bin_of(3_000_000), ths) == 0     # 300 万 → 主力
    assert tf.bucket_of_bin(tf.bin_of(1_000_000), ths) == 1     # 100 万 → 跟风
    assert tf.bucket_of_bin(tf.bin_of(100_000), ths) == 2       # 10 万 → 散户
    assert tf.bucket_of_bin(0, ths) == 2                        # 最小档也是散户


def test_summarize_buy_sell_net_and_share():
    rows = [
        ("09:31", tf.bin_of(3_000_000), 300.0, 100.0),   # 主力
        ("09:32", tf.bin_of(1_000_000), 50.0, 70.0),     # 跟风
        ("09:33", tf.bin_of(100_000), 10.0, 30.0),       # 散户
    ]
    out = tf.summarize(rows, [200, 50])
    assert [round(x["net"], 1) for x in out] == [200.0, -20.0, -20.0]
    assert [round(x["buy"], 1) for x in out] == [300.0, 50.0, 10.0]
    assert abs(sum(x["share"] for x in out) - 1.0) < 1e-9


def test_cumulative_carries_forward():
    axis = ["09:30", "09:31", "09:32"]
    rows = [("09:31", tf.bin_of(3_000_000), 100.0, 0.0)]
    out = tf.cumulative(rows, [200, 50], axis)
    assert [row[0] for row in out] == [0.0, 100.0, 100.0]   # 缺分钟用前值
    assert out[-1][2] == 0.0


def test_session_axis_length():
    axis = tf.session_axis()
    assert len(axis) == 242                       # 09:30–11:30 与 13:00–15:00 各 121 点
    assert axis[0] == "09:30" and axis[120] == "11:30"
    assert axis[121] == "13:00" and axis[-1] == "15:00"


def test_coverage_and_amount_checks():
    assert tf.coverage_ok(950, 1000) is True
    assert tf.coverage_ok(900, 1000) is True
    assert tf.coverage_ok(899, 1000) is False
    assert tf.coverage_ok(0, 0) is False
    assert tf.amount_ok(100.0, 101.0) is True
    assert tf.amount_ok(100.0, 110.0) is False
    assert tf.amount_ok(100.0, 0.0) is False


def test_presets_thresholds_are_descending():
    for spec in tf.PRESETS.values():
        ths = [b["thr"] for b in spec["buckets"]]
        assert ths == sorted(ths, reverse=True)
        assert ths[-1] == 0
