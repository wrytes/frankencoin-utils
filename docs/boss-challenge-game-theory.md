# Challenging a Tokenized Share Position — The BOSS Case

Lately there have been questions about what it actually means to _buy_ collateral like tokenized shares in the context of challenging a Frankencoin position. The BOSS position is a good concrete example to walk through.

---

## The Position

**Address:** `0x44Bfc2a260f091f8365ba8b240cD9491903467b9`

| Parameter                        | Value            |
| -------------------------------- | ---------------- |
| Collateral balance               | 360,000 BOSS     |
| Minimum challenge size           | 1,000 BOSS       |
| Liquidation price (set by owner) | 5 ZCHF / BOSS    |
| Current market price (Brokerbot) | ~8.5 ZCHF / BOSS |
| ZCHF minted                      | 1,800,000 ZCHF   |
| Reserve contribution             | 40%              |
| Expiration                       | 2026-11-24       |

At the current market price the position is well-collateralized: 360,000 BOSS × 8.5 ZCHF = ~3.06M ZCHF in collateral backing 1.8M ZCHF in debt. The owner set a conservative liquidation price (5 ZCHF), so a challenge today would be economically irrational — the challenger would lose the auction.

---

## How a Challenge Works

Frankencoin uses an **oracle-free CDP** model. There is no external price feed. The liquidation price is set by the position owner and enforced entirely through the challenge-auction mechanism:

1. A challenger acquires at least the **minimum collateral** (1,000 BOSS ≈ 8,503 ZCHF at current price) through the Aktionariat PaymentHub — either via the app or directly on-chain.
2. The challenger calls `MintingHubV2.challenge()`, locking the BOSS into the auction contract.
3. **Phase 1 (above liquidation price):** if a bidder steps in, the challenger and bidder exchange — collateral goes to the bidder, ZCHF goes to the challenger.
4. **Phase 2 (below liquidation price):** if no bidder appeared in phase 1, the challenger receives the collateral back **plus a 2% reward** of the actual bid.

The key constraint: **there are no flashloans**. The challenger must genuinely own and hold the collateral tokens through the entire auction period. This is by design — it aligns challenger incentives with real market exposure.

---

## The Liquidity Problem

For most collateral types (WBTC, ETH) this is trivial — deep markets, easy entry and exit. For tokenized shares like BOSS the situation is more nuanced.

**Acquiring BOSS** is straightforward: the Aktionariat Brokerbot sells shares at a bonding curve price. A challenger can acquire 1,000 BOSS on-chain in a single transaction.

**Exiting BOSS** after a successful challenge is where it gets interesting:

-   The Brokerbot's **buy-back is currently disabled** — it is not accepting BOSS in exchange for ZCHF at this time.
-   The only secondary market is the **Aktionariat marketplace**, which operates behind an authenticated API and is not openly accessible (requires email and light KYC).
-   A challenger who receives BOSS collateral back (plus the 2% reward) must therefore either hold it, find a bilateral buyer, or wait for the buy-back to be re-enabled.

A snapshot of the current order book illustrates how thin this market is (prices in ZCHF):

| Side    |    Shares | Price (ZCHF) | Remaining |
| ------- | --------: | -----------: | --------: |
| Sell    |     1,000 |        10.00 |     1,000 |
| Sell    |     2,500 |         9.25 |     2,500 |
| Sell    |     2,000 |         9.00 |     2,000 |
| Sell    |     2,000 |         8.90 |     1,975 |
| **Buy** | **2,000** |     **7.50** |     **5** |
| Buy     |    18,000 |         6.00 |    18,000 |
| Buy     |    10,000 |         5.00 |    10,000 |
| Buy     |    10,000 |         2.00 |    10,000 |

Best ask: 8.9 ZCHF. The closest buy order at 7.5 ZCHF was placed for 2,000 shares but is nearly fully filled — only 5 remaining. The next meaningful bid with actual depth sits at **6.0 ZCHF**, a spread of nearly 3 ZCHF from the ask. Anyone needing to exit a 1,000 BOSS position after a challenge would either have to accept that discount or wait.

This means a purely financial challenger — someone with no interest in holding BOSS shares — faces real exit risk. The collateral is liquid enough to _enter_ a challenge but not necessarily to exit one cleanly.

---

## Who Would Rationally Challenge?

Given the exit constraint, the rational challenger profile narrows considerably:

**Existing BOSS shareholders** already hold the token and understand the exit market. For them, acquiring an minimum of 1,000 BOSS to open a challenge is low-friction, the exit problem is irrelevant, and the 2% reward is pure upside if the challenge succeeds.

**Opportunistic buyers** who believe BOSS is undervalued relative to the liquidation price. If market price ever approached or fell below 5 ZCHF/BOSS, a challenger could acquire collateral cheaply, open a challenge, and potentially receive it back at the liquidation price — effectively buying BOSS at a discount while earning the 2% reward. The exit concern matters less when you wanted the shares anyway.

**Neither profile** is a pure arbitrageur looking to flip in and out. The design implicitly selects for challengers with a genuine view on the collateral.

---

## The Bigger Picture

BOSS is currently the largest non-BTC collateral in the Frankencoin system. The position is technically sound — conservative liquidation price, healthy collateralization ratio, long expiration. The oracle-free model works here and the Brokerbot provides a continuous, on-chain reference price that any observer can verify.

What makes this case worth discussing is not the risk but the mechanism: the challenge system is _actually enforceable_ for tokenized shares. The on-chain path from "I think this position is mispriced" to "I have opened a challenge" is fully executable in a single script. **The limiting factor is not technical — it is economic and depends on who holds the token and what they can do with it afterward.**

That is an honest trade-off, and it is one that gets more interesting as the ecosystem around Aktionariat's secondary market matures.

---

_Verified on-chain at block 24977371. Test code: [`test/ChallengePosition.ts`](../test/ChallengePosition.ts)_
