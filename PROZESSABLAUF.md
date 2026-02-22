# sAVAX Loop Bot – Detaillierter Prozessablauf

## Inhaltsverzeichnis
1. [Loop aufbauen (buildLoop)](#1-loop-aufbauen-buildloop)
2. [Loop abbauen (unwindLoop)](#2-loop-abbauen-unwindloop)
3. [HF-Monitor (monitor)](#3-hf-monitor-monitor)
4. [KyberSwap Swap-Prozess](#4-kyberswap-swap-prozess)
5. [Berechnungsformeln](#5-berechnungsformeln)
6. [Zustandsmaschine & Entscheidungslogik](#6-zustandsmaschine--entscheidungslogik)

---

## 1. Loop aufbauen (buildLoop)

### Übersicht

```
START
  │
  ├─ [INIT] E-Mode Kategorie 2 aktivieren
  │         (sAVAX/WAVAX korreliert, LTV 93%)
  │
  ├─ [INIT] sAVAX in Wallet vorhanden?
  │    JA → Supply sAVAX direkt auf Aave
  │
  ├─ [INIT] Collateral = 0 nach Supply?
  │    JA → AVAX → sAVAX (KyberSwap) → Supply
  │    NEIN → weiter
  │
  └─ LOOP (bis MAX_ITERATIONS oder Ziel erreicht)
       │
       ├─ Snapshot: HF, Leverage, Collateral, Debt
       ├─ Risk-Assessment: LOOP_MORE / HOLD / DELEVERAGE?
       │    HOLD/DELEVERAGE → Stoppe Loop
       │
       ├─ Berechne Borrow-Betrag (→ Ziel-HF nach Iteration)
       ├─ Borrow WAVAX von Aave
       ├─ Unwrap WAVAX → native AVAX
       ├─ Swap AVAX → sAVAX (KyberSwap)
       ├─ Supply sAVAX auf Aave
       └─ Weiter → nächste Iteration
```

### Schritt-für-Schritt

#### INIT Phase

**Schritt 1: E-Mode aktivieren**
```
aave.getUserEMode()  →  aktuell = 2?
  NEIN → pool.setUserEMode(2)  [on-chain Tx]
  JA  → überspringen
```

**Schritt 2: Wallet-sAVAX supplyen**
```
aave.getBalance(sAVAX)  →  walletSAvax
  > 0 → sAVAX.approve(pool, walletSAvax)  [on-chain Tx]
         pool.supply(sAVAX, walletSAvax)   [on-chain Tx]
  = 0 → überspringen
```

**Schritt 3: Falls Collateral noch leer → AVAX staken**
```
pool.getUserAccountData()  →  totalCollateralBase
  = 0 →
    getNativeBalance()  →  avaxBalance
    stakeAmount = avaxBalance - gasReserve (0.1 AVAX)

    stakeAmount < 0.01 AVAX?
      → FEHLER: Zu wenig AVAX

    KyberSwap.swap(AVAX → sAVAX, stakeAmount)  [on-chain Tx]
    sAVAX.approve(pool, sAvaxReceived)          [on-chain Tx]
    pool.supply(sAVAX, sAvaxReceived)           [on-chain Tx]
```

#### LOOP Phase (pro Iteration)

**Schritt 4: Risk-Assessment**
```
pool.getUserAccountData()  →  HF, Leverage, Debt, Collateral

RiskEngine.assess():
  HF < emergencyHF (1.01)  → EMERGENCY_DELEVERAGE  → Stoppe
  HF < minHFForAction       → DELEVERAGE            → Stoppe
  Debt = 0                  → LOOP_MORE
  Leverage < targetLeverage
    UND HF > targetHF       → LOOP_MORE
  sonst                     → HOLD                  → Stoppe
```

**Schritt 5: Borrow-Betrag berechnen**
```
KyberSwap.fetchQuoteOnly(AVAX → sAVAX, 1 AVAX)
  → kyberAvaxPerSAvax = 1 / (amountOut / 1e18)

RiskEngine.calculateNextBorrowAmount(snapshot, kyberAvaxPerSAvax):

  Wenn kein Debt (erste Iteration):
    borrowUsd = availableBorrowsUsd × 0.8   (80% Safety)

  Sonst (Formel für Ziel-HF):
    Numerator   = targetHF × Debt - Collateral × LT
    Denominator = sAvaxRatio × LT - targetHF

    Denominator ≤ 0 → kein weiterer Borrow möglich (0n)

    borrowUsd = |Numerator / Denominator|
    borrowUsd = min(borrowUsd, availableBorrows × 0.9)
    borrowUsd < $1 → 0n (nicht sinnvoll)

borrowAmountBase (USD, 8 dec)
  → aave.getAssetPrice(WAVAX)  →  wavaxPriceUsd
  → borrowToken = borrowAmountBase × 1e18 / wavaxPriceUsd
```

**Schritt 6: Borrow → Unwrap → Swap → Supply**
```
pool.borrow(WAVAX, borrowToken, variableRate=2)  [on-chain Tx]
WAVAX.withdraw(borrowToken)  (= Unwrap)          [on-chain Tx]

avaxAfterUnwrap = getNativeBalance()
swapAmount = min(avaxAfterUnwrap - gasReserve, borrowToken)

KyberSwap.swap(AVAX → sAVAX, swapAmount)  [on-chain Tx]
  sAvaxReceived = amountOut aus Build-Response

sAvaxReceived = 0? → STOPP (Fehler)

sAVAX.approve(pool, sAvaxReceived)         [on-chain Tx]
pool.supply(sAVAX, sAvaxReceived)          [on-chain Tx]
```

---

## 2. Loop abbauen (unwindLoop)

### Übersicht

```
START
  │
  └─ LOOP (bis Debt < $0.01 oder MAX_ITER=50)
       │
       ├─ Snapshot: HF, Leverage, Debt, Collateral
       │
       ├─ Debt < $0.01?
       │    JA → Withdraw verbleibendes Collateral → FERTIG
       │
       ├─ Berechne maximalen Repay-Betrag
       │    (HF nach Iteration ≥ 1.05)
       │
       ├─ Berechne Withdraw-Betrag
       │    (repayUsd × sAvaxRatio × Slippage-Buffer)
       │
       ├─ Clamp 1: HF-Limit
       │    maxWithdrawUsd = Collateral - (1.03 × Debt / LT)
       │    maxWithdrawUsd ≤ 0?
       │      → Direkt-Repay aus Wallet (AVAX/sAVAX)
       │      → continue (nächste Iteration)
       │
       ├─ Clamp 2: aToken-Balance
       │    asAVAX.balanceOf(user) → Obergrenze
       │
       ├─ Withdraw sAVAX from Aave
       ├─ Swap sAVAX → AVAX (KyberSwap)
       ├─ Wrap AVAX → WAVAX
       ├─ Repay WAVAX an Aave
       └─ Weiter → nächste Iteration
```

### Schritt-für-Schritt

#### Repay-Betrag berechnen

**Ziel:** So viel wie möglich repay'en, aber HF nach dem Repay ≥ 1.05

```
sAvaxRatio = sAvaxPriceUsd / wavaxPriceUsd
             (typisch ~1.07–1.10, da sAVAX > AVAX)

Denominator = safetyHF (1.05) - sAvaxRatio × LT (0.95)
            = 1.05 - 1.08 × 0.95
            = 1.05 - 1.026
            = 0.024

Denominator ≤ 0 ODER Debt × safetyHF ≤ Collateral × LT?
  → Alles auf einmal repay'en (repayUsd = totalDebtUsd)

Sonst:
  repayUsd = (Debt × safetyHF - Collateral × LT) / Denominator
  repayUsd = min(repayUsd, totalDebtUsd)

repayWavax = repayUsd × 1e18 / wavaxPriceUsd  (Token-Betrag)
```

#### Withdraw-Betrag berechnen & clampen

```
withdrawUsd = repayUsd × sAvaxRatio × (1 + slippageBps/10000)

withdrawSAvax = withdrawUsd × 1e18 / sAvaxPriceUsd

──── Clamp 1: HF-Sicherheit (vor Repay) ────
maxWithdrawUsd = Collateral - (1.03 × Debt / LT)

  maxWithdrawUsd ≤ 0?
    → HF zu niedrig für Withdraw
    → Direkt-Repay aus Wallet:
        1. usableAvax = walletAvax - gasReserve (0.1 AVAX)
        2. usableAvax > 0 → wrapAvax → repayWavax
        3. walletSAvax > 0 → swapSAvaxForAvax → wrapAvax → repayWavax
        4. continue (nächste Iteration)

maxWithdrawSAvax = maxWithdrawUsd × 1e18 / sAvaxPriceUsd
withdrawSAvax = min(withdrawSAvax, maxWithdrawSAvax)

──── Clamp 2: aToken-Balance ────
aSAvaxBalance = asAVAX.balanceOf(user)
withdrawSAvax = min(withdrawSAvax, aSAvaxBalance)

withdrawSAvax = 0? → ABBRUCH
```

#### Withdraw → Swap → Wrap → Repay

```
sAvaxBefore = sAVAX.balanceOf(user)
pool.withdraw(sAVAX, withdrawSAvax, user)  [on-chain Tx]
sAvaxAfter  = sAVAX.balanceOf(user)

swapAmount = sAvaxAfter - sAvaxBefore   (Balance-Differenz)
           Falls Differenz = 0 → Fallback: withdrawSAvax

KyberSwap.swap(sAVAX → AVAX, swapAmount)  [on-chain Tx]
  avaxReceived = amountOut aus Build-Response

wrapAmount = min(avaxReceived, repayWavax)
WAVAX.deposit{ value: wrapAmount }()       [on-chain Tx]  (= Wrap)

WAVAX.approve(pool, wrapAmount)            [on-chain Tx]
pool.repay(WAVAX, wrapAmount, variableRate=2, user)  [on-chain Tx]
```

#### Abschluss (wenn Debt < $0.01)

```
pool.withdraw(sAVAX, MaxUint256, user)  [on-chain Tx]
  (MaxUint256 = kompletter Withdraw aller verbleibenden sAVAX)

Falls MaxUint256-Withdraw fehlschlägt → Fallback:
  verbleibendesSAvax = totalCollateralUsd × 0.999 × 1e18 / sAvaxPriceUsd
  pool.withdraw(sAVAX, verbleibendesSAvax, user)
```

---

## 3. HF-Monitor (monitor)

### Ablauf

```
Monitor.start()
  │
  ├─ Sofortiger erster Tick
  └─ Interval alle 30s (konfigurierbar)
       │
       ├─ getAccountSnapshot()
       ├─ RiskEngine.assess()
       │
       ├─ HF < emergencyHF (1.01)?
       │    → emergencyDeleverage()
       │       (Ziel: minHFForAction + 0.15)
       │
       ├─ HF < minHFForAction (1.01)?
       │    → deleverage()
       │       (Ziel: minHFForAction + 0.1)
       │
       ├─ Assessment = LOOP_MORE?
       │    → NUR Info-Ausgabe, KEIN auto-Loop
       │       (manuell mit: npm run loop)
       │
       └─ Assessment = HOLD?
            → Nichts tun

Fehler-Handling:
  5 aufeinanderfolgende Fehler → Monitor stoppt sich selbst
```

---

## 4. KyberSwap Swap-Prozess

Jeder Swap läuft in 4 Phasen:

```
Phase 1: GET /routes
  Parameter: tokenIn, tokenOut, amountIn, excludedSources=dexalot
  Antwort:   routeSummary (Route-Details), routerAddress

  amountOutMin = amountOut × (10000 - slippageBps) / 10000

Phase 2: POST /route/build
  Parameter: routeSummary, sender, recipient, slippageTolerance
  Antwort:   routerAddress, calldata (data), transactionValue,
             gas, amountOut (nach Slippage)

  Bei RFQ-Fehler (Dexalot) → Retry bis 3×

Phase 3: walletClient.sendTransaction()
  to:    routerAddress
  data:  calldata
  value: transactionValue (bei AVAX-Input = amountIn)
  gas:   geschätzter Gas-Wert

Phase 4: waitForTransactionReceipt()
  status = 'success'? → OK, amountOut verwenden
  status ≠ 'success'? → on-chain Revert → neuer Quote + Retry bis 3×
```

### Token-Adressen in KyberSwap
- Native AVAX: `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`
- sAVAX: `0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE`
- WAVAX (beim Wrap nicht nötig, direkt über WAVAX.deposit())

---

## 5. Berechnungsformeln

### Health Factor

```
HF = (Collateral_USD × LiquidationThreshold) / Debt_USD
   = (sAVAX_USD × 0.95) / WAVAX_USD
```

### Leverage

```
Leverage = Collateral / (Collateral - Debt)
         = Collateral / Equity
```

Maximales theoretisches Leverage (E-Mode, LTV 93%):
```
Leverage_max = 1 / (1 - LTV) = 1 / (1 - 0.93) ≈ 14.3x
```

Leverage bei gegebenem HF:
```
Leverage(HF) = 1 / (1 - LT/HF)
```

### Optimaler Borrow-Betrag (Loop)

Gesucht: Borrow-Betrag X so dass nach dem Supply der neue HF = targetHF

```
HF_target = (Collateral_new × LT) / Debt_new
           = ((C + X × r) × LT) / (D + X)

Auflösung nach X:
  X = (HF_target × D - C × LT) / (r × LT - HF_target)

  C = aktuelles Collateral USD
  D = aktuelles Debt USD
  r = sAvaxRatio = sAvaxPrice / wavaxPrice (wieviel Collateral pro geborgtem AVAX)
  LT = LiquidationThreshold (0.95)
```

### Maximaler Unwind-Repay pro Iteration

Gesucht: Repay-Betrag R so dass nach Withdraw+Repay der HF ≥ safetyHF (1.05)

Beim Unwind: Withdraw W USD Collateral, Repay R USD Debt
```
HF_new = (C - W) × LT / (D - R)  ≥ safetyHF
Näherung: W ≈ R × sAvaxRatio

R = (D × safetyHF - C × LT) / (safetyHF - sAvaxRatio × LT)
```

### Maximaler Withdraw ohne Liquidation

Maximaler Withdraw W so dass HF nach Withdraw noch ≥ 1.03:
```
HF_after_withdraw = (C - W) × LT / D ≥ 1.03

W ≤ C - (1.03 × D / LT)
```

---

## 6. Zustandsmaschine & Entscheidungslogik

### RiskEngine.assess() – Entscheidungsbaum

```
HF > 0 UND HF < 1.01 (emergencyHF)?
  → EMERGENCY_DELEVERAGE

HF > 0 UND HF < 1.01 (minHFForAction)?
  → DELEVERAGE

Debt = 0?
  → LOOP_MORE  ("initiales Looping möglich")

Leverage < targetLeverage (14x)
  UND HF > targetHF (1.02)?
  → LOOP_MORE

Sonst:
  → HOLD
```

### Verarbeitungsreihenfolge beim Unwind

```
┌────────────────────────────────────────────────────────────┐
│                  Iteration Start                           │
├────────────────────────────────────────────────────────────┤
│ Debt < $0.01?  ──JA──→  Withdraw alles → FERTIG           │
├────────────────────────────────────────────────────────────┤
│ Repay-Betrag berechnen (Formel)                            │
│ Withdraw-Betrag berechnen (repay × sAvaxRatio × slippage)  │
├────────────────────────────────────────────────────────────┤
│ maxWithdrawUsd = Collateral - (1.03 × Debt / LT)          │
│   ≤ 0?  ──JA──→  Direkt-Repay aus Wallet:                 │
│                    AVAX wrappen → repay                    │
│                    sAVAX → AVAX → wrappen → repay          │
│                    → continue (nächste Iteration)          │
├────────────────────────────────────────────────────────────┤
│ withdrawSAvax = min(withdrawSAvax, maxWithdrawSAvax)       │
│ withdrawSAvax = min(withdrawSAvax, asAVAX.balanceOf)       │
│   = 0?  → ABBRUCH                                         │
├────────────────────────────────────────────────────────────┤
│ Bestätigung (j/n) wenn interaktiv                          │
├────────────────────────────────────────────────────────────┤
│ sAvaxBefore = sAVAX.balanceOf(wallet)                      │
│ pool.withdraw(sAVAX, withdrawSAvax)                        │
│ swapAmount = sAVAX.balanceOf(wallet) - sAvaxBefore         │
│   = 0?  → ABBRUCH                                         │
│ KyberSwap: swapAmount sAVAX → avaxReceived                 │
│ WAVAX.deposit(min(avaxReceived, repayWavax))               │
│ pool.repay(WAVAX, wrapAmount)                              │
└────────────────────────────────────────────────────────────┘
```

### Contract-Adressen (Avalanche Mainnet)

| Contract | Adresse |
|----------|---------|
| Aave v3 Pool | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| Aave Price Oracle | `0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C` |
| sAVAX (BENQI) | `0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE` |
| WAVAX | `0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7` |
| asAVAX (Aave aToken) | `0x513c7E3a9c69cA3e22550eF58AC1C0088e918FFf` |
| KyberSwap Router | dynamisch (aus API-Response) |
