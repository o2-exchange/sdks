//! Bounded codecs for the proxy's pinned formats, not general-purpose chain parsers.
use super::BridgeError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use std::collections::BTreeMap;

type Result<T> = std::result::Result<T, BridgeError>;
fn check(ok: bool, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(BridgeError::Invalid(message.into()))
    }
}
fn unhex(value: &str) -> Result<Vec<u8>> {
    check(
        value.starts_with("0x") && value.len() > 2 && value.len() <= 32770,
        "Invalid hex transaction",
    )?;
    hex::decode(&value[2..]).map_err(|e| BridgeError::Invalid(e.to_string()))
}
fn hx(value: &[u8]) -> String {
    format!("0x{}", hex::encode(value))
}
fn b64(value: &str) -> Result<Vec<u8>> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    check(
        !value.is_empty() && value.len() % 4 != 1,
        "Invalid base64url",
    )?;
    let mut out = Vec::new();
    let (mut bits, mut accumulator) = (0u32, 0u32);
    for byte in value.bytes() {
        let digit = alphabet
            .iter()
            .position(|b| *b == byte)
            .ok_or_else(|| BridgeError::Invalid("Invalid base64url".into()))?;
        accumulator = (accumulator << 6) | digit as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
            accumulator &= (1 << bits) - 1;
        }
    }
    check(accumulator == 0, "Noncanonical base64url")?;
    Ok(out)
}

/// UNAUTHENTICATED proof data. Parsing does not verify HMAC, expiry or transaction binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparationProofClaims {
    pub version: u8,
    pub key_id: String,
    /// Unix seconds. Expired proofs can still be inspected.
    pub expires_at: u64,
    pub signer: String,
}
pub fn parse_preparation_proof(proof: &str) -> Result<PreparationProofClaims> {
    check(proof.len() <= 2048, "Preparation proof too large")?;
    let parts: Vec<_> = proof.split('.').collect();
    check(parts.len() == 2, "Invalid preparation proof")?;
    check(
        b64(parts[1])?.len() == 32,
        "Invalid preparation proof MAC length",
    )?;
    let c: PreparationProofClaims = serde_json::from_slice(&b64(parts[0])?)?;
    check(
        c.version == 1
            && !c.key_id.is_empty()
            && c.expires_at > 0
            && c.expires_at <= 9007199254740991
            && matches!(c.signer.len(), 42 | 66)
            && c.signer.starts_with("0x")
            && c.signer[2..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid preparation proof claims",
    )?;
    Ok(c)
}

struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }
    fn take(&mut self, size: usize) -> Result<&'a [u8]> {
        check(
            size <= self.data.len() - self.offset,
            "Truncated transaction",
        )?;
        let data = &self.data[self.offset..self.offset + size];
        self.offset += size;
        Ok(data)
    }
    fn number(&mut self, size: usize) -> Result<u64> {
        Ok(self
            .take(size)?
            .iter()
            .fold(0u64, |n, b| (n << 8) | u64::from(*b)))
    }
    fn num(&mut self) -> Result<u64> {
        self.number(8)
    }
    fn count(&mut self, max: u64) -> Result<usize> {
        let n = self.num()?;
        check(n <= max, "Unsupported transaction size or field")?;
        Ok(n as usize)
    }
    fn padded(&mut self, size: usize) -> Result<&'a [u8]> {
        let data = self.take(size)?;
        check(
            self.take((8 - size % 8) % 8)?.iter().all(|b| *b == 0),
            "Nonzero transaction padding",
        )?;
        Ok(data)
    }
    fn done(&self) -> Result<()> {
        check(self.offset == self.data.len(), "Trailing transaction data")
    }
}
enum Rlp<'a> {
    Bytes(&'a [u8]),
    List(Vec<Rlp<'a>>),
}
fn rlp<'a>(r: &mut Reader<'a>, depth: usize) -> Result<Rlp<'a>> {
    check(depth < 4, "RLP nesting too deep")?;
    let start = r.offset;
    let tag = r.number(1)? as usize;
    if tag < 128 {
        return Ok(Rlp::Bytes(&r.data[start..start + 1]));
    }
    let list = tag >= 192;
    let (short, long) = if list { (192, 247) } else { (128, 183) };
    let length = if tag > long {
        let data = r.take(tag - long)?;
        let n = data.iter().fold(0u64, |n, b| (n << 8) | u64::from(*b));
        check(
            data[0] != 0 && (56..=16384).contains(&n),
            "Invalid RLP length",
        )?;
        n as usize
    } else {
        tag - short
    };
    let data = r.take(length)?;
    if !list {
        check(length != 1 || data[0] >= 128, "Noncanonical RLP")?;
        return Ok(Rlp::Bytes(data));
    }
    let mut child = Reader::new(data);
    let mut out = Vec::new();
    while child.offset < data.len() {
        out.push(rlp(&mut child, depth + 1)?);
    }
    Ok(Rlp::List(out))
}
fn leaf<'a>(value: &Rlp<'a>, size: Option<usize>) -> Result<&'a [u8]> {
    if let Rlp::Bytes(data) = value {
        check(
            size.map_or(true, |s| s == data.len()),
            "Invalid EVM field length",
        )?;
        Ok(data)
    } else {
        Err(BridgeError::Invalid("Invalid EVM field".into()))
    }
}
fn evm_int<'a>(value: &Rlp<'a>) -> Result<&'a [u8]> {
    let data = leaf(value, None)?;
    check(
        data.len() <= 32 && data.first() != Some(&0),
        "Noncanonical EVM integer",
    )?;
    Ok(data)
}
// Decimal conversion/multiplication only; no new U256 dependency or cryptographic arithmetic.
fn decimal(data: &[u8]) -> String {
    let mut digits = vec![0u32];
    for b in data {
        let mut carry = u32::from(*b);
        for digit in &mut digits {
            carry += *digit * 256;
            *digit = carry % 10;
            carry /= 10;
        }
        while carry > 0 {
            digits.push(carry % 10);
            carry /= 10;
        }
    }
    digits
        .iter()
        .rev()
        .map(|n| char::from(b'0' + *n as u8))
        .collect()
}
fn product(a: &str, b: &str) -> String {
    let mut digits = vec![0u32; a.len() + b.len()];
    for (i, x) in a.bytes().rev().enumerate() {
        for (j, y) in b.bytes().rev().enumerate() {
            digits[i + j] += u32::from(x - b'0') * u32::from(y - b'0');
        }
    }
    for i in 0..digits.len() - 1 {
        digits[i + 1] += digits[i] / 10;
        digits[i] %= 10;
    }
    while digits.len() > 1 && digits.last() == Some(&0) {
        digits.pop();
    }
    digits
        .iter()
        .rev()
        .map(|n| char::from(b'0' + *n as u8))
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmPermitInspection {
    pub deadline: String,
    pub v: u8,
    pub r: String,
    pub s: String,
}
/// EVM integers are decimal strings to preserve full uint256 precision without a new dependency.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmDepositInspection {
    #[serde(rename = "type")]
    pub transaction_type: u8,
    pub chain_id: String,
    pub nonce: String,
    pub messenger_address: String,
    pub value: String,
    pub gas_limit: String,
    pub max_fee_per_gas: String,
    pub max_priority_fee_per_gas: String,
    /// gasLimit * maxFeePerGas in wei: cap, not actual fee. Excludes rollup L1 data fees.
    pub estimated_network_fee: String,
    pub data: String,
    pub method: String,
    pub recipient: String,
    pub recipient_is_contract: bool,
    pub token_address: Option<String>,
    /// EVM token base units/wei, NOT API/Fuel base units.
    pub amount: String,
    pub permit: Option<EvmPermitInspection>,
    /// Raw keccak256 of the unsigned type-2 envelope; not personal_sign.
    pub signing_digest: String,
}
pub fn parse_evm_unsigned_transaction(unsigned_transaction: &str) -> Result<EvmDepositInspection> {
    let bytes = unhex(unsigned_transaction)?;
    let mut r = Reader::new(&bytes);
    check(
        r.number(1)? == 2,
        "Only unsigned EIP-1559 deposits are supported",
    )?;
    let Rlp::List(f) = rlp(&mut r, 0)? else {
        return Err(BridgeError::Invalid("Expected EIP-1559 list".into()));
    };
    r.done()?;
    check(f.len() == 9, "Expected unsigned EIP-1559 fields")?;
    check(
        matches!(&f[8], Rlp::List(items) if items.is_empty()),
        "Proxy deposits require an empty access list",
    )?;
    let chain = evm_int(&f[0])?;
    let nonce = evm_int(&f[1])?;
    let priority = evm_int(&f[2])?;
    let fee = evm_int(&f[3])?;
    let gas = evm_int(&f[4])?;
    check(
        !chain.is_empty() && (priority.len(), priority) <= (fee.len(), fee),
        "Invalid EVM fees or chain",
    )?;
    let messenger = hx(leaf(&f[5], Some(20))?);
    let value = evm_int(&f[6])?;
    let data = leaf(&f[7], None)?;
    let signatures = [
        "deposit(bytes32,address,uint256,bool)",
        "depositWithPermit(bytes32,address,uint256,uint256,uint8,bytes32,bytes32,bool)",
        "depositETH(bytes32,bool)",
    ];
    let index = signatures
        .iter()
        .position(|s| data.get(..4) == Some(&Keccak256::digest(s.as_bytes())[..4]))
        .ok_or_else(|| BridgeError::Invalid("Unknown Messenger method".into()))?;
    let count = [4, 8, 2][index];
    check(
        data.len() == 4 + count * 32,
        "Invalid Messenger calldata length",
    )?;
    let arg = |i: usize| &data[4 + i * 32..36 + i * 32];
    let flag = arg(count - 1);
    check(
        flag[..31].iter().all(|b| *b == 0) && flag[31] <= 1,
        "Invalid recipientIsContract",
    )?;
    let (mut token, mut amount, mut permit) = (None, decimal(value), None);
    if index != 2 {
        check(
            value.is_empty() && arg(1)[..12].iter().all(|b| *b == 0),
            "Invalid token deposit",
        )?;
        token = Some(hx(&arg(1)[12..]));
        amount = decimal(arg(2));
        if index == 1 {
            check(arg(4)[..31].iter().all(|b| *b == 0), "Invalid permit v")?;
            permit = Some(EvmPermitInspection {
                deadline: decimal(arg(3)),
                v: arg(4)[31],
                r: hx(arg(5)),
                s: hx(arg(6)),
            });
        }
    }
    Ok(EvmDepositInspection {
        transaction_type: 2,
        chain_id: decimal(chain),
        nonce: decimal(nonce),
        messenger_address: messenger,
        value: decimal(value),
        gas_limit: decimal(gas),
        max_fee_per_gas: decimal(fee),
        max_priority_fee_per_gas: decimal(priority),
        estimated_network_fee: product(&decimal(gas), &decimal(fee)),
        data: hx(data),
        method: ["deposit", "depositWithPermit", "depositETH"][index].into(),
        recipient: hx(arg(0)),
        recipient_is_contract: flag[31] == 1,
        token_address: token,
        amount,
        permit,
        signing_digest: hx(&Keccak256::digest(&bytes)),
    })
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuelInputInspection {
    #[serde(rename = "type")]
    pub kind: String,
    pub owner: Option<String>,
    pub amount: Option<u64>,
    pub asset_id: Option<String>,
    pub contract_id: Option<String>,
    pub witness_index: Option<u16>,
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuelOutputInspection {
    #[serde(rename = "type")]
    pub kind: String,
    /// Variable to/asset_id and Change/Variable amounts are unsigned execution results.
    pub to: Option<String>,
    pub amount: Option<u64>,
    pub asset_id: Option<String>,
    pub input_index: Option<usize>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuelNetworkFee {
    pub max_fee: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuelWithdrawalInspection {
    pub asset_id: String,
    pub asset_sub_id: String,
    pub asset_registry_contract_id: String,
    pub destination_chain_id: u32,
    pub recipient: String,
    pub gross_amount: u64,
    /// Embedded fee quote in Fuel asset units. Execution may charge a different fee within tolerance.
    pub bridge_fee: u64,
    /// Expected gross - quoted fee, not guaranteed delivery.
    pub net_amount: u64,
    /// Cap in Fuel base-asset units, not actual gas cost.
    pub network_fee: FuelNetworkFee,
    pub expiration_block_height: u32,
    pub script_gas_limit: u64,
    pub policies: BTreeMap<String, u64>,
    pub inputs: Vec<FuelInputInspection>,
    pub outputs: Vec<FuelOutputInspection>,
    pub transaction_id: String,
}
/// Inspect pinned single-call bytecode and derive the ID using an independently trusted Fuel chain ID.
/// Parsing is NOT a safety approval: inspect amounts, contracts, recipients, inputs and outputs.
/// Supply independently trusted consensus txParameters.maxInputs to validate VM memory pointers.
/// This parameter is not encoded in the transaction and is never fetched by this helper.
pub fn parse_fuel_unsigned_transaction(
    unsigned_transaction: &str,
    fuel_chain_id: u64,
    fuel_max_inputs: u16,
) -> Result<FuelWithdrawalInspection> {
    check(fuel_max_inputs > 0, "Invalid Fuel consensus maxInputs")?;
    let bytes = unhex(unsigned_transaction)?;
    let mut normalized = bytes.clone();
    let mut r = Reader::new(&bytes);
    check(r.num()? == 0, "Expected Fuel Script transaction")?;
    let gas = r.num()?;
    r.take(32)?;
    normalized[16..48].fill(0);
    let (script_len, data_len, mask) = (r.count(16384)?, r.count(16384)?, r.count(63)?);
    let (input_count, output_count, witnesses) =
        (r.count(16384)?, r.count(16384)?, r.count(16384)?);
    check(
        input_count > 0 && input_count <= usize::from(fuel_max_inputs) && witnesses == 1,
        "Expected supported inputs and one unsigned owner witness",
    )?;
    let (script, data) = (r.padded(script_len)?, r.padded(data_len)?);
    let mut policies = BTreeMap::new();
    for (i, name) in [
        "tip",
        "witnessLimit",
        "maturity",
        "maxFee",
        "expiration",
        "owner",
    ]
    .iter()
    .enumerate()
    {
        if mask & (1 << i) != 0 {
            policies.insert((*name).to_string(), r.num()?);
        }
    }
    check(
        policies.contains_key("maxFee")
            && policies
                .get("expiration")
                .is_some_and(|v| *v <= u64::from(u32::MAX)),
        "Missing fee/expiration policy",
    )?;
    let mut inputs = Vec::new();
    for _ in 0..input_count {
        let kind = r.count(2)?;
        let start = r.offset;
        if kind == 1 {
            r.take(32)?;
            r.count(65535)?;
            r.take(64)?;
            r.count(u32::MAX.into())?;
            r.count(65535)?;
            normalized[start..start + 120].fill(0);
            inputs.push(FuelInputInspection {
                kind: "contract".into(),
                contract_id: Some(hx(r.take(32)?)),
                ..Default::default()
            });
        } else {
            let (owner, amount, asset) = if kind == 0 {
                r.take(32)?;
                r.count(65535)?;
                let fields = (hx(r.take(32)?), r.num()?, Some(hx(r.take(32)?)));
                let pointer = r.offset;
                r.count(u32::MAX.into())?;
                r.count(65535)?;
                normalized[pointer..pointer + 16].fill(0);
                fields
            } else {
                r.take(32)?;
                let fields = (hx(r.take(32)?), r.num()?, None);
                r.take(32)?;
                fields
            };
            let witness = r.count(65535)?;
            check(witness == 0, "Unsupported witness index")?;
            let offset = r.offset;
            check(r.num()? == 0, "Predicates unsupported")?;
            normalized[offset..offset + 8].fill(0);
            if kind == 2 {
                check(r.num()? == 0, "Message data unsupported")?;
            }
            check(r.num()? == 0 && r.num()? == 0, "Predicates unsupported")?;
            inputs.push(FuelInputInspection {
                kind: if kind == 0 { "coin" } else { "message" }.into(),
                owner: Some(owner),
                amount: Some(amount),
                asset_id: asset,
                witness_index: Some(0),
                ..Default::default()
            });
        }
    }
    let mut outputs = Vec::new();
    for _ in 0..output_count {
        let kind = r.count(3)?;
        check(
            kind != 0,
            "Coin outputs are unsupported in proxy withdrawals",
        )?;
        if kind == 1 {
            let index = r.count(16384)?;
            check(
                inputs.get(index).is_some_and(|i| i.kind == "contract"),
                "Invalid contract output",
            )?;
            let offset = r.offset;
            r.take(64)?;
            normalized[offset..offset + 64].fill(0);
            outputs.push(FuelOutputInspection {
                kind: "contract".into(),
                input_index: Some(index),
                ..Default::default()
            });
        } else {
            let start = r.offset;
            let (to, amount, asset) = (hx(r.take(32)?), r.num()?, hx(r.take(32)?));
            if kind == 2 {
                normalized[start + 32..start + 40].fill(0);
            }
            if kind == 3 {
                normalized[start..start + 72].fill(0);
            }
            outputs.push(FuelOutputInspection {
                kind: if kind == 2 { "change" } else { "variable" }.into(),
                to: Some(to),
                amount: Some(amount),
                asset_id: Some(asset),
                ..Default::default()
            });
        }
    }
    let witness_offset = r.offset;
    check(r.num()? == 0, "Expected empty unsigned witness")?;
    r.done()?;
    normalized[88..96].fill(0);
    let mut d = Reader::new(data);
    let (gross, asset, registry) = (d.num()?, hx(d.take(32)?), hx(d.take(32)?));
    let (selector_pointer, args_pointer) = (d.count(0x3ffff + 88)?, d.count(0x3ffff + 256)?);
    let selector = b"withdraw_via_fast_bridge_with_fee";
    check(
        d.num()? == selector.len() as u64 && d.take(selector.len())? == selector,
        "Unknown Fuel call",
    )?;
    check(
        args_pointer == selector_pointer + 8 + selector.len() && selector_pointer >= 88,
        "Invalid Fuel pointer",
    )?;
    let offset = (selector_pointer - 88) as u64;
    // VM prefix 72 + maxInputs * 40, Script header 96, CALL script 24.
    check(
        offset == 192 + 40 * u64::from(fuel_max_inputs),
        "Fuel call pointer does not address this transaction's script data",
    )?;
    check(offset + 40 <= 0x3ffff, "Invalid Fuel call pointer")?;
    let expected = [
        0x72400000 | (offset + 40),
        0x72440000 | offset,
        0x5d451000,
        0x72480000 | (offset + 8),
        0x2d41148a,
        0x24040000,
    ];
    check(script.len() == 24, "Unsupported Fuel script")?;
    let mut s = Reader::new(script);
    for v in expected {
        check(s.number(4)? == v, "Unsupported Fuel script")?;
    }
    let (sub_id, chain, recipient, fee) =
        (hx(d.take(32)?), d.number(4)? as u32, d.take(32)?, d.num()?);
    d.done()?;
    check(
        recipient[..12].iter().all(|b| *b == 0) && gross >= fee,
        "Invalid recipient or fee",
    )?;
    check(
        recipient[12..].iter().any(|b| *b != 0),
        "Zero withdrawal recipient",
    )?;
    check(
        inputs
            .iter()
            .any(|i| i.contract_id.as_ref() == Some(&registry)),
        "Missing Asset Registry input",
    )?;
    let mut hasher = Sha256::new();
    hasher.update(fuel_chain_id.to_be_bytes());
    hasher.update(&normalized[..witness_offset]);
    Ok(FuelWithdrawalInspection {
        asset_id: asset,
        asset_sub_id: sub_id,
        asset_registry_contract_id: registry,
        destination_chain_id: chain,
        recipient: hx(&recipient[12..]),
        gross_amount: gross,
        bridge_fee: fee,
        net_amount: gross - fee,
        network_fee: FuelNetworkFee {
            max_fee: policies["maxFee"],
        },
        expiration_block_height: policies["expiration"] as u32,
        script_gas_limit: gas,
        policies,
        inputs,
        outputs,
        transaction_id: hx(&hasher.finalize()),
    })
}
