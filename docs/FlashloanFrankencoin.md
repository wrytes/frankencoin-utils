# FlashloanFrankencoin

Permissionless ZCHF flash-loan provider. Enables borrowing any amount of ZCHF in a single transaction — with no pre-funded liquidity pool — by minting against an ephemeral clone of an existing PositionV2 collateralised by a Morpho flash loan.

**Mainnet:** `0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1`

---

## Overview

ZCHF can only be minted against collateral locked in a Frankencoin PositionV2. `FlashloanFrankencoin` automates this end-to-end within a single atomic transaction:

1. Borrows the required collateral from Morpho (flash loan).
2. Clones an existing source position with that collateral, causing the hub to mint ZCHF here.
3. Delivers the requested ZCHF amount to the caller and invokes its callback.
4. Pulls the ZCHF back, closes the clone (burns all minted ZCHF, returns collateral).
5. Repays Morpho.

No governance approval, no pre-funded reserve, no leftover state.

---

## Architecture

```
Caller
  │
  ▼
FlashloanFrankencoin.flashloan(source, amount, data)
  │
  ├─► requiredCollateral(source, amount)          view: compute coll + totalMint
  │
  └─► morpho.flashLoan(collToken, collNeeded, cbData)
            │
            └─► onMorphoFlashLoan(collAssets, cbData)   [Morpho callback]
                  │
                  ├─► hub.clone(source, collAssets, totalMint, expiry)
                  │       └─► mints totalMint ZCHF here
                  │
                  ├─► transfer amount ZCHF ──► Caller
                  ├─► Caller.onFrankencoinFlashloan(amount, data)
                  ├─► pull amount ZCHF ◄── Caller
                  │
                  ├─► clone.adjust(0, 0, price)          closes clone, burns ZCHF
                  │       └─► returns collateral here
                  │
                  └─► approve + repay collateral ──► Morpho
```

---

## Interfaces

### IFlashloanFrankencoin — entry point

```solidity
function flashloan(address source, uint256 amount, bytes calldata data) external;
```

### IFrankencoinFlashLoanCallback — must be implemented by the caller

```solidity
function onFrankencoinFlashloan(uint256 amount, bytes calldata data) external;
```

The callback is invoked while `amount` ZCHF sits in the caller's balance. The caller must approve `msg.sender` (the `FlashloanFrankencoin` contract) for at least `amount` ZCHF before the callback returns so the repayment pull succeeds.

---

## Functions

### `flashloan`

```solidity
function flashloan(address source, uint256 amount, bytes calldata data) external nonReentrant
```

Public entry point. Initiates the full flash-loan sequence described above.

| Parameter | Description |
|-----------|-------------|
| `source`  | Address of an existing, non-expired PositionV2 to clone. Determines collateral token, price, and reserve. |
| `amount`  | ZCHF to deliver to the caller (net of reserve). |
| `data`    | Arbitrary bytes forwarded verbatim to `onFrankencoinFlashloan`. |

Emits `Flashloan(source, recipient, collAmount, totalMint, amount)`.

---

### `requiredCollateral`

```solidity
function requiredCollateral(address source, uint256 amount)
    public view
    returns (uint256 collateral, uint256 totalMint)
```

Returns the collateral amount and gross mint amount needed to deliver `amount` ZCHF from the given source position.

**Collateral formula (ceiling division):**

```
totalMint  = ceil(amount / (1 - reservePPM / 1e6))
collateral = ceil(totalMint × 1e18 / price)
collateral = max(collateral, source.minimumCollateral())
totalMint  = ceil(collateral × price / 1e18)
```

The gross mint (`totalMint`) is always larger than `amount`; the difference goes to the Frankencoin reserve as `reservePPM` dictates.

Reverts with:

| Error | Condition |
|-------|-----------|
| `ZeroPriceOrAmount()` | `price == 0` or `amount == 0` |
| `FullReserve()` | `reserveContribution >= 1_000_000` |
| `PositionExpired()` | source position has expired |
| `InsufficientMintingCapacity()` | `totalMint > source.availableForMinting()` |

---

## Events

```solidity
event Flashloan(
    address indexed source,
    address indexed recipient,
    uint256 collAmount,
    uint256 totalMint,
    uint256 amount
);
```

| Field | Description |
|-------|-------------|
| `source` | The PositionV2 cloned for this loan |
| `recipient` | Caller who received the ZCHF |
| `collAmount` | Collateral borrowed from Morpho |
| `totalMint` | Gross ZCHF minted (amount + reserve contribution) |
| `amount` | Net ZCHF delivered to the recipient |

---

## Errors

| Error | Description |
|-------|-------------|
| `NotMorpho()` | `onMorphoFlashLoan` called by an address other than Morpho |
| `ZeroPriceOrAmount()` | Source position price is zero or loan amount is zero |
| `FullReserve()` | Source position reserve is 100 % — no net ZCHF can be delivered |
| `PositionExpired()` | Source position (or its original) has expired |
| `InsufficientMintingCapacity()` | Loan would exceed the source position's remaining minting limit |

---

## Choosing a Source Position

Any live, non-expired PositionV2 on Frankencoin can serve as a source. Key considerations:

- **Collateral token** — the caller must be comfortable with Morpho being able to supply that token (Morpho holds the collateral in its pool).
- **`reserveContribution`** — higher reserve means a larger gross mint and more collateral required per unit of ZCHF borrowed.
- **`availableForMinting`** — caps the maximum loan size from that source.
- **Expiry** — the source's `original` expiration must be strictly in the future.

Call `requiredCollateral(source, amount)` off-chain to preview the collateral cost before transacting.

---

## Implementing a Flash-Loan Receiver

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IFrankencoinFlashLoanCallback} from "./IFrankencoinFlashLoanCallback.sol";
import {IFlashloanFrankencoin} from "./IFlashloanFrankencoin.sol";

contract MyReceiver is IFrankencoinFlashLoanCallback {
    IERC20 public immutable zchf;
    IFlashloanFrankencoin public immutable flashloan;

    constructor(address _zchf, address _flashloan) {
        zchf = IERC20(_zchf);
        flashloan = IFlashloanFrankencoin(_flashloan);
    }

    /// Initiates a flash loan of `amount` ZCHF from `source` position.
    function trigger(address source, uint256 amount, bytes calldata data) external {
        flashloan.flashloan(source, amount, data);
    }

    /// Called by FlashloanFrankencoin while `amount` ZCHF is in this contract.
    function onFrankencoinFlashloan(uint256 amount, bytes calldata data) external override {
        require(msg.sender == address(flashloan), "unauthorized");

        // ── your logic here ──────────────────────────────────────
        // e.g. swap, arbitrage, repay debt, liquidate a position

        // Approve repayment before returning
        zchf.approve(msg.sender, amount);
    }
}
```

---

## Example Transaction

**Mainnet tx:** [`0x5cacd42f...`](https://etherscan.io/tx/0x5cacd42fdb7293c617b3801776f8db9e48e5b0b09f7d3e160c0acd0280fb54e7)

| Field | Value |
|-------|-------|
| Source position | `0x5F2c10f...` (cbBTC-backed) |
| Loan amount | 100,000 ZCHF |
| Total minted | 125,000 ZCHF (20 % reserve contribution) |
| Collateral borrowed | 2.77777778 cbBTC (~$206k) |
| Clone created | `0x1d48f87...` (destroyed same tx) |
| Gas used | 450,279 (~$0.43) |

The ephemeral clone is opened and closed within the same transaction — no lasting on-chain state is created by the loan itself.

---

## Deployment

Constructor arguments:

| Parameter | Value |
|-----------|-------|
| `_morpho` | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| `_hub` | `0xDe12B620A8a714476A97EfD14E6F7180Ca653557` |

`zchf` is resolved automatically from `hub.zchf()` at construction time.
