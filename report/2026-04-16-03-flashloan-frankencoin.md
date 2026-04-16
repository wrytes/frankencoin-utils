# Security Audit — FlashloanFrankencoin

**Date:** 2026-04-16  
**Scope:**
- `contracts/flashloan-frankencoin/FlashloanFrankencoin.sol`
- `contracts/flashloan-frankencoin/IFlashloanFrankencoin.sol`
- `contracts/flashloan-frankencoin/IFrankencoinFlashLoanCallback.sol`
- `contracts/flashloan-frankencoin/MockFlashloanRecipient.sol`
- `contracts/frankencoin/IPositionV2.sol`
- `contracts/frankencoin/IMintingHubV2.sol`
- `contracts/frankencoin/IFrankencoin.sol`

**Commit:** `cf2fb74` → resolved in subsequent changes  
**Previous reports:** `02` (resolved H-01 partially by switching formula; M-01 reentrancy guard reverted — breaks call chain; M-02 acknowledged)

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 1 |
| Medium   | 1 |
| Low      | 2 |
| Info     | 2 |

---

## Findings

### [H-01] `collateral * price / 1e18` floor division can deliver `amount − 1` usable ZCHF  *(High — FIXED)*

**Location:** `FlashloanFrankencoin.sol:114`

**Description:**  
`totalMint = collateral * price / 1e18` used floor division. When `hub.clone()` mints `totalMint` and the protocol deducts the reserve portion, double floor can yield `received = amount − 1`, causing `safeTransfer(recipient, amount)` to revert.

Note: `src.getMintAmount(amount)` is NOT a valid fix here — it computes fees using the source position's own expiration date, whereas the clone uses `block.timestamp + 1`. The fee components are completely different, making `getMintAmount` semantically incorrect for this use case.

**Resolution:**  
Ceiling division applied: `totalMint = (collateral * price + 1e18 - 1) / 1e18`. This guarantees `received ≥ amount` without depending on the source's expiration-based fee calculation.

---

### [M-01] `onMorphoFlashLoan` reentrancy surface — `nonReentrant` cannot be applied  *(Medium — Acknowledged)*

**Location:** `FlashloanFrankencoin.sol:69`

**Description:**  
`flashloan()` holds the `nonReentrant` lock while `morpho.flashLoan()` executes synchronously and calls back into `onMorphoFlashLoan`. Adding `nonReentrant` to `onMorphoFlashLoan` itself would deadlock on the same lock, which is why it was reverted.

The residual risk: during `onFrankencoinFlashloan`, a malicious recipient could call `morpho.flashLoan()` directly (not via `flashloan()`), causing Morpho to invoke `onMorphoFlashLoan` again while the outer callback is mid-execution. At that point the contract holds live collateral approvals to `hub` and `morpho` and has an open clone.

**Mitigations already in place:**
- `msg.sender != address(morpho)` guard limits callers to the trusted Morpho singleton.
- Any inner flash loan still requires Morpho to return its collateral, bounding exploitability.
- The `nonReentrant` on `flashloan()` blocks recursive entry through the public interface.

**Recommendation:**  
Introduce a private `_locked` boolean flag set to `true` on entry to `onMorphoFlashLoan` and reset on exit, checked at the top of the function. This is equivalent to `nonReentrant` but operates on a separate lock from `flashloan()`:

```solidity
bool private _morphoLock;

function onMorphoFlashLoan(...) external {
    if (_morphoLock) revert Reentrant();
    _morphoLock = true;
    // ... body ...
    _morphoLock = false;
}
```

---

### [L-01] No `availableForMinting()` preflight check  *(Low — FIXED)*

**Location:** `FlashloanFrankencoin.sol:118`

**Description:**  
If `source.availableForMinting() < totalMint`, `hub.clone()` reverts deep inside the Morpho callback with no meaningful error, wasting the full gas cost of the flash loan setup.

**Resolution:**  
`if (src.availableForMinting() < totalMint) revert InsufficientMintingCapacity();` added at the end of `requiredCollateral()`, after `totalMint` is computed. Surfaces the error early as a view call.

---

### [L-02] Expired `source` position not rejected  *(Low — FIXED)*

**Location:** `FlashloanFrankencoin.sol:111`

**Description:**  
No check that the source position has not expired. An expired position causes `hub.clone()` to revert inside the Morpho callback — same late-failure pattern as L-01.

**Resolution:**  
`if (IPositionV2(src.original()).expiration() <= block.timestamp) revert PositionExpired();` added in `requiredCollateral()`. Uses `src.original()` to check the original position's expiration rather than any clone's, which is the authoritative liveness check.

---

### [I-01] Double `// //` comment artifacts  *(Info — FIXED)*

**Location:** `FlashloanFrankencoin.sol` (prior lines 80, 84, 89)

Removed by linter.

---

### [I-02] `totalMint` absent from `Flashloan` event  *(Info — FIXED)*

**Location:** `FlashloanFrankencoin.sol:42–48`

`totalMint` added to the `Flashloan` event; `collToken` index removed (reducing indexed topics from 3 to 2, freeing a slot for `totalMint` as a non-indexed value).

---

## Notes

- **`collateral` ceiling is correct.** The `max(minimumCollateral, ceil(...))` formula is sound and no change is needed there.
- **`block.timestamp + 1` clone expiration** satisfies PositionV2's strict `>` invariant atomically. No issue.
- **`forceApprove` usage** correctly avoids the ERC-20 double-approval race. No issue.
- **Overflow in `collateral * price`**: for realistic asset prices and collateral amounts the product stays well within `uint256`. No issue.
