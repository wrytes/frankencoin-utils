# LeverageRealUnit.sol

## What it does

A **stateless, permissionless executor** that opens a leveraged Frankencoin PositionV2 backed by REALU (RealUnit, 0 decimals) in one transaction. The user provides ZCHF as equity; the contract derives all parameters on-chain, borrows the rest via a ZCHF flashloan, purchases REALU through the BrokerBot, clones the position, and returns ownership to the caller — atomically.

No stored state, no ownership, no admin keys.

---

## Core formula

All values are derived on-chain from the clone source position and the live BrokerBot price. Prices are in ZCHF with 18 decimals; REALU has 0 decimals.

```
feePPM      = annualInterestPPM × (expiration − now) / 365 days
netPPM      = 1_000_000 − resPPM − feePPM
tokens      = floor( inputAmount / (marketPrice − liqPrice × netPPM / 1e6) )
mintGross   = tokens × liqPrice
mintNet     = mintGross × netPPM / 1e6        ← flashloan amount
swapCost    = brokerbot.getBuyPrice(tokens)   ← ZCHF to acquire REALU
```

Full derivation: [`docs/leverage-mechanism-02.md`](../../docs/leverage-mechanism-02.md)

---

## Public interface

### `preview`

```solidity
function preview(
    address cloneSource,   // PositionV2 to clone
    uint256 inputAmount,   // user's ZCHF equity
    uint40  expiration,    // intended clone expiration
    IBrokerbot brokerbot   // BrokerBot for market price
) external view returns (Preview memory);
```

Returns all derived values without executing anything. Call this off-chain before `executeLeverage`.

```solidity
struct Preview {
    uint256 tokens;          // REALU collateral to acquire
    uint256 flashloanAmount; // mintNet — ZCHF borrowed via flashloan
    uint256 reserveAmount;   // ZCHF locked in Frankencoin reserve
    uint256 feeAmount;       // upfront minting interest fee
    uint256 requiredAmount;  // actual BrokerBot buy cost for tokens REALU
}
```

### `executeLeverage`

```solidity
function executeLeverage(
    address flashloanSource, // PositionV2 used as the ephemeral flashloan template
    address cloneSource,     // PositionV2 to clone as the permanent leveraged position
    uint256 inputAmount,     // ZCHF equity — pulled from msg.sender (pre-approved)
    uint40  expiration,      // clone expiration (≤ cloneSource.expiration())
    IBrokerbot brokerbot,    // BrokerBot to purchase REALU
    IPaymentHub paymentHub   // PaymentHub routing ZCHF to the BrokerBot
) external returns (address leveragedPosition);
```

---

## Execution flow

```
msg.sender
  │  ZCHF.approve(LeverageRealUnit, inputAmount)
  │  executeLeverage(flashloanSource, cloneSource, inputAmount, expiration, brokerbot, paymentHub)
  ▼
LeverageRealUnit.executeLeverage
  │  pull inputAmount ZCHF from msg.sender
  │  _compute → tokens, mintGross, mintNet
  │  flashloan(flashloanSource, mintNet, callbackData)
  ▼
FlashloanFrankencoin [0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1]
  │  mints mintNet ZCHF → sends to LeverageRealUnit
  │  calls LeverageRealUnit.onFrankencoinFlashloan(mintNet, data)
  ▼
LeverageRealUnit.onFrankencoinFlashloan  (callback)
  ├─ paymentHub.payAndNotify(brokerbot, getBuyPrice(tokens), '')
  │    → spends ZCHF from contract balance, receives tokens REALU
  ├─ HUB.clone(cloneSource, tokens, mintGross, expiration)
  │    → mints mintGross, net mintNet ZCHF arrives here; new position owned by this contract
  ├─ return ZCHF surplus (if any) to recipient
  ├─ ZCHF.forceApprove(FLASHLOAN, mintNet)   ← repayment via pull
  └─ transferOwnership(newPosition → recipient)
```

---

## Key constraints

- `expiration` must be `≤ cloneSource.expiration()` — enforced by MintingHubV2
- `cloneSource` must have `availableForMinting() ≥ mintGross` at execution time
- `tokens ≥ cloneSource.minimumCollateral()`
- `resPPM + feePPM < 1_000_000` — otherwise `_compute` reverts with underflow
- `feePPM` is `uint24`; silently truncates if `annualInterestPPM × duration / 365 days > 16_777_215`

---

## How it differs from `LeverageFrankencoin.sol`

| | `LeverageFrankencoin.sol` | `LeverageRealUnit.sol` |
|---|---|---|
| Ownership | `Ownable`, per-user instance | Stateless, permissionless |
| Flash loan asset | Collateral token (Morpho) | ZCHF (FlashloanFrankencoin) |
| Swap mechanism | 1inch exact-input | BrokerBot via PaymentHub |
| Parameters | User-supplied | Derived on-chain |
| Operations | open / increase / decrease / close | Open only |
| Position after tx | Stored in contract | Transferred to caller |

---

## Deployed addresses (mainnet)

| Contract             | Address                                      |
|----------------------|----------------------------------------------|
| FlashloanFrankencoin | `0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1` |
| MintingHubV2         | `0xDe12B620A8a714476A97EfD14E6F7180Ca653557` |
| ZCHF                 | `0xB58E61C3098d85632Df34EecfB899A1Ed80921cB` |
| REALU                | `0x553C7f9C780316FC1D34b8e14ac2465Ab22a090B` |

---

## Related files

```
frankencoin-utils/
├── contracts/leverage-frankencoin/
│   ├── LeverageRealUnit.sol
│   └── LeverageRealUnit.md              ← this file
├── contracts/flashloan-frankencoin/
│   ├── IFlashloanFrankencoin.sol        flashloan(source, amount, data)
│   └── IFrankencoinFlashLoanCallback.sol onFrankencoinFlashloan(amount, data)
├── contracts/frankencoin/
│   ├── IMintingHubV2.sol                clone(source, coll, mint, expiry)
│   └── IPositionV2.sol                  price(), reserveContribution(), annualInterestPPM()
├── contracts/brokerbot/
│   ├── IBrokerbot.sol                   getBuyPrice(tokens)
│   └── IPaymentHub.sol                  payAndNotify(brokerbot, amount, data)
└── docs/leverage-mechanism-02.md        formula derivation
```
