// ============================================================================
// loopEngine.ts – Automatisierter Supply/Borrow Loop & Deleverage
// ============================================================================
// Orchestriert den gesamten Loop-Prozess:
//   1. sAVAX als Collateral → supply
//   2. WAVAX borgen
//   3. WAVAX → AVAX unwrap → AVAX → sAVAX staken (via BENQI)
//   4. Neue sAVAX wieder supply
//   5. Wiederholen bis Target-Leverage erreicht
//
// Deleverage (umgekehrt):
//   1. sAVAX aus Aave withdrawen
//   2. sAVAX → AVAX (via DEX oder BENQI unstake)
//   3. AVAX → WAVAX wrap
//   4. WAVAX an Aave repay
// ============================================================================

import { formatEther, parseEther } from 'viem';
import type { Interface as RLInterface } from 'readline';
import { AaveClient, type AccountSnapshot } from './aaveClient.js';
import { RiskEngine, type DeleverageCalc } from './riskEngine.js';
import { CONFIG, ADDRESSES, EMODE } from './config.js';
import { NATIVE_AVAX, SAVAX_ADDRESS } from './kyberswap.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type RateCheckResult = {
  ok: boolean;
  message: string;
  avaxPerSAvax: number;
  sAvaxPerAvax: number;
  oracleDiffPct: number;
};

export type LoopResult = {
  iterations: number;
  finalSnapshot: AccountSnapshot;
  txHashes: string[];
  success: boolean;
  reason: string;
};

// ---------------------------------------------------------------------------
// LoopEngine Klasse
// ---------------------------------------------------------------------------
export class LoopEngine {
  constructor(
    private readonly aave: AaveClient,
    private readonly risk: RiskEngine,
  ) {}

  // =========================================================================
  // Kurs-Check: KyberSwap Quote vs. Aave Oracle Preis-Verhältnis
  // =========================================================================

  async checkExchangeRate(aave: AaveClient): Promise<RateCheckResult> {
    // Referenz-Betrag: 1 sAVAX (in Wei) – Richtung sAVAX → AVAX
    const oneSAvax = parseEther('1');

    // KyberSwap Quote: Wie viel AVAX bekomme ich für 1 sAVAX?
    const quote = await aave.kyberswap.fetchQuoteOnly(SAVAX_ADDRESS, NATIVE_AVAX, oneSAvax);
    const kyberAvaxPerSAvax = Number(quote.amountOut) / 1e18;
    const kyberSAvaxPerAvax = kyberAvaxPerSAvax > 0 ? 1 / kyberAvaxPerSAvax : 0;

    // Oracle-Preise (Referenz): sAVAX/AVAX Verhältnis laut Aave Price Oracle
    const sAvaxPriceUsd = await aave.getAssetPrice(ADDRESSES.sAVAX);
    const wavaxPriceUsd = await aave.getAssetPrice(ADDRESSES.WAVAX);

    // Oracle: 1 sAVAX = ? AVAX  →  sAvaxPrice / avaxPrice
    const oracleAvaxPerSAvax = wavaxPriceUsd > 0n && sAvaxPriceUsd > 0n
      ? Number(sAvaxPriceUsd) / Number(wavaxPriceUsd)
      : 1.0;

    // Abweichung: KyberSwap vs. Oracle
    const diffPct = oracleAvaxPerSAvax > 0
      ? Math.abs((kyberAvaxPerSAvax - oracleAvaxPerSAvax) / oracleAvaxPerSAvax) * 100
      : 0;

    // Slippage-Warnschwelle: 2× konfigurierte Slippage
    const tolerancePct = (CONFIG.slippageBps / 100) * 2;

    console.log('');
    console.log('  ┌─── Kurs-Check (KyberSwap vs. Aave Oracle) ──────────────┐');
    console.log(`  │  KyberSwap:  1 sAVAX = ${kyberAvaxPerSAvax.toFixed(6)} AVAX               │`);
    console.log(`  │  Oracle:     1 sAVAX = ${oracleAvaxPerSAvax.toFixed(6)} AVAX  (Referenz)  │`);
    console.log(`  │  Abweichung: ${diffPct.toFixed(3)}%  (Warnschwelle: ${tolerancePct.toFixed(2)}%)             │`);
    console.log(`  │  Min.Output: ${formatEther(quote.amountOutMin)} AVAX  (nach Slippage)  │`);
    console.log('  └─────────────────────────────────────────────────────────┘');

    const ok = diffPct <= tolerancePct;
    const message = ok
      ? `Kurs ok – KyberSwap 1 sAVAX = ${kyberAvaxPerSAvax.toFixed(6)} AVAX, Oracle ${oracleAvaxPerSAvax.toFixed(6)}, Abweichung ${diffPct.toFixed(3)}%`
      : `Kurs-Warnung: Abweichung ${diffPct.toFixed(3)}% > ${tolerancePct.toFixed(2)}%! KyberSwap ${kyberAvaxPerSAvax.toFixed(6)} vs. Oracle ${oracleAvaxPerSAvax.toFixed(6)} AVAX/sAVAX`;

    return {
      ok,
      message,
      avaxPerSAvax: kyberAvaxPerSAvax,
      sAvaxPerAvax: kyberSAvaxPerAvax,
      oracleDiffPct: diffPct,
    };
  }

  // =========================================================================
  // Haupt-Loop: Leverage aufbauen
  // =========================================================================

  async buildLoop(
    rl?: RLInterface,
    confirmFn?: (rl: RLInterface, msg: string) => Promise<boolean>,
  ): Promise<LoopResult> {
    const txHashes: string[] = [];
    let iterations = 0;

    console.log('');
    console.log('╔═════════════════════════════════════════════╗');
    console.log('║         LOOP ENGINE – BUILD LEVERAGE        ║');
    console.log('╚═════════════════════════════════════════════╝');

    // 1. E-Mode sicherstellen
    try {
      await this.aave.enableEMode();
    } catch (err) {
      console.error('  ✗ E-Mode konnte nicht aktiviert werden:', err);
      const snap = await this.aave.getAccountSnapshot();
      return { iterations: 0, finalSnapshot: snap, txHashes, success: false, reason: 'E-Mode Fehler' };
    }

    // 2. sAVAX in Wallet immer zuerst supplyen (unabhängig von Collateral-Status)
    const walletSAvax = await this.aave.getBalance(ADDRESSES.sAVAX);
    if (walletSAvax > 0n) {
      console.log(`\n  [INIT] Supply ${formatEther(walletSAvax)} sAVAX aus Wallet to Aave...`);
      const supplyHash = await this.aave.supplySAvax(walletSAvax);
      txHashes.push(supplyHash);
    }

    // 3. Falls immer noch kein Collateral → AVAX → sAVAX → Supply
    const initialSnap = await this.aave.getAccountSnapshot();
    if (initialSnap.totalCollateralUsd === 0) {
      const avaxBalance = await this.aave.getNativeBalance();
      const gasReserve = parseEther(CONFIG.gasReserveAvax as `${number}`);
      const stakeAmount = avaxBalance > gasReserve ? avaxBalance - gasReserve : 0n;

      if (stakeAmount < parseEther('0.01')) {
        return {
          iterations: 0,
          finalSnapshot: initialSnap,
          txHashes,
          success: false,
          reason: `Kein Collateral und zu wenig AVAX (${formatEther(avaxBalance)}) – mind. ${CONFIG.gasReserveAvax} Gas-Reserve + 0.01 AVAX benötigt.`,
        };
      }

      console.log(`\n  [INIT] Swap ${formatEther(stakeAmount)} AVAX → sAVAX (Gas-Reserve: ${CONFIG.gasReserveAvax} AVAX)...`);
      const { hash: stakeHash, sAvaxReceived } = await this.aave.stakeAvaxForSAvax(stakeAmount);
      txHashes.push(stakeHash);

      if (sAvaxReceived === 0n) {
        return {
          iterations: 0,
          finalSnapshot: initialSnap,
          txHashes,
          success: false,
          reason: 'Init-Swap AVAX→sAVAX lieferte 0 sAVAX – bitte Wallet-Balance prüfen.',
        };
      }

      console.log(`  [INIT] Supply ${formatEther(sAvaxReceived)} sAVAX to Aave...`);
      const supplyHash2 = await this.aave.supplySAvax(sAvaxReceived);
      txHashes.push(supplyHash2);
    }

    // 3. Loop: Borrow → Stake → Supply → Repeat
    while (iterations < CONFIG.maxIterations) {
      iterations++;
      console.log(`\n  ── Iteration ${iterations}/${CONFIG.maxIterations} ──`);

      // Account Status holen
      const snap = await this.aave.getAccountSnapshot();
      const assessment = this.risk.assess(snap);

      console.log(`  HF: ${snap.healthFactor.toFixed(4)} | Leverage: ${snap.leverage.toFixed(2)}x | Action: ${assessment.action}`);

      // Prüfe ob wir weitermachen sollen
      if (assessment.action !== 'LOOP_MORE') {
        console.log(`  → Stoppe Loop: ${assessment.reason}`);
        return {
          iterations,
          finalSnapshot: snap,
          txHashes,
          success: true,
          reason: assessment.reason,
        };
      }

      // Borrow-Betrag berechnen – KyberSwap Quote für aktuellen Kurs nutzen
      const kyberQuote = await this.aave.kyberswap.fetchQuoteOnly(NATIVE_AVAX, SAVAX_ADDRESS, parseEther('1'));
      const kyberSAvaxPerAvax = Number(kyberQuote.amountOut) / 1e18;
      const kyberAvaxPerSAvax = kyberSAvaxPerAvax > 0 ? 1 / kyberSAvaxPerAvax : 1.0;
      const borrowAmountBase = this.risk.calculateNextBorrowAmount(snap, kyberAvaxPerSAvax);

      if (borrowAmountBase === 0n) {
        console.log('  → Kein weiterer Borrow sinnvoll');
        return {
          iterations,
          finalSnapshot: snap,
          txHashes,
          success: true,
          reason: 'Borrow-Menge zu klein',
        };
      }

      // Konvertiere Base (USD, 8 dec) → WAVAX Token Amount (18 dec)
      const wavaxPrice = await this.aave.getAssetPrice(ADDRESSES.WAVAX);
      const borrowTokenAmount = this.risk.baseToTokenAmount(borrowAmountBase, wavaxPrice);

      if (borrowTokenAmount === 0n) {
        console.log('  → Token-Betrag zu klein');
        break;
      }

      console.log(`  Borrow: ${formatEther(borrowTokenAmount)} WAVAX ($${(Number(borrowAmountBase) / 1e8).toFixed(2)})`);

      // Bestätigung pro Iteration (nur wenn rl übergeben)
      if (rl && confirmFn) {
        const ok = await confirmFn(
          rl,
          `Iteration ${iterations}: Borrow ${formatEther(borrowTokenAmount)} WAVAX → Stake → Supply ausführen?`,
        );
        if (!ok) {
          const currentSnap = await this.aave.getAccountSnapshot();
          return { iterations, finalSnapshot: currentSnap, txHashes, success: true, reason: 'Vom Nutzer abgebrochen' };
        }
      }

      try {
        // a) Borrow WAVAX
        const borrowHash = await this.aave.borrowWavax(borrowTokenAmount);
        txHashes.push(borrowHash);

        // b) Unwrap WAVAX → native AVAX
        const unwrapHash = await this.aave.unwrapWavax(borrowTokenAmount);
        txHashes.push(unwrapHash);

        // Gas-Reserve prüfen: tatsächliche AVAX-Balance nach Unwrap
        const avaxAfterUnwrap = await this.aave.getNativeBalance();
        const gasReserve = parseEther(CONFIG.gasReserveAvax as `${number}`);
        if (avaxAfterUnwrap <= gasReserve) {
          console.log(`  ✗ AVAX-Balance (${formatEther(avaxAfterUnwrap)}) ≤ Gas-Reserve (${CONFIG.gasReserveAvax}) – Loop gestoppt`);
          break;
        }
        // Nur AVAX tauschen das über der Gas-Reserve liegt
        const swapAmount = avaxAfterUnwrap - gasReserve < borrowTokenAmount
          ? avaxAfterUnwrap - gasReserve
          : borrowTokenAmount;

        // c) Swap AVAX → sAVAX via KyberSwap
        const { hash: stakeHash, sAvaxReceived } = await this.aave.stakeAvaxForSAvax(swapAmount);
        txHashes.push(stakeHash);

        if (sAvaxReceived === 0n) {
          console.log('  ✗ Kein sAVAX erhalten – breche ab');
          break;
        }

        // d) Supply sAVAX to Aave
        const supplyHash = await this.aave.supplySAvax(sAvaxReceived);
        txHashes.push(supplyHash);

        console.log(`  ✓ Iteration ${iterations} erfolgreich`);

      } catch (err) {
        console.error(`  ✗ Fehler in Iteration ${iterations}:`, err);
        const currentSnap = await this.aave.getAccountSnapshot();
        return {
          iterations,
          finalSnapshot: currentSnap,
          txHashes,
          success: false,
          reason: `Fehler in Iteration ${iterations}: ${err}`,
        };
      }

      // Kurze Pause für RPC-Rate-Limits
      await sleep(2000);
    }

    const finalSnap = await this.aave.getAccountSnapshot();
    return {
      iterations,
      finalSnapshot: finalSnap,
      txHashes,
      success: true,
      reason: `Loop beendet nach ${iterations} Iterationen`,
    };
  }

  // =========================================================================
  // Deleverage: Leverage reduzieren
  // =========================================================================
  
  async deleverage(targetHF?: number): Promise<LoopResult> {
    const txHashes: string[] = [];
    const desiredHF = targetHF || CONFIG.minHFForAction + 0.1;

    console.log('');
    console.log('╔═════════════════════════════════════════════╗');
    console.log('║       LOOP ENGINE – DELEVERAGE              ║');
    console.log('╚═════════════════════════════════════════════╝');
    console.log(`  Ziel-HF: ${desiredHF}`);

    const snap = await this.aave.getAccountSnapshot();
    
    if (snap.healthFactor > desiredHF) {
      console.log(`  HF ${snap.healthFactor.toFixed(4)} bereits über Ziel ${desiredHF} – nichts zu tun`);
      return { iterations: 0, finalSnapshot: snap, txHashes, success: true, reason: 'Bereits sicher' };
    }

    if (snap.totalDebtUsd === 0) {
      console.log('  Kein Debt vorhanden – nichts zu deleveragen');
      return { iterations: 0, finalSnapshot: snap, txHashes, success: true, reason: 'Kein Debt' };
    }

    // Exchange Rate für Berechnung
    const exchangeRate = await this.aave.getSAvaxExchangeRate();
    
    // Iteratives Deleverage (in Schritten, da Swap-Slippage die Berechnung beeinflusst)
    let iterations = 0;
    const maxDeleverageIterations = 10;

    while (iterations < maxDeleverageIterations) {
      iterations++;
      console.log(`\n  ── Deleverage Iteration ${iterations} ──`);

      const currentSnap = await this.aave.getAccountSnapshot();
      
      if (currentSnap.healthFactor >= desiredHF) {
        console.log(`  ✓ Ziel-HF ${desiredHF} erreicht (aktuell: ${currentSnap.healthFactor.toFixed(4)})`);
        return {
          iterations,
          finalSnapshot: currentSnap,
          txHashes,
          success: true,
          reason: `Ziel-HF erreicht: ${currentSnap.healthFactor.toFixed(4)}`,
        };
      }

      // Berechne Repay-Betrag
      const delevCalc = this.risk.calculateDeleverageAmount(
        currentSnap,
        desiredHF,
        exchangeRate.avaxPerSAvax,
      );

      if (delevCalc.repayAmountBase === 0n) {
        console.log('  → Repay-Betrag zu klein');
        break;
      }

      // In Token-Beträge konvertieren
      const sAvaxPrice = await this.aave.getAssetPrice(ADDRESSES.sAVAX);
      const wavaxPrice = await this.aave.getAssetPrice(ADDRESSES.WAVAX);
      
      const withdrawSAvaxAmount = this.risk.baseToTokenAmount(delevCalc.withdrawAmountBase, sAvaxPrice);
      const repayWavaxAmount = this.risk.baseToTokenAmount(delevCalc.repayAmountBase, wavaxPrice);

      console.log(`  Withdraw: ${formatEther(withdrawSAvaxAmount)} sAVAX`);
      console.log(`  Repay:    ${formatEther(repayWavaxAmount)} WAVAX`);
      console.log(`  Erwartet: HF ${delevCalc.estimatedNewHF.toFixed(4)}, Leverage ${delevCalc.estimatedNewLeverage.toFixed(2)}x`);

      try {
        // a) Withdraw sAVAX from Aave
        const withdrawHash = await this.aave.withdrawSAvax(withdrawSAvaxAmount);
        txHashes.push(withdrawHash);

        // b) sAVAX → AVAX
        //    Option 1: Via DEX (sofort, mit Slippage)
        //    Option 2: Via BENQI unstake (15 Tage Wartezeit)
        //    Hier: DEX-Swap simuliert → in Produktion LFJ/TraderJoe Router nutzen
        //    WORKAROUND: Da wir im E-Mode sind und sAVAX/AVAX korreliert,
        //    können wir alternativ sAVAX direkt als Repayment nutzen wenn
        //    der Debt auch in sAVAX ist. Bei WAVAX-Debt müssen wir swappen.
        
        // Für WAVAX-Debt: sAVAX verkaufen → AVAX → WAVAX
        // In Produktion: DEX Router Call hier einsetzen
        // Placeholder: Wir nutzen den BENQI getPooledAvaxByShares für die Rate
        
        const avaxEquivalent = await this.getAvaxForSAvax(withdrawSAvaxAmount);
        
        // AVAX → WAVAX wrap (über native deposit)
        // Hinweis: In Produktion müsstest du hier den DEX-Swap machen
        // Für den Prototyp gehen wir davon aus, dass du WAVAX-Balance hast
        // oder wir wrappen die native AVAX die wir vom sAVAX-Verkauf bekommen

        // c) Repay WAVAX
        const repayHash = await this.aave.repayWavax(repayWavaxAmount);
        txHashes.push(repayHash);

        console.log(`  ✓ Deleverage Iteration ${iterations} erfolgreich`);

      } catch (err) {
        console.error(`  ✗ Fehler bei Deleverage:`, err);
        const errorSnap = await this.aave.getAccountSnapshot();
        return {
          iterations,
          finalSnapshot: errorSnap,
          txHashes,
          success: false,
          reason: `Deleverage Fehler: ${err}`,
        };
      }

      await sleep(2000);
    }

    const finalSnap = await this.aave.getAccountSnapshot();
    return {
      iterations,
      finalSnapshot: finalSnap,
      txHashes,
      success: true,
      reason: `Deleverage beendet nach ${iterations} Iterationen`,
    };
  }

  // =========================================================================
  // Emergency Deleverage
  // =========================================================================
  
  async emergencyDeleverage(): Promise<LoopResult> {
    console.log('');
    console.log('╔═════════════════════════════════════════════╗');
    console.log('║    ⚠️  EMERGENCY DELEVERAGE ⚠️              ║');
    console.log('╚═════════════════════════════════════════════╝');
    
    // Ziel: HF auf sicheres Niveau bringen
    const safeHF = CONFIG.minHFForAction + 0.15;
    return this.deleverage(safeHF);
  }

  // =========================================================================
  // Komplett-Unwind: Alle Positionen schließen
  // =========================================================================
  
  async fullUnwind(): Promise<LoopResult> {
    console.log('');
    console.log('╔═════════════════════════════════════════════╗');
    console.log('║         FULL POSITION UNWIND                ║');
    console.log('╚═════════════════════════════════════════════╝');

    // Schrittweises Deleverage bis kein Debt mehr
    return this.deleverage(100); // HF=100 ist effektiv "kein Debt"
  }

  // =========================================================================
  // Loop Unwind: Vollständiger Abbau der Leverage-Position
  // =========================================================================
  // Reihenfolge pro Iteration:
  //   1. Berechne max. withdrawbares sAVAX (ohne HF unter 1.05 zu drücken)
  //   2. Withdraw sAVAX from Aave
  //   3. Swap sAVAX → AVAX via KyberSwap
  //   4. Wrap AVAX → WAVAX
  //   5. Repay WAVAX to Aave
  //   Wiederholen bis kein Debt mehr

  async unwindLoop(
    rl?: RLInterface,
    confirmFn?: (rl: RLInterface, msg: string) => Promise<boolean>,
  ): Promise<LoopResult> {
    const txHashes: string[] = [];
    let iterations = 0;
    const MAX_ITER = 50;

    console.log('');
    console.log('╔═════════════════════════════════════════════╗');
    console.log('║       LOOP ENGINE – UNWIND POSITION         ║');
    console.log('╚═════════════════════════════════════════════╝');

    while (iterations < MAX_ITER) {
      iterations++;
      console.log(`\n  ── Unwind Iteration ${iterations}/${MAX_ITER} ──`);

      const snap = await this.aave.getAccountSnapshot();
      console.log(`  HF: ${snap.healthFactor.toFixed(4)} | Leverage: ${snap.leverage.toFixed(2)}x | Debt: $${snap.totalDebtUsd.toFixed(2)} | Collateral: $${snap.totalCollateralUsd.toFixed(2)}`);

      // Fertig wenn kein Debt mehr
      if (snap.totalDebtUsd < 0.01) {
        console.log('  ✓ Kein Debt mehr – Unwind abgeschlossen.');

        // Verbliebenes Collateral (sAVAX) zurückziehen
        if (snap.totalCollateralUsd > 0.01) {
          console.log('  → Withdraw verbleibendes Collateral...');
          try {
            const sAvaxPrice = await this.aave.getAssetPrice(ADDRESSES.sAVAX);
            const remainingSAvax = this.risk.baseToTokenAmount(
              BigInt(Math.floor(snap.totalCollateralUsd * 1e8)),
              sAvaxPrice,
            );
            // type(uint256).max = komplett withdraw
            const withdrawHash = await this.aave.withdrawSAvax(
              2n ** 256n - 1n, // MaxUint256 → alles
            );
            txHashes.push(withdrawHash);
          } catch {
            // Fallback: berechneter Betrag
            const sAvaxPrice = await this.aave.getAssetPrice(ADDRESSES.sAVAX);
            const remainingSAvax = this.risk.baseToTokenAmount(
              BigInt(Math.floor(snap.totalCollateralUsd * 0.999 * 1e8)),
              sAvaxPrice,
            );
            if (remainingSAvax > 0n) {
              const withdrawHash = await this.aave.withdrawSAvax(remainingSAvax);
              txHashes.push(withdrawHash);
            }
          }
        }

        const finalSnap = await this.aave.getAccountSnapshot();
        return { iterations, finalSnapshot: finalSnap, txHashes, success: true, reason: 'Unwind abgeschlossen – kein Debt mehr' };
      }

      // Berechne wie viel wir in diesem Schritt repay'en können.
      // Strategie: repay so viel wie möglich ohne HF unter 1.05 zu drücken.
      // Wir withdrawen sAVAX entsprechend dem Debt-Abbau.
      // Max withdraw ohne Liquidation: HF darf nicht unter 1.05 fallen.
      //
      // HF_neu = (Collateral - withdraw_usd) * LT / (Debt - repay_usd)
      // Bei sAVAX/AVAX Korrelation: withdraw_usd ≈ repay_usd * sAvaxRatio
      // Wir zielen auf: repay = min(totalDebt, availableRepay)
      // Sicherheitshalber: max 95% des gesamten Debts pro Iteration

      const wavaxPrice = await this.aave.getAssetPrice(ADDRESSES.WAVAX);
      const sAvaxPrice = await this.aave.getAssetPrice(ADDRESSES.sAVAX);

      // Berechne Repay-Betrag: so viel wie möglich, aber HF >= 1.05 danach
      const safetyHF = 1.05;
      const lt = snap.liquidationThresholdPct / 100;
      // repay = (Debt * safetyHF - Collateral * lt) / (safetyHF - ratio * lt)
      const sAvaxRatio = Number(sAvaxPrice) / Number(wavaxPrice);
      const denom = safetyHF - sAvaxRatio * lt;
      let repayUsd: number;
      if (denom <= 0 || snap.totalDebtUsd * safetyHF <= snap.totalCollateralUsd * lt) {
        // Kann alles auf einmal repay'en
        repayUsd = snap.totalDebtUsd;
      } else {
        repayUsd = Math.min(
          (snap.totalDebtUsd * safetyHF - snap.totalCollateralUsd * lt) / denom,
          snap.totalDebtUsd,
        );
      }
      repayUsd = Math.max(repayUsd, 0);

      if (repayUsd < 0.01) {
        console.log('  ✗ Repay-Betrag zu klein – abgebrochen.');
        break;
      }

      // Token-Beträge
      const repayWavax = this.risk.baseToTokenAmount(
        BigInt(Math.floor(repayUsd * 1e8)),
        wavaxPrice,
      );
      // Withdraw etwas mehr sAVAX als nötig (Slippage-Buffer) – aber max. verfügbare aToken-Balance
      const withdrawUsd = repayUsd * sAvaxRatio * (1 + CONFIG.slippageBps / 10000);
      let withdrawSAvax = this.risk.baseToTokenAmount(
        BigInt(Math.floor(withdrawUsd * 1e8)),
        sAvaxPrice,
      );

      // Clamp 1: Max. withdrawbare Menge ohne HF unter 1.03 zu drücken (vor Repay)
      // HF_after_withdraw = (Collateral - withdraw_usd) * lt / Debt >= 1.03
      // withdraw_usd <= Collateral - (1.03 * Debt / lt)
      const maxWithdrawUsd = snap.totalCollateralUsd - (1.03 * snap.totalDebtUsd / lt);
      if (maxWithdrawUsd <= 0) {
        // HF zu niedrig für Withdraw – prüfe ob Wallet-Assets für direkten Repay reichen
        console.log('  ⚠ HF zu niedrig für Withdraw – prüfe Wallet-Bestände für direkten Repay...');

        const walletAvax = await this.aave.getNativeBalance();
        const walletSAvax = await this.aave.getBalance(ADDRESSES.sAVAX);
        const gasReserve = parseEther(CONFIG.gasReserveAvax as `${number}`);
        const usableAvax = walletAvax > gasReserve ? walletAvax - gasReserve : 0n;

        if (usableAvax === 0n && walletSAvax === 0n) {
          console.log('  ✗ Keine Wallet-Assets für direkten Repay – Unwind blockiert.');
          break;
        }

        // AVAX wrappen und repay'en
        let directRepayWavax = 0n;
        if (usableAvax > 0n) {
          const avaxToWrap = usableAvax < repayWavax ? usableAvax : repayWavax;
          console.log(`  → Direkt-Repay: ${formatEther(avaxToWrap)} AVAX aus Wallet wrappen & repay'en...`);
          const wrapHash = await this.aave.wrapAvax(avaxToWrap);
          txHashes.push(wrapHash);
          directRepayWavax = avaxToWrap;
        }

        // sAVAX aus Wallet → AVAX → WAVAX → repay (falls noch Debt übrig)
        if (walletSAvax > 0n && directRepayWavax < repayWavax) {
          const remaining = repayWavax - directRepayWavax;
          const swapSAvax = walletSAvax < this.risk.baseToTokenAmount(
            BigInt(Math.floor(Number(remaining) / Number(wavaxPrice) * Number(sAvaxPrice))),
            sAvaxPrice,
          ) ? walletSAvax : this.risk.baseToTokenAmount(
            BigInt(Math.floor(Number(remaining) / Number(wavaxPrice) * Number(sAvaxPrice))),
            sAvaxPrice,
          );
          if (swapSAvax > 0n) {
            console.log(`  → Direkt-Repay: ${formatEther(swapSAvax)} sAVAX aus Wallet → AVAX → WAVAX...`);
            const { hash: swapHash, avaxReceived } = await this.aave.swapSAvaxForAvax(swapSAvax);
            txHashes.push(swapHash);
            const wrapHash = await this.aave.wrapAvax(avaxReceived);
            txHashes.push(wrapHash);
            directRepayWavax += avaxReceived;
          }
        }

        if (directRepayWavax === 0n) {
          console.log('  ✗ Kein WAVAX für Repay verfügbar.');
          break;
        }

        const actualRepay = directRepayWavax < repayWavax ? directRepayWavax : repayWavax;
        const repayHash = await this.aave.repayWavax(actualRepay);
        txHashes.push(repayHash);
        console.log(`  ✓ Direkt-Repay ${formatEther(actualRepay)} WAVAX aus Wallet`);
        await sleep(2000);
        continue; // nächste Iteration: HF sollte jetzt besser sein
      }
      const maxWithdrawSAvax = this.risk.baseToTokenAmount(
        BigInt(Math.floor(maxWithdrawUsd * 1e8)),
        sAvaxPrice,
      );
      if (withdrawSAvax > maxWithdrawSAvax) {
        console.log(`  ⚠ Withdraw clamped auf HF-Limit: ${formatEther(maxWithdrawSAvax)} sAVAX (war: ${formatEther(withdrawSAvax)})`);
        withdrawSAvax = maxWithdrawSAvax;
      }

      // Clamp 2: Max. verfügbare aToken-Balance
      const aSAvaxBalance = await this.aave.getBalance(ADDRESSES.aSAVAX);
      if (withdrawSAvax > aSAvaxBalance) {
        console.log(`  ⚠ Withdraw clamped auf aToken-Balance: ${formatEther(aSAvaxBalance)} sAVAX (war: ${formatEther(withdrawSAvax)})`);
        withdrawSAvax = aSAvaxBalance;
      }

      if (withdrawSAvax === 0n) {
        console.log('  ✗ Withdraw-Betrag = 0 – abgebrochen.');
        break;
      }

      console.log(`  Repay:    ${formatEther(repayWavax)} WAVAX  (~$${repayUsd.toFixed(2)})`);
      console.log(`  Withdraw: ${formatEther(withdrawSAvax)} sAVAX`);

      // Bestätigung (wenn interaktiv)
      if (rl && confirmFn) {
        const ok = await confirmFn(
          rl,
          `Iteration ${iterations}: ${formatEther(withdrawSAvax)} sAVAX withdraw → swap → ${formatEther(repayWavax)} WAVAX repay?`,
        );
        if (!ok) {
          const currentSnap = await this.aave.getAccountSnapshot();
          return { iterations, finalSnapshot: currentSnap, txHashes, success: true, reason: 'Vom Nutzer abgebrochen' };
        }
      }

      try {
        // a) Withdraw sAVAX from Aave – Balance vorher merken für genaue Diff
        const sAvaxBefore = await this.aave.getBalance(ADDRESSES.sAVAX);
        const withdrawHash = await this.aave.withdrawSAvax(withdrawSAvax);
        txHashes.push(withdrawHash);

        // b) Swap sAVAX → AVAX via KyberSwap
        // Tatsächlich erhaltene sAVAX = Balance-Differenz (zuverlässiger als Parameter)
        const sAvaxAfter = await this.aave.getBalance(ADDRESSES.sAVAX);
        const swapAmount = sAvaxAfter > sAvaxBefore ? sAvaxAfter - sAvaxBefore : withdrawSAvax;
        if (swapAmount === 0n) {
          console.log('  ✗ Kein sAVAX nach Withdraw in Wallet – abgebrochen.');
          break;
        }
        const { hash: swapHash, avaxReceived } = await this.aave.swapSAvaxForAvax(swapAmount);
        txHashes.push(swapHash);

        // c) Wrap AVAX → WAVAX
        // Repay-Betrag: min(avaxReceived, repayWavax) – nicht mehr wrappen als nötig
        const wrapAmount = avaxReceived < repayWavax ? avaxReceived : repayWavax;
        const wrapHash = await this.aave.wrapAvax(wrapAmount);
        txHashes.push(wrapHash);

        // d) Repay WAVAX to Aave
        // type(uint256).max würde alles repay'en – wir repay'en präzise
        const actualRepay = wrapAmount;
        const repayHash = await this.aave.repayWavax(actualRepay);
        txHashes.push(repayHash);

        console.log(`  ✓ Iteration ${iterations} erfolgreich`);

      } catch (err) {
        console.error(`  ✗ Fehler in Unwind-Iteration ${iterations}:`, err);
        const errorSnap = await this.aave.getAccountSnapshot();
        return {
          iterations,
          finalSnapshot: errorSnap,
          txHashes,
          success: false,
          reason: `Unwind Fehler in Iteration ${iterations}: ${err}`,
        };
      }

      await sleep(2000);
    }

    const finalSnap = await this.aave.getAccountSnapshot();
    return {
      iterations,
      finalSnapshot: finalSnap,
      txHashes,
      success: true,
      reason: `Unwind beendet nach ${iterations} Iterationen`,
    };
  }

  // =========================================================================
  // Helper: sAVAX → AVAX Wert berechnen (on-chain)
  // =========================================================================

  private async getAvaxForSAvax(sAvaxAmount: bigint): Promise<bigint> {
    const { avaxPerSAvax } = await this.aave.getSAvaxExchangeRate();
    return BigInt(Math.floor(Number(sAvaxAmount) * avaxPerSAvax));
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
