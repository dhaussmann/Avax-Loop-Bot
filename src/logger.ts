// ============================================================================
// logger.ts – Session-Logging für Loop & Unwind
// ============================================================================
// Speichert jede Loop/Unwind-Session als JSON-Datei in logs/
// und gibt eine formatierte Zusammenfassung im Terminal aus.
// ============================================================================

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { LoopResult } from './loopEngine.js';

const LOGS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');

// ---------------------------------------------------------------------------
// JSON-Datei speichern
// ---------------------------------------------------------------------------

export function saveSessionLog(result: LoopResult): string {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  // Dateiname: 2025-02-22T14-30-00_build.json
  const filename = `${result.sessionId}_${result.action}.json`;
  const filepath = join(LOGS_DIR, filename);

  // AccountSnapshot.raw enthält BigInt-Felder → als String serialisieren
  writeFileSync(filepath, JSON.stringify(result, (_key, val) =>
    typeof val === 'bigint' ? val.toString() : val
  , 2), 'utf8');
  console.log(`\n  Log gespeichert: logs/${filename}`);
  return filepath;
}

// ---------------------------------------------------------------------------
// Terminal-Zusammenfassung
// ---------------------------------------------------------------------------

export function printSessionSummary(result: LoopResult): void {
  const actionLabel = result.action === 'build' ? 'LOOP BUILD' : 'LOOP UNWIND';
  const durationSec = (
    (new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime()) / 1000
  ).toFixed(0);

  console.log('\n╔═════════════════════════════════════════════╗');
  console.log(`║  SESSION SUMMARY – ${actionLabel.padEnd(25)}║`);
  console.log('╚═════════════════════════════════════════════╝');
  console.log(`  Session:     ${result.sessionId}`);
  console.log(`  Gestartet:   ${result.startedAt.slice(0, 19).replace('T', ' ')}`);
  console.log(`  Beendet:     ${result.finishedAt.slice(0, 19).replace('T', ' ')}`);
  console.log(`  Dauer:       ${durationSec}s`);
  console.log(`  Iterationen: ${result.iterations}`);
  console.log(`  Status:      ${result.success ? '✓ OK' : '✗ Fehler'}`);
  console.log(`  Grund:       ${result.reason}`);

  console.log('');
  console.log('  Positionsveränderung:');
  console.log(`    Collateral: $${result.initialSnapshot.totalCollateralUsd.toFixed(2)} → $${result.finalSnapshot.totalCollateralUsd.toFixed(2)}`);
  console.log(`    Debt:       $${result.initialSnapshot.totalDebtUsd.toFixed(2)} → $${result.finalSnapshot.totalDebtUsd.toFixed(2)}`);
  console.log(`    Leverage:   ${result.initialSnapshot.leverage.toFixed(2)}x → ${result.finalSnapshot.leverage.toFixed(2)}x`);
  console.log(`    HF:         ${result.initialSnapshot.healthFactor.toFixed(4)} → ${result.finalSnapshot.healthFactor.toFixed(4)}`);

  if (result.records.length === 0) {
    console.log('\n  Keine Transaktionen.');
    console.log('═══════════════════════════════════════════════');
    return;
  }

  console.log(`\n  Transaktionen (${result.records.length}):`);
  console.log('  ───────────────────────────────────────────────');

  for (const r of result.records) {
    const time = r.timestamp.slice(11, 19); // HH:MM:SS
    const typeLabel = r.type.toUpperCase().padEnd(8);

    // Betrag-Zeile
    let amountLine = '';
    if (r.amountIn && r.tokenIn && r.amountOut && r.tokenOut) {
      amountLine = `${r.amountIn} ${r.tokenIn} → ${r.amountOut} ${r.tokenOut}`;
    } else if (r.amountOut && r.tokenOut) {
      amountLine = `${r.amountOut} ${r.tokenOut}`;
    } else if (r.amountIn && r.tokenIn) {
      amountLine = `${r.amountIn} ${r.tokenIn}`;
    }

    const rateStr = r.rate ? ` @ ${r.rate}` : '';
    const usdStr = r.valueUsd ? ` ($${r.valueUsd})` : '';
    const noteStr = r.note ? `  [${r.note}]` : '';

    console.log(`  [${time}] ${typeLabel} ${amountLine}${rateStr}${usdStr}${noteStr}`);
    console.log(`            ${r.snowtraceUrl}`);
  }

  console.log('═══════════════════════════════════════════════');
}
