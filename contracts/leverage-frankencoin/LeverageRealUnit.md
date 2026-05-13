# LeverageRealUnit.sol — Build Brief

## What it does

A **stateless, permissionless executor** that opens a leveraged Frankencoin PositionV2 in a single transaction. The user provides ZCHF as equity; the contract handles the flashloan, DEX swap, and clone atomically. No stored state, no ownership — anyone can call it for any compatible position.

---

## Core concept: n-formula

`n` (exact collateral tokens to receive) is the single reference value. Everything else is derived from it.

```
n            = floor( deposit / (p_market − p_liq × (1 − res − interest)) )
mintGross    = n × p_liq
mintNet      = mintGross × (1 − res − interest)   ← flashloan repayment amount
totalSwap    = n × p_market                        ← deposit + mintNet
```

The DEX swap is **exact-output**: spend `totalSwap` ZCHF → receive exactly `n` collateral tokens.

Full derivation: [`docs/leverage-mechanism-02.md`](../../docs/leverage-mechanism-02.md)

---

## How it differs from `LeverageFrankencoin.sol`

| | `LeverageFrankencoin.sol` | `LeverageRealUnit.sol` |
|---|---|---|
| Ownership | `Ownable`, per-user | Stateless, permissionless |
| Flash loan | Morpho — **collateral token** | FlashloanFrankencoin — **ZCHF** |
| Swap direction | ZCHF → collateral (or reverse) | ZCHF → collateral only |
| Swap type | Exact-input (1inch) | **Exact-output** (n tokens out) |
| Operations | increase / decrease / close / roll | Open only |
| Position storage | `position` state var | None — transferred to user |

---

## Interface to implement

`LeverageRealUnit` must implement `IFrankencoinFlashLoanCallback`:

```solidity
function onFrankencoinFlashloan(uint256 amount, bytes calldata data) external;
```

Called by `FlashloanFrankencoin` after delivering `mintNet` ZCHF. Before returning, the contract must `approve(flashloanProvider, mintNet)` for repayment.

---

## Public entry point

```solidity
function executeLeverage(
    address source,       // PositionV2 to clone (must have capacity ≥ mintGross)
    uint256 userZCHF,     // equity: ZCHF pulled from msg.sender (pre-approved)
    uint256 n,            // exact collateral tokens to acquire (exact-output swap)
    uint256 mintAmount,   // mintGross: gross ZCHF to mint in the leveraged clone
    uint40  expiration    // clone expiration (≤ source original expiration)
) external returns (address leveragedPosition);
```

---

## Execution flow

```
msg.sender
  │  ZCHF.approve(LeverageRealUnit, userZCHF)
  │  call executeLeverage(source, userZCHF, n, mintAmount, expiration)
  ▼
LeverageRealUnit.executeLeverage
  │  pull userZCHF ZCHF from msg.sender
  │  call FlashloanFrankencoin.flashloan(source, mintNet, encodedData)
  │         (mintNet = mintAmount × netPPM / 1_000_000)
  ▼
FlashloanFrankencoin [0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1]
  │  borrows collateral from Morpho, clones ephemeral position
  │  mints mintNet ZCHF → sends to LeverageRealUnit
  │  calls LeverageRealUnit.onFrankencoinFlashloan(mintNet, data)
  ▼
LeverageRealUnit.onFrankencoinFlashloan  (callback)
  ├─ exact-output DEX swap:
  │    spend userZCHF + mintNet ZCHF → receive exactly n collateral tokens
  ├─ ZCHF.approve(hub, n collateral tokens already in this contract)
  ├─ hub.clone(source, n, mintAmount, expiration)
  │    → mints mintAmount gross → mintNet net ZCHF arrives here
  ├─ transfer new position ownership to original msg.sender
  └─ ZCHF.approve(FlashloanFrankencoin, mintNet)   ← repayment pull
```

---

## Encoded callback data

```solidity
abi.encode(
    address source,
    uint256 userZCHF,
    uint256 n,
    uint256 mintAmount,
    uint40  expiration,
    address recipient,   // msg.sender of executeLeverage — receives the position
    bytes   swapData     // DEX calldata: exact-output ZCHF→collateral, n tokens out
)
```

---

## Key constraints

- `mintNet` (flashloan amount) = `mintAmount × (1_000_000 − resPPM − feePPM) / 1_000_000`
- `source` must have `availableForMinting() ≥ mintAmount` at execution time
- `n ≥ source.minimumCollateral()`
- DEX swap must return **exactly** `n` tokens (exact-output); slippage must be budgeted into `n` off-chain
- `FlashloanFrankencoin` requires repayment via `approve` (pull), not `transfer`

---

## File locations

```
frankencoin-utils/
├── contracts/
│   ├── leverage-frankencoin/
│   │   ├── LeverageFrankencoin.sol              existing — Morpho-based per-user manager
│   │   ├── LeverageRealUnit.sol                 ← BUILD THIS
│   │   └── LeverageRealUnit.md                  this file
│   ├── flashloan-frankencoin/
│   │   ├── FlashloanFrankencoin.sol             deployed: 0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1
│   │   ├── IFlashloanFrankencoin.sol            call: flashloan(source, amount, data)
│   │   └── IFrankencoinFlashLoanCallback.sol    implement: onFrankencoinFlashloan(amount, data)
│   └── frankencoin/
│       ├── IMintingHubV2.sol                    call: clone(source, coll, mint, expiry)
│       └── IPositionV2.sol                      read: price(), reserveContribution(), minted()
├── docs/
│   ├── leverage-mechanism-02.md                 n-formula math and full derivation
│   └── FlashloanFrankencoin.md                  flashloan provider reference
```

---

## Relevant deployed addresses (mainnet)

| Contract             | Address                                      |
|----------------------|----------------------------------------------|
| FlashloanFrankencoin | `0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1` |
| MintingHubV2         | `0xDe12B620A8a714476A97EfD14E6F7180Ca653557` |
| ZCHF                 | `0xB58E61C3098d85632Df34EecfB899A1Ed80921cB` |
| Morpho               | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
