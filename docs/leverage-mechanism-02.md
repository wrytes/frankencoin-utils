# Frankencoin Leverage — n-Based Approach

The central idea: **n** (the exact number of collateral tokens to acquire) is computed first from the user's deposit and the position parameters. Every other figure — mint amount, flashloan size, reserve, interest, equity ratio, leverage — is derived from n. This makes all on-chain values exact integers and the DEX swap an exact-output call.

---

## The n Formula

```
n = floor( deposit / (p_market − p_liq × (1 − res − interest)) )
```

| Symbol     | Description                                                  |
|------------|--------------------------------------------------------------|
| `deposit`  | ZCHF the user provides (the "equity" / neutral loan token)   |
| `p_market` | Market price of the collateral in ZCHF (user-selectable)     |
| `p_liq`    | Liquidation price set in the PositionV2 clone (ZCHF / token) |
| `res`      | Reserve contribution ratio (`reservePPM / 1_000_000`)        |
| `interest` | Upfront interest ratio (`annualPPM × durationSecs / 365days / 1_000_000`) |

The denominator `p_market − p_liq×(1−res−interest)` is always **positive** for any live, non-liquidatable position, because `p_market > p_liq` by definition and `p_liq×(1−res−interest) < p_liq < p_market`.

The result is **floored** to the collateral's decimal precision via integer division — no rounding up, no floating-point error.

---

## Everything Derived from n

Once n is known, all downstream values follow from exact BigInt arithmetic:

```
mintGross       = n × p_liq                        (gross ZCHF minted by the leveraged clone)
reserveLocked   = mintGross × res                  (locked in Frankencoin reserve)
interestCost    = mintGross × interest             (upfront fee, taken from mint)
mintNet         = mintGross × (1 − res − interest) (net ZCHF out of clone = flashloan repayment)

totalSwap       = n × p_market                     (total ZCHF going into the DEX swap)
flashloan       = totalSwap − deposit              (≈ mintNet, the credit provided)
```

Verification:
```
deposit  =  n × p_market  −  n × p_liq × (1−res−interest)
         =  n × (p_market − p_liq×(1−res−interest))         ✓
```

---

## Equity and Credit

From the actual computed values (not from theoretical LTV ratios):

```
equity    =  deposit / totalSwap         (fraction the user provides)
credit    =  1 − equity                  (fraction the flashloan covers)
leverage  =  1 / credit  =  totalSwap / mintNet
```

These are derived from real amounts, so they correctly reflect the flooring of n.

---

## On-Chain Flow

```
User
  │  approve deposit ZCHF → LeverageExecutor
  │  call executeLeverage(source, deposit, n, mintGross, expiry)
  ▼
LeverageExecutor
  │  pull deposit ZCHF from user
  │  call FlashloanFrankencoin.flashloan(source, mintNet, data)
  ▼
FlashloanFrankencoin
  │  mints mintNet net ZCHF to LeverageExecutor via ephemeral clone
  │  calls LeverageExecutor.onFrankencoinFlashloan(mintNet, data)
  ▼
LeverageExecutor (callback)
  ├─ exact-output swap: spend deposit + mintNet ZCHF → receive exactly n tokens
  ├─ MintingHubV2.clone(source, n, mintGross, expiry)
  │     └─ clone mints mintGross gross → mintNet net ZCHF to executor
  ├─ transfer position ownership to user
  └─ approve mintNet ZCHF to FlashloanFrankencoin (repayment)
```

The DEX swap is **exact-output**: `n` tokens out, `totalSwap = deposit + mintNet` ZCHF in. The swap router receives the combined ZCHF in one call — no partial fills.

---

## Breakdown

| Line                    | Value                                     |
|-------------------------|-------------------------------------------|
| Flashloan (total swap)  | `n × p_market`                            |
| − Left from minted      | `mintNet = mintGross × (1−res−interest)`  |
| = Left to pay (user)    | `deposit`                                 |

This confirms: `totalSwap = mintNet + deposit`. The flashloan is entirely self-funded by the position's net mint plus the user's equity.

---

## BigInt Implementation Notes

Prices in the Frankencoin system carry `36 − collateralDecimals` decimal places. To compute the denominator in consistent 18-decimal units:

```typescript
// Normalise liqPrice and marketPrice to 18 decimals
liqPrice18 = priceDigit >= 18
    ? liqPriceBigInt / 10n**(priceDigit - 18)
    : liqPriceBigInt * 10n**(18 - priceDigit)

// creditPerToken18 = p_liq × (1 − res − interest), all in 18-dec
const netPPM = 1_000_000n - resPPM - interestPPM
creditPerToken18 = liqPrice18 * netPPM / 1_000_000n

// denominator in 18-dec ZCHF per token
denominator18 = marketPrice18 - creditPerToken18

// n in raw collateral units (floor via integer division)
n = userZCHF * 10n**collDecimals / denominator18
```

Downstream:
```typescript
mintGross = n * liqPriceBigInt / 10n**18n
// n has collDecimals, liqPrice has 36-collDecimals → product has 36 dec → /1e18 = 18 dec ZCHF

totalSwap = n * marketPrice18 / 10n**collDecimals
// n has collDecimals, marketPrice18 has 18 dec → product has collDecimals+18 → /10^collDecimals = 18 dec ZCHF
```

Interest mirrors `PositionV2.calculateFee` exactly:
```typescript
interestPPM = floor( annualInterestPPM * durationSecs / (365 * 24 * 3600) )
```

---

## Example

| Parameter       | Value              |
|-----------------|--------------------|
| Collateral      | REALU (0 decimals) |
| `p_market`      | 1.43 ZCHF          |
| `p_liq`         | 1.20 ZCHF          |
| Reserve         | 15%                |
| Annual interest | 1%                 |
| Duration        | 1 year             |
| Deposit         | 10,000 ZCHF        |

```
interest        = 0.01 × 1.00           = 0.01
1 − res − int   = 1 − 0.15 − 0.01      = 0.84
creditPerToken  = 1.20 × 0.84           = 1.008 ZCHF
denominator     = 1.43 − 1.008          = 0.422 ZCHF / token

n               = floor(10,000 / 0.422) = 23,696 tokens

mintGross       = 23,696 × 1.20         = 28,435.20 ZCHF
reserveLocked   = 28,435.20 × 0.15      =  4,265.28 ZCHF
interestCost    = 28,435.20 × 0.01      =    284.35 ZCHF
mintNet         = 28,435.20 × 0.84      = 23,885.57 ZCHF

totalSwap       = 23,696 × 1.43         = 33,885.28 ZCHF
flashloan       = 33,885.28 − 10,000    = 23,885.28 ZCHF  ≈ mintNet ✓

equity          = 10,000 / 33,885.28    = 29.51%
credit          = 1 − 0.2951            = 70.49%
leverage        = 1 / 0.7049            ≈ 1.42×
```

---

## Key Contracts

| Contract             | Address                                      |
|----------------------|----------------------------------------------|
| FlashloanFrankencoin | `0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1` |
| MintingHubV2         | `0xDe12B620A8a714476A97EfD14E6F7180Ca653557` |
| LeverageExecutor     | TBD (pending deployment)                     |

---

## References

- [FlashloanFrankencoin docs](./FlashloanFrankencoin.md)
- [Original leverage math](./leverage-mechanism.md)
- [PositionV2 source](../../frankencoin/main/contracts/minting/v2/PositionV2.sol)
