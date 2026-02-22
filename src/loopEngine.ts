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

    // Callback: nach 3 Swap-Fehlversuchen Nutzer befragen ob weitermachen
    const swapRetryCallback = (rl && confirmFn)
      ? async () => confirmFn(rl, 'Swap nach 3 Versuchen fehlgeschlagen. Nochmals versuchen?')
      : undefined;

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

    // 3. Falls Wallet-AVAX vorhanden und mehr wert als bestehendes Collateral → miteinbeziehen
    //    (deckt auch den Fall ab wo minimales Rest-Collateral auf Aave liegt aber AVAX in Wallet)
    const initialSnap = await this.aave.getAccountSnapshot();
    const avaxBalanceCheck = await this.aave.getNativeBalance();
    const gasReserveCheck = parseEther(CONFIG.gasReserveAvax as `${number}`);
    const usableAvax = avaxBalanceCheck > gasReserveCheck ? avaxBalanceCheck - gasReserveCheck : 0n;
    const usableAvaxUsd = Number(formatEther(usableAvax)) * (Number(await this.aave.getAssetPrice(ADDRESSES.WAVAX)) / 1e8);

    if (usableAvax >= parseEther('0.01') && usableAvaxUsd > initialSnap.totalCollateralUsd * 0.1) {
      const avaxBalance = avaxBalanceCheck;
      const gasReserve = gasReserveCheck;
      const stakeAmount = usableAvax;

      console.log(`\n  [INIT] Swap ${formatEther(stakeAmount)} AVAX → sAVAX (Gas-Reserve: ${gasReserve ? CONFIG.gasReserveAvax : '0'} AVAX)...`);
      const { hash: stakeHash, sAvaxReceived } = await this.aave.stakeAvaxForSAvax(stakeAmount, swapRetryCallback);
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
      console.log(`  Rate: ${kyberSAvaxPerAvax.toFixed(6)} sAVAX/AVAX → Ratio: ${kyberAvaxPerSAvax.toFixed(6)} | Available: $${snap.availableBorrowsUsd.toFixed(2)}`);
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

        // b) Swap WAVAX → sAVAX direkt via KyberSwap (kein Unwrap nötig)
        const { hash: stakeHash, sAvaxReceived } = await this.aave.swapWavaxForSAvax(borrowTokenAmount, swapRetryCallback);
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

    // Callback: nach 3 Swap-Fehlversuchen Nutzer befragen ob weitermachen
    const swapRetryCallback = (rl && confirmFn)
      ? async () => confirmFn(rl, 'Swap nach 3 Versuchen fehlgeschlagen. Nochmals versuchen?')
      : undefined;

    console.log('');
    console.log('╔═════════════════════════════════════════════╗');
    console.log('║       LOOP ENGINE – UNWIND POSITION         ║');
    console.log('╚═════════════════════════════════════════════╝');

    // ── Hilfsfunktion: WAVAX in Wallet als Repay einsetzen ───────────────────
    // Zahlt min(walletWavax, openDebt) zurück.
    // Gibt true zurück wenn ein Repay stattgefunden hat.
    const repayWavaxFromWallet = async (): Promise<boolean> => {
      const wavax = await this.aave.getBalance(ADDRESSES.WAVAX);
      if (wavax === 0n) return false;
      const snap = await this.aave.getAccountSnapshot();
      if (snap.totalDebtUsd < 0.05) return false;

      // Offener Debt in WAVAX
      const wavaxPrice = await this.aave.getAssetPrice(ADDRESSES.WAVAX);
      const debtWavax = this.risk.baseToTokenAmount(
        BigInt(Math.floor(snap.totalDebtUsd * 1e8)),
        wavaxPrice,
      );

      // Repay-Betrag: alle WAVAX wenn Debt größer, sonst nur Debt-Betrag
      // MaxUint256 → Aave begrenzt automatisch auf offenen Debt (kein Überzug)
      const repayAmount = wavax >= debtWavax ? 2n ** 256n - 1n : wavax;
      console.log(`  [PRE] Wallet: ${formatEther(wavax)} WAVAX | Offener Debt: ${formatEther(debtWavax)} WAVAX → Repay: ${repayAmount === 2n ** 256n - 1n ? 'MaxUint256 (alles)' : formatEther(repayAmount) + ' WAVAX'}`);
      try {
        const h = await this.aave.repayWavax(repayAmount);
        txHashes.push(h);
        console.log(`  ✓ WAVAX Repay erfolgreich`);
        return true;
      } catch (err) {
        console.log(`  ⚠ WAVAX Repay fehlgeschlagen: ${err}`);
        return false;
      }
    };

    // ── Cleanup: Rest-Collateral abholen + alles zu AVAX tauschen ────────────
    const cleanup = async () => {
      // 1. Verbliebenes Collateral von Aave (falls kein Debt mehr)
      const cleanSnap = await this.aave.getAccountSnapshot();
      if (cleanSnap.totalCollateralUsd > 0.01 && cleanSnap.totalDebtUsd < 0.05) {
        console.log(`  → Cleanup: Withdraw Rest-Collateral ($${cleanSnap.totalCollateralUsd.toFixed(4)}) von Aave...`);
        try {
          const wh = await this.aave.withdrawSAvax(2n ** 256n - 1n);
          txHashes.push(wh);
        } catch (err) {
          console.log(`  ⚠ Collateral-Withdraw fehlgeschlagen: ${err}`);
        }
      }
      // 2. sAVAX in Wallet → AVAX
      const walletSAvax = await this.aave.getBalance(ADDRESSES.sAVAX);
      if (walletSAvax > 0n) {
        console.log(`  → Cleanup: Swap ${formatEther(walletSAvax)} sAVAX → AVAX...`);
        try {
          const { hash: sh } = await this.aave.swapSAvaxForAvax(walletSAvax, swapRetryCallback);
          txHashes.push(sh);
        } catch (err) {
          console.log(`  ⚠ sAVAX→AVAX Swap fehlgeschlagen: ${err}`);
        }
      }
      // 3. WAVAX in Wallet → AVAX unwrappen
      const walletWavax2 = await this.aave.getBalance(ADDRESSES.WAVAX);
      if (walletWavax2 > 0n) {
        console.log(`  → Cleanup: Unwrap ${formatEther(walletWavax2)} WAVAX → AVAX...`);
        try {
          const uh = await this.aave.unwrapWavax(walletWavax2);
          txHashes.push(uh);
        } catch (err) {
          console.log(`  ⚠ WAVAX Unwrap fehlgeschlagen: ${err}`);
        }
      }
      // 4. Finale Balance
      const finalAvax = await this.aave.getNativeBalance();
      const finalSAvax = await this.aave.getBalance(ADDRESSES.sAVAX);
      const finalWavax = await this.aave.getBalance(ADDRESSES.WAVAX);
      console.log(`  Wallet final: ${formatEther(finalAvax)} AVAX, ${formatEther(finalSAvax)} sAVAX, ${formatEther(finalWavax)} WAVAX`);
    };

    // ── Schritt 0: WAVAX in Wallet vorab zurückzahlen ────────────────────────
    await repayWavaxFromWallet();

    while (iterations < MAX_ITER) {
      iterations++;
      console.log(`\n  ── Unwind Iteration ${iterations}/${MAX_ITER} ──`);

      const snap = await this.aave.getAccountSnapshot();
      console.log(`  HF: ${snap.healthFactor.toFixed(4)} | Leverage: ${snap.leverage.toFixed(2)}x | Debt: $${snap.totalDebtUsd.toFixed(2)} | Collateral: $${snap.totalCollateralUsd.toFixed(2)}`);

      // Fertig wenn kein Debt mehr
      if (snap.totalDebtUsd < 0.05) {
        console.log('  ✓ Kein Debt mehr – Unwind abgeschlossen.');
        await cleanup();
        const finalSnap = await this.aave.getAccountSnapshot();
        return { iterations, finalSnapshot: finalSnap, txHashes, success: true, reason: 'Unwind abgeschlossen' };
      }

      // ── Schritt 1: Withdraw-Menge berechnen ───────────────────────────────
      // Ziel: so viel sAVAX withdrawen wie nötig um den gesamten Debt zurückzuzahlen
      // (inkl. Slippage-Buffer), aber max. was Aave bei HF ≥ 1.001 erlaubt.
      const sAvaxPrice = await this.aave.getAssetPrice(ADDRESSES.sAVAX);
      const wavaxPrice = await this.aave.getAssetPrice(ADDRESSES.WAVAX);
      const lt = snap.liquidationThresholdPct / 100;
      const sAvaxRatio = Number(sAvaxPrice) / Number(wavaxPrice); // sAVAX-Wert in WAVAX-Einheiten

      // Gewünschter Withdraw: genug um gesamten Debt zu decken + Slippage
      const targetWithdrawUsd = snap.totalDebtUsd * sAvaxRatio * (1 + CONFIG.slippageBps / 10000);

      // Maximum was Aave erlaubt (HF nach Withdraw ≥ 1.001)
      const minHFForWithdraw = 1.001;
      const maxWithdrawUsd = snap.totalCollateralUsd - (minHFForWithdraw * snap.totalDebtUsd / lt);

      if (maxWithdrawUsd <= 0) {
        // HF zu niedrig – erst WAVAX aus Wallet repay'en falls vorhanden
        const repaid = await repayWavaxFromWallet();
        if (!repaid) {
          console.log('  ✗ HF zu niedrig und kein WAVAX in Wallet – Unwind blockiert.');
          break;
        }
        await sleep(2000);
        continue;
      }

      // Nehme das Minimum aus gewünschtem und maximal erlaubtem Withdraw
      const withdrawUsd = Math.min(targetWithdrawUsd, maxWithdrawUsd);
      let withdrawSAvax = this.risk.baseToTokenAmount(
        BigInt(Math.floor(withdrawUsd * 1e8)),
        sAvaxPrice,
      );

      // Clamp auf verfügbare aToken-Balance
      const aSAvaxBalance = await this.aave.getBalance(ADDRESSES.aSAVAX);
      if (withdrawSAvax > aSAvaxBalance) {
        withdrawSAvax = aSAvaxBalance;
      }

      if (withdrawSAvax === 0n) {
        console.log('  ✗ Withdraw-Betrag = 0 – abgebrochen.');
        break;
      }

      const wavaxDebtToken = this.risk.baseToTokenAmount(
        BigInt(Math.floor(snap.totalDebtUsd * 1e8)),
        wavaxPrice,
      );
      console.log(`  Debt:     $${snap.totalDebtUsd.toFixed(2)} (≈ ${formatEther(wavaxDebtToken)} WAVAX)`);
      console.log(`  Withdraw: ${formatEther(withdrawSAvax)} sAVAX ($${withdrawUsd.toFixed(2)}, max erlaubt: $${maxWithdrawUsd.toFixed(2)})`);

      // Bestätigung (wenn interaktiv)
      if (rl && confirmFn) {
        const ok = await confirmFn(rl, `Iteration ${iterations}: ${formatEther(withdrawSAvax)} sAVAX withdraw → swap → repay?`);
        if (!ok) {
          await cleanup();
          const currentSnap = await this.aave.getAccountSnapshot();
          return { iterations, finalSnapshot: currentSnap, txHashes, success: true, reason: 'Vom Nutzer abgebrochen' };
        }
      }

      try {
        // ── Schritt 2: Withdraw sAVAX ────────────────────────────────────────
        const withdrawHash = await this.aave.withdrawSAvax(withdrawSAvax);
        txHashes.push(withdrawHash);

        // ── Schritt 3: sAVAX → WAVAX via KyberSwap ──────────────────────────
        const sAvaxInWallet = await this.aave.getBalance(ADDRESSES.sAVAX);
        const swapAmount = sAvaxInWallet > 0n ? sAvaxInWallet : withdrawSAvax;
        const { hash: swapHash } = await this.aave.swapSAvaxForWavax(swapAmount, swapRetryCallback);
        txHashes.push(swapHash);

        // ── Schritt 4: WAVAX repay'en ─────────────────────────────────────────
        // Alle WAVAX in Wallet lesen (echte On-Chain-Balance nach Swap-Bestätigung)
        const wavaxInWallet = await this.aave.getBalance(ADDRESSES.WAVAX);
        if (wavaxInWallet === 0n) {
          console.log('  ⚠ Kein WAVAX in Wallet nach Swap – überspringe Repay');
          continue;
        }
        const currentSnap = await this.aave.getAccountSnapshot();
        const currentDebtWavax = this.risk.baseToTokenAmount(
          BigInt(Math.floor(currentSnap.totalDebtUsd * 1e8)),
          wavaxPrice,
        );
        // Wenn WAVAX >= Debt → MaxUint256 damit Aave exakt den Debt abzieht (kein Überzug)
        const repayAmount = wavaxInWallet >= currentDebtWavax ? 2n ** 256n - 1n : wavaxInWallet;
        const repayHash = await this.aave.repayWavax(repayAmount);
        txHashes.push(repayHash);

        console.log(`  ✓ Iteration ${iterations} erfolgreich (${formatEther(wavaxInWallet)} WAVAX repaid)`);

      } catch (err) {
        console.error(`  ✗ Fehler in Unwind-Iteration ${iterations}:`, err);
        await cleanup();
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

    // Schleife beendet – Cleanup
    await cleanup();
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
