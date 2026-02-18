# Error Handling Guide

This guide covers error handling patterns in the O2 TypeScript SDK.

## Error Hierarchy

All API errors extend the base O2Error class:

```ts
import { O2Error, InvalidSignature, RateLimitExceeded } from "@o2exchange/sdk";

try {
  await client.createOrder("FUEL/USDC", "buy", "0.02", "100");
} catch (error) {
  if (error instanceof O2Error) {
    console.log(`Code: ${error.code}`);
    console.log(`Message: ${error.message}`);
    console.log(`Reason: ${error.reason}`);
  }
}
```

## SessionActionsResponse

The `SessionActionsResponse` class provides structured success checking:

```ts
const response = await client.createOrder("FUEL/USDC", "buy", "0.02", "100");

if (response.success) {
  console.log(`TX: ${response.txId}`);
} else if (response.isPreflightError) {
  console.log(`Preflight error: ${response.message} (code: ${response.code})`);
} else if (response.isOnChainRevert) {
  console.log(`On-chain revert: ${response.reason}`);
}
```

## Error Code Reference

### General Errors (1xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 1000 | InternalError | Unexpected server error | Retry with backoff |
| 1001 | InvalidRequest | Malformed or invalid request | Fix request |
| 1002 | ParseError | Failed to parse request body | Fix request format |
| 1003 | RateLimitExceeded | Too many requests | Wait 3-5s (auto-retried) |
| 1004 | GeoRestricted | Region not allowed | Use VPN or different region |

### Market Errors (2xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 2000 | MarketNotFound | Market not found | Check market_id |
| 2001 | MarketPaused | Market is paused | Wait for market to resume |
| 2002 | MarketAlreadyExists | Market already exists | Use existing market |

### Order Errors (3xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 3000 | OrderNotFound | Order not found | Order may be filled/cancelled |
| 3001 | OrderNotActive | Order is not active | Order already closed |
| 3002 | InvalidOrderParams | Invalid order parameters | Check price/quantity |

### Account/Session Errors (4xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 4000 | InvalidSignature | Signature verification failed | Check signing logic |
| 4001 | InvalidSession | Session invalid or expired | Recreate session |
| 4002 | AccountNotFound | Trading account not found | Call `setupAccount()` |
| 4003 | WhitelistNotConfigured | Whitelist not configured | Whitelist the account |

### Trade Errors (5xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 5000 | TradeNotFound | Trade not found | Check trade_id |
| 5001 | InvalidTradeCount | Invalid trade count | Adjust count parameter |

### Subscription Errors (6xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 6000 | AlreadySubscribed | Already subscribed | Skip duplicate subscription |
| 6001 | TooManySubscriptions | Subscription limit reached | Unsubscribe from unused streams |
| 6002 | SubscriptionError | General subscription error | Reconnect WebSocket |

### Validation Errors (7xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 7000 | InvalidAmount | Invalid amount | Check amount value |
| 7001 | InvalidTimeRange | Invalid time range | Fix from/to timestamps |
| 7002 | InvalidPagination | Invalid pagination params | Fix count/offset |
| 7003 | NoActionsProvided | No actions in request | Add at least one action |
| 7004 | TooManyActions | Too many actions (max 5) | Split into multiple batches |

### Block/Events Errors (8xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 8000 | BlockNotFound | Block not found | Block may not be indexed yet |
| 8001 | EventsNotFound | Events not found | Events may not be indexed yet |

## On-Chain Revert Errors

On-chain reverts have **no `code` field** — instead, check `error.reason`
for the revert name. These are raised as `OnChainRevertError`:

```ts
import { OnChainRevertError } from "@o2exchange/sdk";

try {
  await client.createOrder("FUEL/USDC", "buy", "0.02", "100");
} catch (error) {
  if (error instanceof OnChainRevertError) {
    console.log(`Revert reason: ${error.reason}`);
    // Common reasons:
    // - "NotEnoughBalance"
    // - "TraderNotWhiteListed"
    // - "PricePrecision"
    // - "FractionalPrice"
    // - "MinOrderNotReached"
  }
}
```

## Client-Side Errors

### Session Expiry

The SDK checks session expiry before submitting actions and raises
`SessionExpired` if the session has expired:

```ts
import { SessionExpired } from "@o2exchange/sdk";

try {
  await client.createOrder("FUEL/USDC", "buy", "0.02", "100");
} catch (error) {
  if (error instanceof SessionExpired) {
    await client.createSession(wallet, ["FUEL/USDC"]);
  }
}
```

## Rate Limit Handling

The SDK automatically retries on `RateLimitExceeded` errors with
exponential backoff. You can configure retry behavior via `O2ApiOptions`:

```ts
import { O2Api, TESTNET } from "@o2exchange/sdk";

const api = new O2Api({
  config: TESTNET,
  maxRetries: 5,
  retryDelayMs: 2000,
  timeoutMs: 60_000,
});
```

## Nonce Errors

The on-chain nonce increments even on reverts. After any error during
trading, refresh the nonce to re-sync:

```ts
try {
  await client.createOrder("FUEL/USDC", "buy", "0.02", "100");
} catch (error) {
  await client.refreshNonce();
}
```

## Complete Error Handling Pattern

```ts
import {
  O2Client, O2Error, OnChainRevertError, SessionExpired,
  InvalidSession, Network,
} from "@o2exchange/sdk";

const client = new O2Client({ network: Network.TESTNET });
const wallet = O2Client.generateWallet();
await client.setupAccount(wallet);
await client.createSession(wallet, ["FUEL/USDC"]);

async function placeOrder() {
  try {
    const response = await client.createOrder("FUEL/USDC", "buy", "0.02", "100");
    if (response.success) {
      console.log(`Success: ${response.txId}`);
    }
  } catch (error) {
    if (error instanceof SessionExpired || error instanceof InvalidSession) {
      await client.createSession(wallet, ["FUEL/USDC"]);
      return placeOrder();
    }
    if (error instanceof OnChainRevertError) {
      console.log(`On-chain revert: ${error.reason}`);
      await client.refreshNonce();
    } else if (error instanceof O2Error) {
      console.log(`API error ${error.code}: ${error.message}`);
    } else {
      throw error;
    }
  }
}
```
