"""Shared oracle vectors and all proxy endpoint mappings; never contacts a real chain."""

import base64
import json
import re
from dataclasses import asdict
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import aiohttp
import pytest

from o2_sdk import (
    BridgeApiError,
    FastBridgeClient,
    parse_evm_unsigned_transaction,
    parse_fuel_unsigned_transaction,
    parse_preparation_proof,
)
from o2_sdk.bridge import models as m
from o2_sdk.crypto import fuel_compact_sign

ROOT = Path(__file__).resolve().parents[3] / "fixtures" / "bridge"
VECTORS = json.loads((ROOT / "transactions.json").read_text())
HTTP = json.loads((ROOT / "http.json").read_text())


@pytest.mark.parametrize("vector", VECTORS["invalidEvm"], ids=lambda v: v["name"])
def test_invalid_evm(vector):
    with pytest.raises(ValueError):
        parse_evm_unsigned_transaction(vector["unsignedTransaction"])


@pytest.mark.parametrize("vector", VECTORS["invalidFuel"], ids=lambda v: v["name"])
def test_invalid_fuel(vector):
    with pytest.raises(ValueError):
        parse_fuel_unsigned_transaction(vector["unsignedTransaction"], 0, 255)


def camel(name):
    first, *rest = name.split("_")
    return first + "".join(s.title() for s in rest)


def normalize(value):
    if isinstance(value, dict):
        return {camel(k): normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    return value


def assert_expected(result, expected):
    for key, value in expected.items():
        if isinstance(value, dict):
            assert_expected(result[key], value)
        else:
            actual = result[key]
            if isinstance(value, str) and re.fullmatch(r"[0-9]+", value):
                actual = str(actual)
            assert actual == value


@pytest.mark.parametrize("vector", VECTORS["evm"])
def test_evm_oracle(vector):
    result = parse_evm_unsigned_transaction(vector["unsignedTransaction"])
    assert_expected(normalize(asdict(result)), vector["expected"])
    compact = bytearray(
        fuel_compact_sign(bytes.fromhex("11" * 32), bytes.fromhex(result.signing_digest[2:]))
    )
    v = 27 + (compact[32] >> 7)
    compact[32] &= 127
    assert "0x" + (compact + bytes([v])).hex() == vector["signature"]


@pytest.mark.parametrize("vector", VECTORS["fuel"])
def test_fuel_oracle(vector):
    result = parse_fuel_unsigned_transaction(
        vector["unsignedTransaction"], int(vector["fuelChainId"]), vector["fuelMaxInputs"]
    )
    assert_expected(normalize(asdict(result)), vector["expected"])
    assert [i.type for i in result.inputs] == ["coin", "contract", "message"]
    assert result.outputs[2].amount == 2345
    signature = fuel_compact_sign(
        bytes.fromhex("11" * 32), bytes.fromhex(result.transaction_id[2:])
    )
    assert "0x" + signature.hex() == vector["signature"]


def test_proof_decode_is_not_authentication():
    for vector in VECTORS["proofs"]:
        assert normalize(asdict(parse_preparation_proof(vector["proof"]))) == vector["claims"]
    claims = dict(VECTORS["proofs"][0]["claims"], expiresAt=1)
    proof = (
        base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        + "."
        + base64.urlsafe_b64encode(bytes(32)).decode().rstrip("=")
    )
    assert parse_preparation_proof(proof).expires_at == 1


def test_malformed_inputs():
    for proof in ["", "a.b", "x" * 2049, VECTORS["proofs"][0]["proof"] + "."]:
        with pytest.raises(ValueError):
            parse_preparation_proof(proof)
    for vector in VECTORS["evm"] + VECTORS["fuel"][:1]:

        def parse(value, vector=vector):
            return (
                parse_fuel_unsigned_transaction(value, 0, 255)
                if "fuelChainId" in vector
                else parse_evm_unsigned_transaction(value)
            )

        raw = vector["unsignedTransaction"]
        for end in range(2, len(raw), 2):
            with pytest.raises(ValueError):
                parse(raw[:end])
        with pytest.raises(ValueError):
            parse(raw + "00")
    raw = bytearray.fromhex(VECTORS["fuel"][0]["unsignedTransaction"][2:])
    raw[104] ^= 255
    with pytest.raises(ValueError):
        parse_fuel_unsigned_transaction("0x" + raw.hex(), 0, 255)


async def test_all_endpoints():
    session = MagicMock(spec=aiohttp.ClientSession)
    index = 0

    def request(method, url, **kwargs):
        nonlocal index
        fixture = HTTP[index]
        index += 1
        assert method == fixture["method"]
        assert url == "https://bridge.example/proxy" + fixture["path"]
        assert kwargs["json"] == fixture.get("body")
        assert kwargs["params"] == {k: str(v) for k, v in fixture.get("query", {}).items()}
        assert kwargs["allow_redirects"] is False
        response = MagicMock()
        response.status = 202 if fixture["path"].endswith("/submit") else 200
        response.text = AsyncMock(return_value=json.dumps(fixture["response"]))
        context = MagicMock()
        context.__aenter__ = AsyncMock(return_value=response)
        context.__aexit__ = AsyncMock(return_value=None)
        return context

    session.request.side_effect = request
    client = FastBridgeClient("https://bridge.example/proxy/", session=session)
    result = await client.get_info()
    assert result.to_dict() == HTTP[0]["response"]
    result = await client.get_assets(HTTP[1]["query"]["chainId"])
    assert result.to_dict() == HTTP[1]["response"]
    result = await client.get_deposit_info(
        HTTP[2]["query"]["sourceChainId"], HTTP[2]["query"]["assetId"], HTTP[2]["query"]["amount"]
    )
    assert result.to_dict() == HTTP[2]["response"]
    result = await client.prepare_deposit(m.DepositPrepareRequest.from_dict(HTTP[3]["body"]))
    assert result.to_dict() == HTTP[3]["response"]
    result = await client.submit_deposit(m.SubmitRequest.from_dict(HTTP[4]["body"]))
    assert result.to_dict() == HTTP[4]["response"]
    result = await client.get_deposit_status(
        HTTP[5]["query"]["sourceChainId"], HTTP[5]["query"]["evmTxHash"]
    )
    assert result.to_dict() == HTTP[5]["response"]
    result = await client.get_withdraw_info(
        HTTP[6]["query"]["destinationChainId"],
        HTTP[6]["query"]["assetId"],
        HTTP[6]["query"]["amount"],
    )
    assert result.to_dict() == HTTP[6]["response"]
    result = await client.get_withdraw_fee(
        HTTP[7]["query"]["destinationChainId"], HTTP[7]["query"]["assetId"]
    )
    assert result.to_dict() == HTTP[7]["response"]
    result = await client.prepare_withdraw(m.WithdrawPrepareRequest.from_dict(HTTP[8]["body"]))
    assert result.to_dict() == HTTP[8]["response"]
    result = await client.submit_withdraw(m.SubmitRequest.from_dict(HTTP[9]["body"]))
    assert result.to_dict() == HTTP[9]["response"]
    result = await client.get_withdraw_status(HTTP[10]["query"]["fuelTxId"])
    assert result.to_dict() == HTTP[10]["response"]
    assert session.request.call_count == 11
    await client.close()
    session.close.assert_not_called()


@pytest.mark.parametrize("status", [404, 410, 429, 503])
async def test_errors_no_retry(status):
    session = MagicMock(spec=aiohttp.ClientSession)
    response = MagicMock()
    response.status = status
    response.text = AsyncMock(
        return_value=json.dumps(
            {"error": {"code": "TEST_CODE", "message": "test", "details": {"retry": False}}}
        )
    )
    session.request.return_value.__aenter__ = AsyncMock(return_value=response)
    session.request.return_value.__aexit__ = AsyncMock(return_value=None)
    client = FastBridgeClient("https://bridge.example", session=session)
    with pytest.raises(BridgeApiError) as caught:
        await client.submit_withdraw(m.SubmitRequest("proof", "0x00", "0x01"))
    assert caught.value.status == status
    assert caught.value.bridge_code == "TEST_CODE"
    assert caught.value.details == {"retry": False}
    assert session.request.call_count == 1


async def test_client_owned_session_is_closed():
    client = FastBridgeClient("https://bridge.example")
    session = MagicMock(spec=aiohttp.ClientSession)
    session.close = AsyncMock()
    client._session = session
    async with client:
        pass
    session.close.assert_awaited_once()


@pytest.mark.parametrize(
    "status,payload,code",
    [
        (200, None, "INVALID_RESPONSE"),
        (200, [], "INVALID_RESPONSE"),
        (200, {}, "INVALID_RESPONSE"),
        (502, {"error": "gateway error"}, "HTTP_ERROR"),
        (502, {"error": None}, "HTTP_ERROR"),
    ],
)
async def test_malformed_response_shapes(status, payload, code):
    session = MagicMock(spec=aiohttp.ClientSession)
    response = MagicMock()
    response.status = status
    response.text = AsyncMock(return_value=json.dumps(payload))
    session.request.return_value.__aenter__ = AsyncMock(return_value=response)
    session.request.return_value.__aexit__ = AsyncMock(return_value=None)
    client = FastBridgeClient("https://bridge.example", session=session)
    with pytest.raises(BridgeApiError) as caught:
        await client.get_info()
    assert caught.value.status == status
    assert caught.value.bridge_code == code
