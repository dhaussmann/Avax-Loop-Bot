// ============================================================================
// riskEngine.ts – Health Factor Berechnung, Leverage-Logik, Deleverage-Math
// ============================================================================
// Implementiert die exakte Aave HF-Formel und berechnet benötigte
// Repay/Withdraw-Beträge für einen gewünschten Ziel-HF.
//
// HF = (Collateral_USD * LiquidationThreshold) / Debt_USD
// Leverage = Collateral / (Collateral - Debt) = Collateral / Equity
// ============================================================================

import { CONFIG, EMODE } from './config.js';
import type { AccountData, AccountSnapshot } from './aaveClient.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type RiskAssessment = {
  snapshot: AccountSnapshot;
  action: 'LOOP_MORE' | 'HOLD' | 'DELEVERAGE' | 'EMERGENCY_DELEVERAGE';
  reason: string;
};

export type DeleverageCalc = {
  repayAmountBase: bigint;       // In base currency units (8 decimals)
  withdrawAmountBase: bigint;    // In base currency units
  estimatedNewHF: number;
  estimatedNewLeverage: number;
};

// ---------------------------------------------------------------------------
// RiskEngine Klasse
// ---------------------------------------------------------------------------
export class RiskEngine {
  
  // =========================================================================
  // Snapshot aus Raw Data berechnen
  // =========================================================================
  
  computeSnapshot(data: AccountData): AccountSnapshot {
    const hf = Number(data.healthFactor) / 1e18;
    const collateral = Number(data.totalCollateralBase) / 1e8;
    const debt = Number(data.totalDebtBase) / 1e8;
    const equity = collateral - debt;

    return {
      raw: data,
      healthFactor: hf,
      leverage: equity > 0 ? collateral / equity : 0,
      totalCollateralUsd: collateral,
      totalDebtUsd: debt,
      availableBorrowsUsd: Number(data.availableBorrowsBase) / 1e8,
      ltvPct: Number(data.ltv) / 100,
      liquidationThresholdPct: Number(data.currentLiquidationThreshold) / 100,
    };
  }

  // =========================================================================
  // Risiko-Assessment: Was soll der Bot tun?
  // =========================================================================
  
  assess(snapshot: AccountSnapshot): RiskAssessment {
    const { healthFactor, leverage } = snapshot;

    // 1. Emergency: HF kritisch niedrig
    if (healthFactor > 0 && healthFactor < CONFIG.emergencyHF) {
      return {
        snapshot,
        action: 'EMERGENCY_DELEVERAGE',
        reason: `HF ${healthFactor.toFixed(4)} < Emergency-Schwelle ${CONFIG.emergencyHF}`,
      };
    }

    // 2. Deleverage: HF unter Safety-Margin
    if (healthFactor > 0 && healthFactor < CONFIG.minHFForAction) {
      return {
        snapshot,
        action: 'DELEVERAGE',
        reason: `HF ${healthFactor.toFixed(4)} < Min-HF ${CONFIG.minHFForAction}`,
      };
    }

    // 3. Kein Debt → kann loopen (erster Supply)
    if (snapshot.totalDebtUsd === 0) {
      return {
        snapshot,
        action: 'LOOP_MORE',
        reason: 'Kein Debt vorhanden – initiales Looping möglich',
      };
    }

    // 4. Leverage unter Target UND HF über Ziel
    if (leverage < CONFIG.targetLeverage && healthFactor > CONFIG.targetHF) {
      return {
        snapshot,
        action: 'LOOP_MORE',
        reason: `Leverage ${leverage.toFixed(2)}x < Target ${CONFIG.targetLeverage}x, HF ${healthFactor.toFixed(4)} über Ziel`,
      };
    }

    // 5. Alles im Zielbereich
    return {
      snapshot,
      action: 'HOLD',
      reason: `Leverage ${leverage.toFixed(2)}x, HF ${healthFactor.toFixed(4)} – im Zielbereich`,
    };
  }

  // =========================================================================
  // Nächste Borrow-Größe für Loop-Iteration berechnen
  // =========================================================================
  /**
   * Berechnet den optimalen Borrow-Betrag für die nächste Loop-Iteration.
   * 
   * Strategie: Borrow so viel, dass der resultierende HF knapp über targetHF liegt.
   * 
   * HF_new = (Collateral_new * LT) / Debt_new
   * 
   * Wenn wir X borgen und das als Collateral re-supplyen:
   *   Collateral_new = Collateral + X * (sAvaxPrice/avaxPrice)  (wegen AVAX→sAVAX swap)
   *   Debt_new = Debt + X
   * 
   * Für korrelierten E-Mode (sAVAX ≈ AVAX, Ratio ~1.0-1.2):
   *   HF_target = ((C + X*r) * LT) / (D + X)
   * 
   * Auflösung nach X:
   *   X = (HF_target * D - C * LT) / (C_ratio * LT - HF_target)
   *   wobei C_ratio = sAVAX_price / WAVAX_price in Aave Oracle Terms
   */
  calculateNextBorrowAmount(
    snapshot: AccountSnapshot,
    sAvaxToAvaxRatio: number = 1.0, // Wie viel Collateral-Value pro geborgtem AVAX-Value zurückkommt
  ): bigint {
    const { totalCollateralUsd, totalDebtUsd, liquidationThresholdPct } = snapshot;
    const lt = liquidationThresholdPct / 100; // z.B. 0.95
    const targetHF = CONFIG.targetHF;

    // Wenn kein Debt, borrow basierend auf verfügbarem Borrow
    if (totalDebtUsd === 0) {
      // Erste Iteration: Borrow 80% der verfügbaren Capacity für Safety
      const maxBorrow = snapshot.availableBorrowsUsd;
      const safeBorrow = maxBorrow * 0.8;
      return BigInt(Math.floor(safeBorrow * 1e8));
    }

    // Formel: X = (targetHF * Debt - Collateral * LT) / (sAvaxRatio * LT - targetHF)
    const numerator = targetHF * totalDebtUsd - totalCollateralUsd * lt;
    const denominator = sAvaxToAvaxRatio * lt - targetHF;

    if (denominator <= 0 || numerator >= 0) {
      // Kann Target-HF nicht mehr erreichen oder bereits darüber → kein weiterer Borrow
      return 0n;
    }

    const borrowUsd = Math.abs(numerator / denominator);
    
    // Safety: Max 90% der verfügbaren Borrow-Capacity pro Iteration
    const maxBorrowUsd = snapshot.availableBorrowsUsd * 0.9;
    const finalBorrowUsd = Math.min(borrowUsd, maxBorrowUsd);

    // Minimum: Nicht weniger als $1 borgen (Gas-kosten vs. Nutzen)
    if (finalBorrowUsd < 1) return 0n;

    return BigInt(Math.floor(finalBorrowUsd * 1e8));
  }

  // =========================================================================
  // Berechne Repay-Betrag für Ziel-HF (Deleverage)
  // =========================================================================
  /**
   * Berechnet wie viel Debt repaid werden muss, um den gewünschten HF zu erreichen.
   * 
   * Beim Deleverage:
   * 1. Withdraw sAVAX (reduziert Collateral)
   * 2. sAVAX → AVAX swap
   * 3. AVAX → WAVAX wrap
   * 4. Repay WAVAX (reduziert Debt)
   * 
   * Vereinfachung (sAVAX ≈ AVAX im E-Mode):
   *   HF_target = ((C - W) * LT) / (D - R)
   *   wobei W = withdraw amount (≈ R für korrelierte Assets)
   *   
   * Auflösung nach R (repay amount):
   *   R = D - ((C - R*ratio) * LT) / HF_target
   *   R = (D * HF_target - C * LT) / (HF_target - ratio * LT)
   */
  calculateDeleverageAmount(
    snapshot: AccountSnapshot,
    targetHF: number,
    sAvaxToAvaxRatio: number = 1.0,
  ): DeleverageCalc {
    const { totalCollateralUsd, totalDebtUsd, liquidationThresholdPct } = snapshot;
    const lt = liquidationThresholdPct / 100;

    // R = (D * HF_target - C * LT) / (HF_target - ratio * LT)
    const numerator = totalDebtUsd * targetHF - totalCollateralUsd * lt;
    const denominator = targetHF - sAvaxToAvaxRatio * lt;

    let repayUsd: number;

    if (denominator === 0) {
      // Fallback: 10% des Debts
      repayUsd = totalDebtUsd * 0.1;
    } else {
      repayUsd = numerator / denominator;
    }

    // Clamp: mindestens 0, maximal gesamter Debt
    repayUsd = Math.max(0, Math.min(repayUsd, totalDebtUsd));

    // Withdraw muss proportional sein (+ slippage buffer)
    const slippageMultiplier = 1 + CONFIG.slippageBps / 10000;
    const withdrawUsd = repayUsd * sAvaxToAvaxRatio * slippageMultiplier;

    // Geschätzte neue Werte
    const newCollateral = totalCollateralUsd - withdrawUsd;
    const newDebt = totalDebtUsd - repayUsd;
    const newHF = newDebt > 0 ? (newCollateral * lt) / newDebt : Infinity;
    const newEquity = newCollateral - newDebt;
    const newLeverage = newEquity > 0 ? newCollateral / newEquity : 0;

    return {
      repayAmountBase: BigInt(Math.floor(repayUsd * 1e8)),
      withdrawAmountBase: BigInt(Math.floor(withdrawUsd * 1e8)),
      estimatedNewHF: newHF,
      estimatedNewLeverage: newLeverage,
    };
  }

  // =========================================================================
  // Emergency: Maximales Deleverage bis HF sicher ist
  // =========================================================================
  
  calculateEmergencyDeleverage(snapshot: AccountSnapshot): DeleverageCalc {
    // Ziel: HF auf minHFForAction + 10% Buffer
    const safeHF = CONFIG.minHFForAction + 0.1;
    return this.calculateDeleverageAmount(snapshot, safeHF);
  }

  // =========================================================================
  // USD → Token Amount Conversion
  // =========================================================================
  
  /** Konvertiert Base Currency (USD, 8 dec) zu Token Amount (18 dec) basierend auf Oracle Preis */
  baseToTokenAmount(baseAmount: bigint, oraclePrice: bigint): bigint {
    if (oraclePrice === 0n) return 0n;
    // baseAmount ist in 8 decimals, oraclePrice ist in 8 decimals, Token hat 18 decimals
    // tokenAmount = baseAmount * 1e18 / oraclePrice
    return (baseAmount * 10n ** 18n) / oraclePrice;
  }

  // =========================================================================
  // Max Leverage Berechnung (theoretisch)
  // =========================================================================
  
  static maxTheoreticalLeverage(ltv: number = EMODE.ltv): number {
    return 1 / (1 - ltv);
  }

  static leverageAtHF(hf: number, lt: number = EMODE.liquidationThreshold): number {
    // leverage = 1 / (1 - lt/hf)
    const ratio = lt / hf;
    if (ratio >= 1) return Infinity;
    return 1 / (1 - ratio);
  }
}
