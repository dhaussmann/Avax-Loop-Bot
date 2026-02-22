// ============================================================================
// monitor.ts – Periodische HF-Überwachung mit Auto-Protection
// ============================================================================
// Läuft als Daemon und überwacht den Health Factor.
// Bei Unterschreitung der Schwellwerte wird automatisch deleveraged.
// ============================================================================

import { AaveClient } from './aaveClient.js';
import { RiskEngine, type RiskAssessment } from './riskEngine.js';
import { LoopEngine } from './loopEngine.js';
import { CONFIG } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type MonitorEvent = {
  timestamp: Date;
  healthFactor: number;
  leverage: number;
  action: string;
  details: string;
};

// ---------------------------------------------------------------------------
// Monitor Klasse
// ---------------------------------------------------------------------------
export class Monitor {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;
  private eventLog: MonitorEvent[] = [];
  private consecutiveErrors = 0;
  private readonly maxConsecutiveErrors = 5;

  constructor(
    private readonly aave: AaveClient,
    private readonly risk: RiskEngine,
    private readonly loop: LoopEngine,
  ) {}

  // =========================================================================
  // Start / Stop
  // =========================================================================
  
  start(): void {
    if (this.intervalHandle) {
      console.log('Monitor läuft bereits.');
      return;
    }

    console.log('');
    console.log('╔═════════════════════════════════════════════╗');
    console.log('║       HF MONITOR – GESTARTET                ║');
    console.log('╚═════════════════════════════════════════════╝');
    console.log(`  Interval:        ${CONFIG.monitorIntervalMs / 1000}s`);
    console.log(`  Min HF Action:   ${CONFIG.minHFForAction}`);
    console.log(`  Emergency HF:    ${CONFIG.emergencyHF}`);
    console.log(`  Target HF:       ${CONFIG.targetHF}`);
    console.log('');

    // Sofort ersten Check
    this.tick().catch(err => console.error('Initial tick error:', err));

    // Dann periodisch
    this.intervalHandle = setInterval(() => {
      this.tick().catch(err => console.error('Monitor tick error:', err));
    }, CONFIG.monitorIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log('Monitor gestoppt.');
    }
  }

  // =========================================================================
  // Haupt-Tick
  // =========================================================================
  
  private async tick(): Promise<void> {
    // Verhindere parallele Ausführung
    if (this.isProcessing) {
      console.log(`  [${this.timestamp()}] ⏳ Vorheriger Tick läuft noch...`);
      return;
    }

    this.isProcessing = true;

    try {
      const snap = await this.aave.getAccountSnapshot();
      const assessment = this.risk.assess(snap);

      // Reset Error Counter bei Erfolg
      this.consecutiveErrors = 0;

      // Log
      const event: MonitorEvent = {
        timestamp: new Date(),
        healthFactor: snap.healthFactor,
        leverage: snap.leverage,
        action: assessment.action,
        details: assessment.reason,
      };
      this.eventLog.push(event);

      // Compact Log Line
      const hfEmoji = this.getHFEmoji(snap.healthFactor);
      console.log(
        `  [${this.timestamp()}] ${hfEmoji} HF: ${snap.healthFactor.toFixed(4)} | ` +
        `Lev: ${snap.leverage.toFixed(2)}x | ` +
        `Col: $${snap.totalCollateralUsd.toFixed(0)} | ` +
        `Debt: $${snap.totalDebtUsd.toFixed(0)} | ` +
        `→ ${assessment.action}`
      );

      // Aktion ausführen
      await this.handleAssessment(assessment);

    } catch (err) {
      this.consecutiveErrors++;
      console.error(`  [${this.timestamp()}] ✗ Monitor Error (${this.consecutiveErrors}/${this.maxConsecutiveErrors}):`, err);

      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        console.error('  ⛔ Zu viele aufeinanderfolgende Fehler – Monitor wird gestoppt!');
        this.stop();
      }
    } finally {
      this.isProcessing = false;
    }
  }

  // =========================================================================
  // Assessment Handler
  // =========================================================================
  
  private async handleAssessment(assessment: RiskAssessment): Promise<void> {
    switch (assessment.action) {
      case 'EMERGENCY_DELEVERAGE':
        console.log('  🚨 EMERGENCY DELEVERAGE TRIGGERED!');
        await this.loop.emergencyDeleverage();
        break;

      case 'DELEVERAGE':
        console.log('  ⚠️  Deleverage nötig...');
        await this.loop.deleverage();
        break;

      case 'LOOP_MORE':
        // Im Monitor-Modus NICHT automatisch mehr leveragen
        // Das soll nur manuell passieren (Sicherheit!)
        console.log('  ℹ️  Mehr Leverage möglich – manuell starten mit: npm run loop');
        break;

      case 'HOLD':
        // Nichts tun – alles OK
        break;
    }
  }

  // =========================================================================
  // Event Log
  // =========================================================================
  
  getEventLog(): MonitorEvent[] {
    return [...this.eventLog];
  }

  getLastEvents(n: number = 10): MonitorEvent[] {
    return this.eventLog.slice(-n);
  }

  // =========================================================================
  // Utility
  // =========================================================================
  
  private timestamp(): string {
    return new Date().toISOString().substring(11, 19);
  }

  private getHFEmoji(hf: number): string {
    if (hf === 0 || !isFinite(hf)) return '⚪';
    if (hf < CONFIG.emergencyHF) return '🔴';
    if (hf < CONFIG.minHFForAction) return '🟠';
    if (hf < CONFIG.targetHF + 0.1) return '🟡';
    return '🟢';
  }
}
