# Error Handling Guide

This guide covers error handling patterns in the O2 TypeScript SDK.

## Error Hierarchy

All API errors extend the base {@link O2Error} class:

```ts
import { O2Error, InvalidSignature, RateLimitExceeded } from "@o2exchange/sdk";

try {
  await client.createOrder(session, "fFUEL/fUSDC", "Buy", 0.02, 100.0);
} catch (error) {
  if (error instanceof O2Error) {
    console.log(`Code: ${error.code}`);
    console.log(`Message: ${error.message}`);
    console.log(`Reason: ${error.reason}`);
  }
}
```

## Error Code Reference

### General Errors (1xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 1000 | {@link InternalError} | Unexpected server error | Retry with backoff |
| 1001 | {@link InvalidRequest} | Malformed or invalid request | Fix request |
| 1002 | {@link ParseError} | Failed to parse request body | Fix request format |
| 1003 | {@link RateLimitExceeded} | Too many requests | Wait 3-5s (auto-retried) |
| 1004 | {@link GeoRestricted} | Region not allowed | Use VPN or different region |

### Market Errors (2xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 2000 | {@link MarketNotFound} | Market not found | Check market_id |
| 2001 | {@link MarketPaused} | Market is paused | Wait for market to resume |
| 2002 | {@link MarketAlreadyExists} | Market already exists | Use existing market |

### Order Errors (3xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 3000 | {@link OrderNotFound} | Order not found | Order may be filled/cancelled |
| 3001 | {@link OrderNotActive} | Order is not active | Order already closed |
| 3002 | {@link InvalidOrderParams} | Invalid order parameters | Check price/quantity |

### Account/Session Errors (4xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 4000 | {@link InvalidSignature} | Signature verification failed | Check signing logic |
| 4001 | {@link InvalidSession} | Session invalid or expired | Recreate session |
| 4002 | {@link AccountNotFound} | Trading account not found | Call `setupAccount()` |
| 4003 | {@link WhitelistNotConfigured} | Whitelist not configured | Whitelist the account |

### Trade Errors (5xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 5000 | {@link TradeNotFound} | Trade not found | Check trade_id |
| 5001 | {@link InvalidTradeCount} | Invalid trade count | Adjust count parameter |

### Subscription Errors (6xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 6000 | {@link AlreadySubscribed} | Already subscribed | Skip duplicate subscription |
| 6001 | {@link TooManySubscriptions} | Subscription limit reached | Unsubscribe from unused streams |
| 6002 | {@link SubscriptionError} | General subscription error | Reconnect WebSocket |

### Validation Errors (7xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 7000 | {@link InvalidAmount} | Invalid amount | Check amount value |
| 7001 | {@link InvalidTimeRange} | Invalid time range | Fix from/to timestamps |
| 7002 | {@link InvalidPagination} | Invalid pagination params | Fix count/offset |
| 7003 | {@link NoActionsProvided} | No actions in request | Add at least one action |
| 7004 | {@link TooManyActions} | Too many actions (max 5) | Split into multiple batches |

### Block/Events Errors (8xxx)

| Code | Class | Description | Recovery |
|------|-------|-------------|----------|
| 8000 | {@link BlockNotFound} | Block not found | Block may not be indexed yet |
| 8001 | {@link EventsNotFound} | Events not found | Events may not be indexed yet |

## On-Chain Revert Errors

On-chain reverts have **no `code` field** — instead, check `error.reason`
for the revert name. These are raised as {@link OnChainRevertError}:

```ts
import { OnChainRevertError } from "@o2exchange/sdk";

try {
  await client.createOrder(session, "fFUEL/fUSDC", "Buy", 0.02, 100.0);
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
{@link SessionExpired} if the session has expired:

```ts
import { SessionExpired } from "@o2exchange/sdk";

try {
  await client.createOrder(session, "fFUEL/fUSDC", "Buy", 0.02, 100.0);
} catch (error) {
  if (error instanceof SessionExpired) {
    // Create a new session
    session = await client.createSession(wallet, tradeAccountId, ["fFUEL/fUSDC"]);
  }
}
```

## Rate Limit Handling

The SDK automatically retries on {@link RateLimitExceeded} errors with
exponential backoff. You can configure retry behavior via {@link O2ApiOptions}:

```ts
import { O2Api, TESTNET } from "@o2exchange/sdk";

const api = new O2Api({
  config: TESTNET,
  maxRetries: 5,          // default: 3
  retryDelayMs: 2000,     // default: 1000
  timeoutMs: 60_000,      // default: 30000
});
```

## Nonce Errors

The on-chain nonce increments even on reverts. After any error during
trading, refresh the nonce to re-sync:

```ts
try {
  await client.createOrder(session, "fFUEL/fUSDC", "Buy", 0.02, 100.0);
} catch (error) {
  // The SDK automatically refreshes the nonce on errors,
  // but you can also do it manually:
  await client.refreshNonce(session);
}
```

## Complete Error Handling Pattern

```ts
import {
  O2Client, O2Error, OnChainRevertError, SessionExpired,
  InvalidSession, RateLimitExceeded, Network,
} from "@o2exchange/sdk";

const client = new O2Client({ network: Network.TESTNET });
const wallet = client.generateWallet();
const { tradeAccountId } = await client.setupAccount(wallet);
let session = await client.createSession(wallet, tradeAccountId, ["fFUEL/fUSDC"]);

async function placeOrder() {
  try {
    const { response } = await client.createOrder(
      session, "fFUEL/fUSDC", "Buy", 0.02, 100.0,
    );
    console.log(`Success: ${response.tx_id}`);
  } catch (error) {
    if (error instanceof SessionExpired || error instanceof InvalidSession) {
      // Recreate session
      session = await client.createSession(wallet, tradeAccountId, ["fFUEL/fUSDC"]);
      return placeOrder(); // retry
    }
    if (error instanceof OnChainRevertError) {
      console.log(`On-chain revert: ${error.reason}`);
      await client.refreshNonce(session);
    } else if (error instanceof O2Error) {
      console.log(`API error ${error.code}: ${error.message}`);
    } else {
      throw error; // unexpected error
    }
  }
}
```
