# Security Audit — FlashloanFrankencoin

**Date:** 2026-04-16  
**Scope:**
- `contracts/flashloan-frankencoin/FlashloanFrankencoin.sol`
- `contracts/flashloan-frankencoin/IFlashloanFrankencoin.sol`
- `contracts/flashloan-frankencoin/IFrankencoinFlashLoanCallback.sol`
- `contracts/flashloan-frankencoin/MockFlashloanRecipient.sol`
- `contracts/frankencoin/IPositionV2.sol` (referenced interface)
- `contracts/frankencoin/IMintingHubV2.sol` (referenced interface)

**Commit:** `cf2fb74`

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 1 |
| Medium   | 2 |
| Low      | 2 |
| Info     | 2 |

---

## Findings

### [H-01] `totalMint` floor division may deliver less than `amount` usable ZCHF  *(High)*

**Location:** `FlashloanFrankencoin.sol:114`

**Description:**  
`requiredCollateral` computes `totalMint` using floor division:

```solidity
totalMint = (amount * 1_000_000) / (1_000_000 - uint256(reserveContribution));
```

When `hub.clone()` mints `totalMint` ZCHF, the Frankencoin protocol deducts the reserve portion before crediting this contract. If the protocol uses floor division internally, the received balance is:

```
received = floor(totalMint * (1_000_000 - reserve) / 1_000_000)
         = floor(floor(amount * 1_000_000 / (1_000_000 - reserve)) * (1_000_000 - reserve) / 1_000_000)
```

Due to double-floor, `received` can equal `amount - 1`. The subsequent `safeTransfer(recipient, amount)` would then revert with insufficient balance, making the flash loan entirely non-functional for amounts where `amount * 1_000_000` is not exactly divisible by `(1_000_000 - reserveContribution)`.

The original code correctly used `src.getMintAmount(amount)` which the PositionV2 implements with ceiling division precisely to avoid this. The refactor dropped `getMintAmount` in favour of an inline formula that does not preserve this invariant.

**Recommendation:**  
Restore the ceiling division — either call `src.getMintAmount(amount)` from within `requiredCollateral`, or change the inline formula to:

```solidity
totalMint = (amount * 1_000_000 + (1_000_000 - uint256(reserveContribution)) - 1)
            / (1_000_000 - uint256(reserveContribution));
```

This matches ceiling semantics and guarantees `getUsableMint(totalMint) >= amount`.

---

### [M-01] `onMorphoFlashLoan` not protected by `nonReentrant`  *(Medium — FIXED)*

**Location:** `FlashloanFrankencoin.sol:69`

**Description:**  
`flashloan()` is guarded by `nonReentrant`, but `onMorphoFlashLoan` is not. During the `onFrankencoinFlashloan` callback, a malicious or compromised recipient could call `morpho.flashLoan()` directly (bypassing `flashloan()`), causing Morpho to re-enter `onMorphoFlashLoan` while the outer callback is still executing. At re-entry point the contract has outstanding collateral approvals set to `hub` and `morpho`, and a live clone with minted ZCHF — state that a crafted inner call could exploit.

**Resolution:**  
`nonReentrant` added to `onMorphoFlashLoan`.

---

### [M-02] `source` address is not validated against the hub registry  *(Medium — ACKNOWLEDGED)*

**Location:** `FlashloanFrankencoin.sol:57–62`

**Description:**  
`source` is arbitrary caller input. The contract calls `IPositionV2(source).collateral()`, `.price()`, `.reserveContribution()`, and `.minimumCollateral()` without verifying that `source` is a position registered with the hub. A malicious contract implementing `IPositionV2` could return inconsistent values or manipulate `requiredCollateral` output.

**Resolution:**  
Acknowledged — `hub.clone(source, ...)` validates the parent position against the hub's internal registry and reverts for any unregistered or invalid address. The Frankencoin MintingHubV2 and its factory enforce this invariant, providing an equivalent guard without the extra read.

---

### [L-01] No `availableForMinting()` preflight check  *(Low)*

**Location:** `FlashloanFrankencoin.sol:56`

**Description:**  
`flashloan()` does not verify `source.availableForMinting() >= totalMint` before calling `morpho.flashLoan()`. If the position lacks minting headroom, `hub.clone()` reverts deep inside the Morpho callback — Morpho surfaces this as a generic revert with no meaningful error message, and the caller wastes the full gas cost of the Morpho flash loan setup.

**Recommendation:**  
Add a preflight revert in `flashloan()`:

```solidity
if (IPositionV2(source).availableForMinting() < totalMint) revert InsufficientMintingCapacity();
```

---

### [L-02] `source` expiration not validated  *(Low)*

**Location:** `FlashloanFrankencoin.sol:56`

**Description:**  
There is no check that `source` has not expired. An expired position will cause `hub.clone()` to revert inside the Morpho callback. Like L-01, this fails late and wastes gas, and the error is opaque to the caller.

**Recommendation:**  
Add to `flashloan()`:

```solidity
if (IPositionV2(source).expiration() <= block.timestamp) revert PositionExpired();
```

---

### [I-01] Stale double-slash comment artifacts  *(Info)*

**Location:** `FlashloanFrankencoin.sol:80, 84, 89`

**Description:**  
Lines 80, 84, and 89 contain `// //` prefixes — artifacts from a prior edit. They render as blank comments and are visually confusing.

**Recommendation:**  
Remove the extra `//` prefix from each affected line.

---

### [I-02] `totalMint` not included in `Flashloan` event  *(Info)*

**Location:** `FlashloanFrankencoin.sol:40–46, 64`

**Description:**  
`totalMint` is now a first-class output of `requiredCollateral` and is central to the protocol's economics, but it is not emitted in the `Flashloan` event. Off-chain indexers and dashboards that want to compute reserve flows must re-derive it.

**Recommendation:**  
Add `uint256 totalMint` to the `Flashloan` event and emit it alongside `collAmount` and `amount`.

---

## Notes

- **Gas**: `src.collateral()` is called twice — once in `flashloan()` (line 60) and once in `onMorphoFlashLoan` (line 78). The second call is unavoidable (callback context), but the result could be encoded into cbData alongside `totalMint` to save one external call.
- **`block.timestamp + 1` clone expiration**: This satisfies PositionV2's strict `>` check and is correct for atomic execution. No issue.
- **`ReentrancyGuard` inheritance**: Correctly used. The `nonReentrant` modifier on `flashloan()` is appropriate; the gap noted in M-01 is the only exposure.
- **`forceApprove` usage**: Correct — avoids the ERC-20 double-approve race on tokens that enforce a zero-first pattern.
