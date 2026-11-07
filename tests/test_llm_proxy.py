"""临时代理的纯协议校验：敏感输入不进入 URL、正文或错误信息，不触网。"""

import copy

import pytest

from services.llm_proxy import request_parts


def config(**changes):
    return {"protocol": "openai", "baseUrl": "https://model.example/v1", "model": "test-model",
            "apiKey": "test-only-key", "system": "测试系统提示", "user": "测试用户提示", **changes}


def test_openai_credentials_are_only_in_authorization():
    data = config(headers={"Cookie": "不应转发"}, max_tokens=999999)
    before = copy.deepcopy(data)
    url, headers, body = request_parts(data)
    assert url == "https://model.example/v1/chat/completions"
    assert headers["Authorization"] == "Bearer test-only-key"
    assert "test-only-key" not in url + str(body)
    assert not {"Cookie", "Referer", "Origin"} & headers.keys()
    assert body["max_tokens"] == 16384 and body["stream"] is False
    assert [m["role"] for m in body["messages"]] == ["system", "user"]
    assert data == before


def test_anthropic_protocol_and_test_budget():
    url, headers, body = request_parts(config(protocol="anthropic", baseUrl="https://model.example", test=True))
    assert url == "https://model.example/v1/messages"
    assert headers["x-api-key"] == "test-only-key"
    assert headers["anthropic-version"] == "2023-06-01"
    assert "Authorization" not in headers and "anthropic-dangerous-direct-browser-access" not in headers
    assert body["system"] == "测试系统提示"
    assert body["messages"] == [{"role": "user", "content": "测试用户提示"}]
    assert body["max_tokens"] == 4096


@pytest.mark.parametrize("protocol", ["openai", "anthropic"])
@pytest.mark.parametrize("test", [False, True])
def test_configured_budget_is_used_for_both_decision_and_connection(protocol, test):
    _, _, body = request_parts(config(protocol=protocol, test=test, maxTokens=32768))
    assert body["max_tokens"] == 32768


@pytest.mark.parametrize("budget", [None, True, 0, 1023, 65537, 4096.5, "test-only-key"])
def test_invalid_budget_is_rejected_without_echoing_input(budget):
    with pytest.raises(ValueError, match="最大输出 Token") as exc:
        request_parts(config(maxTokens=budget))
    assert "test-only-key" not in str(exc.value)


@pytest.mark.parametrize("budget", [1024, 65536])
def test_budget_bounds_are_accepted(budget):
    assert request_parts(config(maxTokens=budget))[2]["max_tokens"] == budget


@pytest.mark.parametrize("base", ["https://model.example", "https://model.example/v1/",
                                  "https://model.example/v1/chat/completions/"])
def test_root_base_and_full_endpoint_are_equivalent(base):
    assert request_parts(config(baseUrl=base))[0] == "https://model.example/v1/chat/completions"


def test_custom_prefix_and_optional_key_for_local_model():
    url, headers, _ = request_parts(config(baseUrl="http://127.0.0.1:8000/custom/v1", apiKey=""))
    assert url == "http://127.0.0.1:8000/custom/v1/chat/completions"
    assert "Authorization" not in headers


@pytest.mark.parametrize("change", [
    {"baseUrl": "file:///tmp/test-only-key"},
    {"baseUrl": "https://user:test-only-key@model.example"},
    {"baseUrl": "https://model.example/v1?api_key=test-only-key"},
    {"baseUrl": "https://model.example/v1#test-only-key"},
    {"baseUrl": "https://model.example:test-only-key/v1"},
    {"baseUrl": "https://model.example/\ntest-only-key"},
    {"baseUrl": "https://model.example/v1/messages"},
    {"apiKey": "test-only-key\r\nInjected: true"},
    {"apiKey": {"token": "test-only-key"}},
    {"protocol": "test-only-key"},
    {"model": ""},
    {"user": "x" * 262145},
    {"test": "test-only-key"},
])
def test_validation_errors_never_echo_sensitive_input(change):
    with pytest.raises(ValueError) as exc:
        request_parts(config(**change))
    assert "test-only-key" not in str(exc.value)


@pytest.mark.parametrize("data", [None, [], "test-only-key"])
def test_invalid_envelope_has_constant_error(data):
    with pytest.raises(ValueError, match="代理请求必须是 JSON 对象"):
        request_parts(data)
