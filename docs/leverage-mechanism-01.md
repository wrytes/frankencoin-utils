# Frankencoin Leverage Mechanism

Permissionless, oracle-free leverage on any PositionV2 collateral via the Frankencoin flashloan provider.

**Flashloan provider:** `0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1`

---

## Core Concept

Frankencoin is an oracle-free CDP stablecoin. The LTV of a position is determined purely by the **liquidation price** relative to the **market price** — not by a price oracle at mint time:

```
Market LTV  =  liqPrice / marketPrice
```

Because LTV is fixed by the liquidation price chosen at position creation, leverage is fully deterministic and can be computed upfront from position parameters alone.

---

## Math Overview

### Inputs

| Symbol | Description                         | Example |
| ------ | ----------------------------------- | ------- |
| M_LTV  | Market LTV = liqPrice / marketPrice | 78%     |
| Res    | Reserve contribution (PPM / 1e6)    | 20%     |
| I      | Annual interest rate (PPM / 1e6)    | 1%      |
| d      | Duration in years                   | 1y      |

### Derived Quantities

```
overcoll  =  1 − M_LTV                       e.g.  22%
user      =  1 − M_LTV + Res + I·d           e.g.  43%
credit    =  M_LTV − Res − I·d               e.g.  57%
leverage  =  1 / credit                       e.g.  1.75×
```

**`user`** is the fraction of the total position value the user must provide as value.  
**`credit`** is the fraction covered by the ZCHF flashloan (repaid by the minted ZCHF after the clone).  
**`leverage`** = `1 / credit` — the inverse of the freely minted credit portion.

> Invariant: `user + credit = 1`

---

## Position Sizing

The user deposits **ZCHF** — the neutral loan token — not the collateral directly.

### n-formula (reference quantity)

`n` is the **exact number of collateral tokens** to acquire via an exact-output DEX swap.
Solving for `n` from the self-consistency condition `deposit_max = n × (p_market − p_liq×(1−res−interest))`:

```
n = floor( deposit_max / (p_market − p_liq × (1 − res − interest)) )
```

> Note: the denominator is `p_market − p_liq×(1−res−interest)`, which is always **positive**
> because `p_market > p_liq` for any non-liquidatable position and the subtracted term
> `p_liq×(1−res−interest) < p_liq < p_market`.

With `n` known as an integer (floored), all downstream values are **exact**:

```
mintGross     = n × p_liq                              (gross ZCHF minted by leveraged clone)
reserveLocked = mintGross × res                        (locked in Frankencoin reserve)
interestCost  = mintGross × interest                   (upfront fee, deducted from mint)
mintNet       = mintGross × (1 − res − interest)       (net ZCHF out = flashloan repayment)

totalSwapZCHF = deposit_max + mintNet                  (all ZCHF swapped for n tokens)
```

Check:
```
deposit_max = totalSwapZCHF − mintNet
            = n×p_market − n×p_liq×(1−res−interest)
            = n × (p_market − p_liq×(1−res−interest))  ✓
```

---

## On-Chain Execution Flow

```
User
  │  approve ZCHF → LeverageExecutor
  │  call LeverageExecutor.executeLeverage(source, userZCHF, n, mintAmount, expiry)
  ▼
LeverageExecutor
  │  pull userZCHF from user
  │  call FlashloanFrankencoin.flashloan(source, mintNet, encodedData)   // mintNet = flashloan amount
  ▼
FlashloanFrankencoin (Morpho-backed ephemeral clone)
  │  delivers mintNet ZCHF to LeverageExecutor
  │  calls LeverageExecutor.onFrankencoinFlashloan(mintNet, data)
  ▼
LeverageExecutor (callback)
  ├─ exact-output swap: buy exactly n collateral tokens, spending userZCHF + mintNet ZCHF
  ├─ MintingHubV2.clone(source, n, mintAmount, expiry)
  │     └─ mints mintAmount (gross) ZCHF to LeverageExecutor → mintNet (net) available
  ├─ transfer leveraged position ownership to user
  └─ approve mintNet ZCHF to FlashloanFrankencoin (repayment)
```

The leveraged position (clone of `source`) remains with the user. It holds `totalColl` tokens and has `mintAmount` ZCHF of outstanding debt.

---

## LTV Identity

Since Frankencoin is oracle-free, LTV at any point in time is:

```
LTV  =  liqPrice / currentMarketPrice
```

A leveraged position has the same liquidation price as the source position (unless a new price is set at clone time using the CloneHelper). The user's effective LTV exposure is amplified by the leverage factor, but the liquidation threshold is the same.

If the market price drops to `liqPrice`, the position becomes challengeable — regardless of leverage.

---

## Constraints

-   `credit > 0` → `M_LTV > Res + I·d` (otherwise leverage is not possible)
-   `credit < 1` → `M_LTV < 1 + Res + I·d` (always true for sane positions)
-   `mintAmount ≤ position.availableForMinting()`
-   `totalColl ≥ position.minimumCollateral()`
-   Position must not be in cooldown or expired

---

## Example

| Parameter       | Value                  |
| --------------- | ---------------------- |
| Collateral      | WBTC                   |
| Market price    | 100,000 ZCHF           |
| Liq. price      | 78,000 ZCHF (per WBTC) |
| M_LTV           | 78%                    |
| Reserve (Res)   | 20%                    |
| Annual interest | 1%                     |
| Duration        | 1 year                 |

```
credit    = 0.78 − 0.20 − 0.01  = 0.57
user      = 1 − 0.57            = 0.43
leverage  = 1 / 0.57            ≈ 1.75×
```

If user deposits **10,000 ZCHF**:

```
denominator = 100,000 − 78,000 × (1 − 0.20 − 0.01)
            = 100,000 − 78,000 × 0.79
            = 100,000 − 61,620  =  38,380 ZCHF / WBTC

n           = floor( 10,000 / 38,380 )  ≈  0.26055 WBTC  (exact integer in raw units)

mintGross   = 0.26055 × 78,000  ≈  20,323 ZCHF
reserveLocked = 0.20 × 20,323  ≈   4,065 ZCHF
interestCost  = 0.01 × 20,323  ≈     203 ZCHF
mintNet     = 20,323 × 0.79    ≈  16,055 ZCHF          (flashloan repayment)

totalSwapZCHF = 10,000 + 16,055  =  26,055 ZCHF
check: 0.26055 WBTC × 100,000    =  26,055 ZCHF  ✓
```

---

## Key Contracts

| Contract             | Address                                      |
| -------------------- | -------------------------------------------- |
| FlashloanFrankencoin | `0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1` |
| MintingHubV2         | `0xDe12B620A8a714476A97EfD14E6F7180Ca653557` |
| LeverageExecutor     | TBD (pending deployment)                     |

---

## References

-   [FlashloanFrankencoin docs](./FlashloanFrankencoin.md)
-   [PositionV2 source](../../frankencoin/main/contracts/minting/v2/PositionV2.sol)
-   [MintingHubV2 source](../../frankencoin/main/contracts/minting/v2/MintingHubV2.sol)
