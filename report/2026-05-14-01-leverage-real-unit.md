# Security Audit — LeverageRealUnit

**Date:** 2026-05-14
**Scope:**
- `contracts/leverage-frankencoin/LeverageRealUnit.sol`
- `contracts/frankencoin/IPositionV2.sol`

**Commit:** `7c55099`

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 0 |
| Medium   | 3 |
| Low      | 2 |
| Info     | 2 |

---

## Findings

### [M-01] No minimum token output — no slippage protection  *(Medium)*

**Location:** `LeverageRealUnit.sol:117` (`executeLeverage`)

**Description:** `executeLeverage` pulls the full `inputAmount` from the user and computes `tokens` live at execution time using `brokerbot.getBuyPrice(1)`. The user has no way to specify a minimum acceptable token count. Between `preview()` and execution the BrokerBot price can move, resulting in fewer tokens (smaller position) than the user anticipated while still spending the full `inputAmount` of ZCHF equity. A front-running sandwich on the BrokerBot price is also possible.

**Recommendation:** Add a `uint256 minTokens` parameter to `executeLeverage` and revert if `tokens < minTokens`.

---

### [M-02] Silent `uint24` truncation of `feePPM` for long/high-rate positions  *(Medium)*

**Location:** `LeverageRealUnit.sol:209`

```solidity
feePPM = uint24(((uint256(expiration) - block.timestamp) * uint256(src.annualInterestPPM())) / 365 days);
```

**Description:** The result of the division is a `uint256`. When cast to `uint24` (max 16,777,215 ≈ 1.68×10⁷), any duration × rate product that exceeds this silently wraps. For example, an annualInterestPPM of 100,000 (10 %) and a two-year clone yields `feePPM = 200,000` — fine — but at annualInterestPPM = 1,000,000 (100 %) the overflow triggers at ~6 months. A truncated `feePPM` causes `netPPM` to be over-estimated, inflating `tokens` and `mintNet`. The minted ZCHF (via `HUB.clone`) may then be less than `mintNet` because the hub applies the real fee, leaving the flashloan unable to be repaid. In practice this will cause a revert, but the path to it is opaque.

**Recommendation:** Either widen `feePPM` / `netPPM` to `uint256` throughout `_compute`, or add an explicit check:

```solidity
uint256 feePPMraw = ((uint256(expiration) - block.timestamp) * uint256(src.annualInterestPPM())) / 365 days;
require(feePPMraw <= type(uint24).max, 'feePPM overflow');
feePPM = uint24(feePPMraw);
```

---

### [M-03] `netPPM` underflow revert when cumulative fees exceed 100 %  *(Medium)*

**Location:** `LeverageRealUnit.sol:211`

```solidity
uint24 netPPM = 1_000_000 - resPPM - feePPM;
```

**Description:** `resPPM` and `feePPM` are both `uint24`. Their sum can exceed 1,000,000 for a position with a large reserve contribution and/or a long expiration with a high interest rate. Solidity 0.8 reverts on the underflow with no descriptive error, making it hard for integrators or front-ends to distinguish this from other failures.

**Recommendation:** Add an explicit check before the subtraction:

```solidity
require(uint256(resPPM) + uint256(feePPM) < 1_000_000, 'fees exceed collateral value');
```

---

### [L-01] `_clonedPosition` not validated after flashloan returns  *(Low)*

**Location:** `LeverageRealUnit.sol:148`

```solidity
leveragedPosition = _clonedPosition;
_clonedPosition = address(0);
```

**Description:** If the `FLASHLOAN` contract does not invoke `onFrankencoinFlashloan` (e.g. a future upgrade or an alternative flashloan source with a different callback convention), `_clonedPosition` remains `address(0)` and the function silently returns the zero address to the caller.

**Recommendation:** Add `require(leveragedPosition != address(0), 'clone failed')` after reading the slot.

---

### [L-02] `expiration` not validated against `cloneSource.expiration()` before the flashloan  *(Low)*

**Location:** `LeverageRealUnit.sol:117` (`executeLeverage`)

**Description:** The hub's `clone()` enforces `expiration ≤ parent.expiration()`, but the check happens deep inside the flashloan callback. If the user passes an `expiration` beyond the source's expiration, the transaction reverts only after ZCHF has been pulled and the flashloan initiated, wasting significant gas and producing a confusing revert message.

**Recommendation:** Add `require(expiration <= IPositionV2(cloneSource).expiration(), 'expiration exceeds source')` at the top of `executeLeverage`, alongside the existing `require` in `_compute`.

---

## Notes

- **Info [I-01] — Stale NatSpec on `_compute`:** The doc comment still describes the old back-derivation approach ("annualInterestPPM is back-derived from the source position's `getUsableMint`"). The implementation now reads `annualInterestPPM()` directly. Update the comment to match.

- **Info [I-02] — Hardcoded mainnet addresses:** All four protocol addresses (`FLASHLOAN`, `HUB`, `ZCHF`, `REALU`) are `constant` at deploy time. This is intentional for a single-chain stateless executor, but means the contract cannot be redeployed for testnets without source changes. Consider documenting this constraint explicitly or deriving them from constructor args for testnet builds.
