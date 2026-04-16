# Security Audit — FlashloanFrankencoin

**Date:** 2026-04-16  
**Contract:** `contracts/flashloan-frankencoin/FlashloanFrankencoin.sol`  
**Commit:** a67e3f4  
**Auditor:** Internal review (Claude Sonnet 4.6)

---

## Overview

`FlashloanFrankencoin` is a permissionless, stateless ZCHF flash-loan wrapper. It:

1. Computes collateral needed to back `amount` ZCHF at the source position's liquidation price.
2. Flash-borrows that collateral from Morpho.
3. Clones the source `PositionV2` via `MintingHubV2`, minting ZCHF to itself.
4. Delivers ZCHF to the recipient via `IFrankencoinFlashloan` callback.
5. Pulls repayment back, closes the ephemeral clone, returns collateral to Morpho.

All within a single atomic transaction.

---

## Findings

### HIGH

#### H-01 — Recipient is trusted for repayment; malicious recipient can cause bad debt if `adjust()` burns less than `amount`

**Location:** `onMorphoFlashLoan()` lines 197–205  
**Description:**  
The contract reads `clone.minted()` after the callback and approves that amount to the clone for `adjust()`. However, `amount` (delivered to recipient) and `clone.minted()` may diverge if:
- The hub applies fees that reduce the actual minted amount during `clone()`.
- `initialMint` in `hub.clone()` does not correspond 1:1 to `clone.minted()` at call time.

If `clone.minted() < amount`, the contract burns less ZCHF than was delivered and the flash loan is not truly neutral — the clone balance would go to reserve or remain partially open. If `clone.minted() > amount`, the `forceApprove` still matches `clone.minted()` so the excess would need to come from contract balance (there is none), causing a revert.

**Recommendation:**  
After `hub.clone()`, assert `clone.minted() == amount` and revert with a descriptive error if not. This tightens the invariant and surfaces hub-fee edge cases early.

```solidity
if (clone.minted() != amount) revert MintedAmountMismatch(clone.minted(), amount);
```

---

#### H-02 — `expiration = block.timestamp` may revert on PositionV2 implementations that require `expiration > block.timestamp`

**Location:** `onMorphoFlashLoan()` line 184  
**Description:**  
The contract passes `uint40(block.timestamp)` as the clone expiration. The NatSpec acknowledges this and suggests `block.timestamp + 1` as a workaround. However, the code does **not** implement this workaround. If the live `PositionV2` on mainnet checks `expiration > block.timestamp` (which the Frankencoin source does — `_expiration > block.timestamp`), every flash loan will revert at `hub.clone()`.

**Recommendation:**  
Change to `block.timestamp + 1` unconditionally, or read the `PositionV2` source and confirm the exact check before deploying.

```solidity
uint40(block.timestamp + 1)
```

---

### MEDIUM

#### M-01 — `onMorphoFlashLoan` does not validate `cbData` integrity — spoofed Morpho could pass arbitrary `source`

**Location:** `onMorphoFlashLoan()` line 161  
**Description:**  
The only auth check is `msg.sender != address(morpho)`. The `cbData` decoded inside includes `source` (a `PositionV2` address). If the Morpho contract address were ever compromised or replaced, or if Morpho is upgraded to allow forwarding arbitrary callbacks, an attacker could specify a malicious `source` whose `clone()` mints an inflated amount of ZCHF.

**Current risk:** Low because Morpho is an immutable singleton and `morpho` is set at construction.  
**Recommendation:** Document the trust assumption explicitly. Consider adding a `transient`-storage nonce or a hash commitment of `cbData` set in `flashloan()` and verified in the callback.

---

#### M-02 — Arithmetic: `denom` overflow possible for very large `liqPrice` values

**Location:** `flashloan()` line 145  
**Description:**  
```solidity
uint256 denom = liqPrice * (1_000_000 - reservePPM);
```
`liqPrice` is a WAD-scaled price (`uint256`). If `liqPrice` approaches `type(uint256).max / 1e6`, multiplication overflows. Realistic WBTC prices are ~40 000 ZCHF per token (WAD-scaled = `4e22`), well within range, but an adversarially crafted position could supply an extreme price and make `flashloan()` revert with overflow rather than a clean error.

**Recommendation:**  
Add an explicit check:
```solidity
if (liqPrice > type(uint256).max / 1_000_000) revert PriceOutOfRange();
```
or use a `Math.mulDiv` saturating path.

---

#### M-03 — No check that `source` position is not expired before cloning

**Location:** `flashloan()` lines 131–150  
**Description:**  
An expired source position may still return a valid `price()` and `reserveContribution()`, but `hub.clone()` will revert (Frankencoin reverts on expired parents). The caller would waste gas with an uninformative revert bubble.

**Recommendation:**  
Add a pre-flight guard:
```solidity
if (block.timestamp >= src.expiration()) revert SourceExpired();
```

---

#### M-04 — No check that `source.availableForMinting() >= amount`

**Location:** `flashloan()` lines 131–150  
**Description:**  
The NatSpec says the caller must ensure `availableForMinting() >= amount`, but the contract does not enforce it. `hub.clone()` will revert on the Frankencoin side, but the revert message is buried and can confuse integrators.

**Recommendation:**  
```solidity
if (src.availableForMinting() < amount) revert InsufficientMintingCapacity();
```

---

### LOW

#### L-01 — `recipient` is not validated to be a contract

**Location:** `flashloan()` line 130  
**Description:**  
Passing an EOA as `recipient` will cause the `IFrankencoinFlashloan.onFrankencoinFlashloan()` call to silently succeed (empty code = no revert in Solidity), then the `safeTransferFrom` will fail because the EOA never approved anything. The ZCHF tokens are transferred to the EOA first with no ability to pull them back.

**Severity:** Low — the tx reverts at repayment pull, so funds are not lost (Morpho reverts the whole tx if collateral isn't returned). But ZCHF transfer does occur mid-tx.  
**Recommendation:** `require(recipient.code.length > 0, "recipient not a contract")` or use an interface call and let the revert propagate naturally (already happens via `safeTransferFrom` failure).

---

#### L-02 — `Flashloan` event is emitted after Morpho callback, meaning it fires even if the loan is attempted with a zero-amount (guarded), but not if it's reverted inside Morpho

**Location:** `flashloan()` line 152  
**Description:**  
The event is emitted after `morpho.flashLoan()` returns (which only returns if the entire callback succeeded). This is correct. No issue — just confirming intentionality.

---

#### L-03 — `requiredCollateral()` does not guard against `liqPrice == 0` or `reservePPM >= 1_000_000`

**Location:** `requiredCollateral()` lines 224–230  
**Description:**  
Division by zero if `liqPrice == 0` or `reservePPM == 1_000_000` (denom = 0). `flashloan()` guards these, but the view function does not.

**Recommendation:**
```solidity
if (liqPrice == 0 || reservePPM >= 1_000_000) return type(uint256).max;
```

---

### INFORMATIONAL

#### I-01 — `forceApprove` leaves dangling approval if callback reverts after approval but before `adjust()`

**Location:** lines 179, 204, 208  
**Description:**  
`forceApprove` on hub and on Morpho are set and then consumed in the same tx. On revert the EVM rolls back all state changes, so no dangling approvals persist. No issue.

---

#### I-02 — `clone.price()` in `adjust()` call re-reads price from clone

**Location:** line 205  
**Description:**  
`clone.adjust(0, 0, clone.price())` reads the price from the fresh clone. This is safe — it was just set during initialization — but it creates a minor external call that could theoretically behave unexpectedly if the clone has a custom price getter. Consider caching `liqPrice` and passing it directly for gas savings and determinism.

---

#### I-03 — No `receive()` or token-rescue function

**Description:**  
The contract holds no persistent balance and requires no ETH. If tokens are accidentally sent (e.g., wrong collateral token), there is no recovery path. Acceptable for a stateless contract.

---

## Summary Table

| ID   | Severity      | Title                                              | Status    |
|------|---------------|----------------------------------------------------|-----------|
| H-01 | High          | `minted()` vs `amount` mismatch not asserted       | Open      |
| H-02 | High          | `expiration = block.timestamp` likely reverts      | Open      |
| M-01 | Medium        | `cbData` source trust relies solely on `msg.sender`| Accepted  |
| M-02 | Medium        | `denom` overflow on extreme `liqPrice`             | Open      |
| M-03 | Medium        | Source expiration not checked pre-flight           | Open      |
| M-04 | Medium        | `availableForMinting()` not checked pre-flight     | Open      |
| L-01 | Low           | `recipient` not validated to be a contract         | Open      |
| L-02 | Low           | Event timing — confirmed correct                   | Closed    |
| L-03 | Low           | `requiredCollateral()` division-by-zero guard      | Open      |
| I-01 | Info          | `forceApprove` + revert rollback — safe            | Closed    |
| I-02 | Info          | `clone.price()` re-read — minor gas / determinism  | Open      |
| I-03 | Info          | No token rescue function                           | Accepted  |

---

## Critical Path to Deploy

1. **Fix H-02** — change `block.timestamp` → `block.timestamp + 1` (one-liner, must-fix).
2. **Fix H-01** — add `assert(clone.minted() == amount)` after clone (protects against hub-fee drift).
3. **Fix M-03 / M-04** — add pre-flight guards in `flashloan()` for user-facing clarity.
4. **Fix L-03** — guard `requiredCollateral()` view.
5. **Review M-02** — confirm realistic price range; add overflow guard if needed.
