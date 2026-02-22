// ============================================================================
// index.ts – Entry Point für den sAVAX Loop Bot
// ============================================================================
// CLI-Interface mit verschiedenen Actions:
//   --action=status       → Account Status anzeigen
//   --action=loop         → Leverage-Loop aufbauen
//   --action=test         → Testmodus: ein Schritt (AVAX→sAVAX→Supply→Borrow)
//   --action=monitor      → HF-Monitor starten (Daemon)
//   --action=deleverage   → Manuelles Deleverage
//   --action=unwind       → Komplettes Position-Unwind (fullUnwind)
//   --action=unwind-loop  → Iterativer Loop-Abbau (withdraw sAVAX→swap→wrap→repay)
//   --action=emode        → E-Mode aktivieren
// ============================================================================

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { writeFileSync, existsSync } from 'fs';
import * as readline from 'readline';
import { AaveClient } from './aaveClient.js';
import { RiskEngine } from './riskEngine.js';
import { LoopEngine } from './loopEngine.js';
import { Monitor } from './monitor.js';
import { CONFIG, EMODE, logConfig } from './config.js';

// ---------------------------------------------------------------------------
// Readline Helper – fragt den Nutzer nach Eingabe
// ---------------------------------------------------------------------------
function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(question);
    rl.once('line', answer => resolve(answer.trim()));
  });
}

async function confirm(rl: readline.Interface, message: string): Promise<boolean> {
  while (true) {
    const answer = await ask(rl, `\n  ${message} [j/n]: `);
    if (answer.toLowerCase() === 'j' || answer.toLowerCase() === 'ja') return true;
    if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'nein') return false;
    console.log('  Bitte "j" oder "n" eingeben.');
  }
}

// ---------------------------------------------------------------------------
// Parameter-Wizard: Alle relevanten Einstellungen abfragen
// ---------------------------------------------------------------------------
async function runParameterWizard(rl: readline.Interface): Promise<void> {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║           PARAMETER KONFIGURATION                        ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log('║  Drücke Enter um den aktuellen Wert zu übernehmen.       ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');

  const changes: string[] = [];

  // Target Leverage
  const leverageInput = await ask(
    rl,
    `  Target Leverage [aktuell: ${CONFIG.targetLeverage}x, z.B. 5 für konservativ / 14 für aggressiv]: `,
  );
  if (leverageInput !== '' && !isNaN(Number(leverageInput))) {
    process.env.TARGET_LEVERAGE = leverageInput;
    changes.push(`TARGET_LEVERAGE=${leverageInput}`);
  }

  // Target HF
  const hfInput = await ask(
    rl,
    `  Ziel Health Factor [aktuell: ${CONFIG.targetHF}, mind. 1.01]: `,
  );
  if (hfInput !== '' && !isNaN(Number(hfInput))) {
    process.env.TARGET_HF = hfInput;
    changes.push(`TARGET_HF=${hfInput}`);
  }

  // Min HF Action
  const minHFInput = await ask(
    rl,
    `  Auto-Deleverage Schwelle HF [aktuell: ${CONFIG.minHFForAction}]: `,
  );
  if (minHFInput !== '' && !isNaN(Number(minHFInput))) {
    process.env.MIN_HF_ACTION = minHFInput;
    changes.push(`MIN_HF_ACTION=${minHFInput}`);
  }

  // Slippage
  const slippageInput = await ask(
    rl,
    `  Slippage Toleranz in Basispunkten [aktuell: ${CONFIG.slippageBps} bps = ${CONFIG.slippageBps / 100}%]: `,
  );
  if (slippageInput !== '' && !isNaN(Number(slippageInput))) {
    process.env.SLIPPAGE_BPS = slippageInput;
    changes.push(`SLIPPAGE_BPS=${slippageInput}`);
  }

  // Monitor Intervall
  const intervalInput = await ask(
    rl,
    `  Monitor Intervall in ms [aktuell: ${CONFIG.monitorIntervalMs}ms = ${CONFIG.monitorIntervalMs / 1000}s]: `,
  );
  if (intervalInput !== '' && !isNaN(Number(intervalInput))) {
    process.env.MONITOR_INTERVAL_MS = intervalInput;
    changes.push(`MONITOR_INTERVAL_MS=${intervalInput}`);
  }

  // Max Loop Iterationen
  const maxIterInput = await ask(
    rl,
    `  Max Loop-Iterationen [aktuell: ${CONFIG.maxIterations}]: `,
  );
  if (maxIterInput !== '' && !isNaN(Number(maxIterInput))) {
    process.env.MAX_LOOP_ITERATIONS = maxIterInput;
    changes.push(`MAX_LOOP_ITERATIONS=${maxIterInput}`);
  }

  if (changes.length > 0) {
    console.log('\n  Geänderte Parameter:');
    for (const c of changes) console.log(`    ${c}`);

    // In .env persistieren
    const envPath = new URL('../.env', import.meta.url).pathname;
    if (existsSync(envPath)) {
      let envContent = (await import('fs')).readFileSync(envPath, 'utf8');
      for (const change of changes) {
        const [key] = change.split('=');
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, change);
        } else {
          envContent += `\n${change}`;
        }
      }
      writeFileSync(envPath, envContent, 'utf8');
      console.log('  ✓ Parameter in .env gespeichert');
    }
  } else {
    console.log('  Keine Änderungen – bestehende Werte werden verwendet.');
  }
}

// ---------------------------------------------------------------------------
// Parse CLI Args
// ---------------------------------------------------------------------------
function getAction(): string {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg.startsWith('--action=')) {
      return arg.split('=')[1];
    }
  }
  return 'wizard'; // Default: Parameter-Wizard starten
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Prozess mit gesetztem PRIVATE_KEY neu starten
// ---------------------------------------------------------------------------
async function restartWithKey(key: string): Promise<never> {
  const { execFileSync } = await import('child_process');
  const isTsx = process.argv[1]?.endsWith('.ts') || process.execArgv.some(a => a.includes('tsx'));
  if (isTsx) {
    const tsxBin = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
    execFileSync(tsxBin, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, PRIVATE_KEY: key },
    });
  } else {
    execFileSync(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, PRIVATE_KEY: key },
    });
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const envPath = new URL('../.env', import.meta.url).pathname;
  const { readFileSync: fsRead } = await import('fs');

  // ── Wallet-Auswahl ────────────────────────────────────────────────────────
  if (!CONFIG.privateKey || CONFIG.privateKey === '0xYOUR_PRIVATE_KEY_HERE') {
    // Prüfe ob .env bereits einen Key enthält (wurde nicht per process.env übergeben)
    let envKey: string | null = null;
    if (existsSync(envPath)) {
      const envContent = fsRead(envPath, 'utf8');
      const match = envContent.match(/^PRIVATE_KEY=(0x[0-9a-fA-F]+)\s*$/m);
      if (match) envKey = match[1];
    }

    if (envKey) {
      // .env hat einen Key – nachfragen ob verwendet werden soll
      const account = privateKeyToAccount(envKey as `0x${string}`);
      console.log('');
      console.log('  ┌─── Wallet gefunden in .env ─────────────────────────────┐');
      console.log(`  │  Adresse: ${account.address}  │`);
      console.log('  └─────────────────────────────────────────────────────────┘');
      console.log('');

      // Einfache synchrone Abfrage (rl noch nicht initialisiert)
      const rlTemp = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      const useExisting = await new Promise<boolean>(resolve => {
        process.stdout.write('  Gespeicherte Wallet verwenden? [j/n]: ');
        rlTemp.once('line', ans => {
          rlTemp.close();
          resolve(ans.trim().toLowerCase() === 'j' || ans.trim().toLowerCase() === 'ja');
        });
      });

      if (useExisting) {
        console.log('  ✓ Verwende gespeicherte Wallet.\n');
        await restartWithKey(envKey);
      } else {
        console.log('');
        console.log('  Neue Wallet generieren? Der alte Key in .env wird ersetzt.');
        const rlTemp2 = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
        const doNew = await new Promise<boolean>(resolve => {
          process.stdout.write('  Neue Wallet generieren? [j/n]: ');
          rlTemp2.once('line', ans => {
            rlTemp2.close();
            resolve(ans.trim().toLowerCase() === 'j' || ans.trim().toLowerCase() === 'ja');
          });
        });
        if (!doNew) {
          console.log('  Abgebrochen. Trage PRIVATE_KEY manuell in .env ein.');
          process.exit(0);
        }
        // Neue Wallet generieren (Altkey wird ersetzt – weiter unten)
      }
    }

    // Neue Wallet generieren
    const newKey = generatePrivateKey();
    const account = privateKeyToAccount(newKey);

    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║           NEUE WALLET GENERIERT                          ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║  Adresse:     ${account.address}  ║`);
    console.log(`║  Private Key: ${newKey}  ║`);
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log('║  ⚠️  Sichere den Private Key sofort!                      ║');
    console.log('║  Import in Rabby: Einstellungen → Konten → Private Key   ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');

    // In .env schreiben (anlegen oder PRIVATE_KEY ersetzen)
    const envLine = `PRIVATE_KEY=${newKey}`;
    if (existsSync(envPath)) {
      let envContent = fsRead(envPath, 'utf8');
      if (/^PRIVATE_KEY=/m.test(envContent)) {
        envContent = envContent.replace(/^PRIVATE_KEY=.*$/m, envLine);
      } else {
        envContent = envContent.trimEnd() + '\n' + envLine + '\n';
      }
      writeFileSync(envPath, envContent, 'utf8');
    } else {
      writeFileSync(envPath, envLine + '\n', 'utf8');
    }
    console.log(`  ✓ Private Key in .env gespeichert (${envPath})`);
    console.log('  Bot startet neu mit der neuen Wallet...\n');
    await restartWithKey(newKey);
  }

  // ── Readline Interface ────────────────────────────────────────────────────
  const rl = createRL();

  // ── Parameter-Wizard (wenn --no-wizard NICHT gesetzt) ────────────────────
  const action = getAction();
  const skipWizard = hasFlag('--no-wizard') || ['status', 'unwind', 'unwind-loop', 'emode'].includes(action);

  if (!skipWizard) {
    await runParameterWizard(rl);
  }

  logConfig();

  // ── Initialisierung ───────────────────────────────────────────────────────
  const aave = new AaveClient();
  const risk = new RiskEngine();
  const loop = new LoopEngine(aave, risk);
  const monitor = new Monitor(aave, risk, loop);

  console.log(`  Wallet: ${aave.userAddress}`);
  console.log(`\n  Action: ${action}\n`);

  switch (action) {
    // =====================================================================
    // STATUS: Zeige Account-Daten
    // =====================================================================
    case 'status': {
      const snap = await aave.printStatus();
      const assessment = risk.assess(snap);

      console.log('┌─────────────────────────────────────────────┐');
      console.log('│          RISK ASSESSMENT                    │');
      console.log('├─────────────────────────────────────────────┤');
      console.log(`│  Action:  ${assessment.action}`);
      console.log(`│  Reason:  ${assessment.reason}`);
      console.log('├─────────────────────────────────────────────┤');
      console.log(`│  Max theoretisches Leverage (E-Mode):  ${RiskEngine.maxTheoreticalLeverage().toFixed(2)}x`);
      console.log(`│  Leverage bei HF=${CONFIG.targetHF}:           ${RiskEngine.leverageAtHF(CONFIG.targetHF).toFixed(2)}x`);
      console.log(`│  Leverage bei HF=${CONFIG.minHFForAction}:           ${RiskEngine.leverageAtHF(CONFIG.minHFForAction).toFixed(2)}x`);
      console.log('└─────────────────────────────────────────────┘');

      try {
        const rate = await aave.getSAvaxExchangeRate();
        console.log(`\n  sAVAX/AVAX Rate: 1 sAVAX = ${rate.avaxPerSAvax.toFixed(6)} AVAX`);
        console.log(`                   1 AVAX  = ${rate.sAvaxPerAvax.toFixed(6)} sAVAX`);
      } catch {
        console.log('  (sAVAX Rate nicht verfügbar)');
      }
      break;
    }

    // =====================================================================
    // TEST: Ein einzelner Schritt mit Kurs-Prüfung & Bestätigung
    // =====================================================================
    case 'test': {
      console.log('╔═══════════════════════════════════════════════════════════╗');
      console.log('║           TESTMODUS – EIN LOOP-SCHRITT                   ║');
      console.log('║  Führt genau eine Iteration aus:                         ║');
      console.log('║    1. Kurs-Check AVAX → sAVAX                            ║');
      console.log('║    2. AVAX → sAVAX tauschen (BENQI)                      ║');
      console.log('║    3. sAVAX als Collateral auf Aave supplyen             ║');
      console.log('║    4. WAVAX gegen sAVAX borgen                           ║');
      console.log('╚═══════════════════════════════════════════════════════════╝');
      console.log('');

      // Account + Balances zeigen
      await aave.printStatus();

      const { parseEther, formatEther } = await import('viem');

      // Hilfsfunktion: E-Mode aktivieren + WAVAX borgen (50% der verfügbaren Kapazität)
      const borrowRatio = 0.5;
      const doBorrow = async (): Promise<boolean> => {
        const snapForBorrow = await aave.getAccountSnapshot();
        const borrowAvailable = snapForBorrow.availableBorrowsUsd;
        if (borrowAvailable < 0.01) {
          console.log('  ✗ Keine Borrow-Kapazität vorhanden.');
          return false;
        }
        const borrowUsd = borrowAvailable * borrowRatio;
        console.log('');
        console.log(`  Verfügbar zum Borgen:  $${borrowAvailable.toFixed(2)}`);
        console.log(`  Test-Borrow (50%):     $${borrowUsd.toFixed(2)}`);
        console.log('');

        const okBorrow = await confirm(rl, `E-Mode aktivieren + ~$${borrowUsd.toFixed(2)} in WAVAX borgen?`);
        if (!okBorrow) { console.log('  Abgebrochen.'); return false; }

        await aave.enableEMode();

        const snapAfterEMode = await aave.getAccountSnapshot();
        const wavaxPrice = await aave.getAssetPrice('0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7');
        const borrowBase = BigInt(Math.floor(snapAfterEMode.availableBorrowsUsd * borrowRatio * 1e8));
        const borrowToken = risk.baseToTokenAmount(borrowBase, wavaxPrice);

        if (borrowToken === 0n) {
          console.log('  ✗ Borrow-Betrag zu klein.');
          return false;
        }

        await aave.borrowWavax(borrowToken);
        return true;
      };

      // ── sAVAX in Wallet vorhanden? Zuerst supplyen + borgen ─────────────
      const walletSAvax = await aave.getBalance('0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE');
      if (walletSAvax > 0n) {
        console.log('  ── sAVAX in Wallet gefunden ────────────────────────────');
        console.log(`  ${formatEther(walletSAvax)} sAVAX liegen in der Wallet (noch nicht supplied).`);
        const supplyExisting = await confirm(rl, `${formatEther(walletSAvax)} sAVAX jetzt supplyen + AVAX borgen?`);
        if (supplyExisting) {
          await aave.supplySAvax(walletSAvax);
          console.log('  ✓ Bestehende sAVAX gesupplied.');
          console.log('');
          await doBorrow();
          console.log('');
          console.log('  ── Test abgeschlossen ─────────────────────────────────');
          await aave.printStatus();
          break;
        }
      }

      // Kurs-Check
      console.log('  ── Schritt 1: Kurs-Check ──────────────────────────────');
      const rateCheck = await loop.checkExchangeRate(aave);
      if (!rateCheck.ok) {
        console.log(`\n  ✗ Kurs-Warnung: ${rateCheck.message}`);
        const proceed = await confirm(rl, 'Trotz Kurs-Warnung fortfahren?');
        if (!proceed) {
          console.log('  Abgebrochen.');
          break;
        }
      } else {
        console.log(`  ✓ Kurs ok: ${rateCheck.message}`);
      }

      // Betrag für Test – Gas-Reserve aus Config
      const avaxBal = await aave.getNativeBalance();
      const gasReserve = parseEther(CONFIG.gasReserveAvax as `${number}`);
      const maxTestAvax = avaxBal > gasReserve ? avaxBal - gasReserve : 0n;

      if (maxTestAvax === 0n) {
        console.log(`\n  ✗ Zu wenig AVAX für Test (mind. ${CONFIG.gasReserveAvax} AVAX als Gas-Reserve nötig)`);
        console.log(`     Aktuelle Balance: ${formatEther(avaxBal)} AVAX`);
        break;
      }

      console.log(`\n  AVAX Balance:    ${formatEther(avaxBal)} AVAX`);
      console.log(`  Gas-Reserve:     ${CONFIG.gasReserveAvax} AVAX (bleibt immer erhalten)`);
      console.log(`  Max. einsetzbar: ${formatEther(maxTestAvax)} AVAX`);

      const testAmountInput = await ask(
        rl,
        `\n  Wie viel AVAX tauschen? [max: ${formatEther(maxTestAvax)} AVAX, Standard: 0.1]: `,
      );
      const testAmountEth = testAmountInput !== '' && !isNaN(Number(testAmountInput))
        ? testAmountInput
        : '0.1';
      const testAmount = parseEther(testAmountEth as `${number}`);

      if (testAmount > maxTestAvax) {
        console.log(`  ✗ Betrag (${testAmountEth} AVAX) übersteigt max. einsetzbare Menge (${formatEther(maxTestAvax)} AVAX).`);
        break;
      }

      // KyberSwap Quote für Vorschau
      const kyberQuote = await aave.kyberswap.fetchQuoteOnly(
        '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE',
        testAmount,
      );
      const expectedSAvax = Number(kyberQuote.amountOut) / 1e18;
      const expectedSAvaxMin = Number(kyberQuote.amountOutMin) / 1e18;
      console.log('');
      console.log('  ── KyberSwap Vorschau ──────────────────────────────────');
      console.log(`  Einsatz:          ${testAmountEth} AVAX`);
      console.log(`  Erwartete sAVAX:  ${expectedSAvax.toFixed(6)} sAVAX`);
      console.log(`  Minimum sAVAX:    ${expectedSAvaxMin.toFixed(6)} sAVAX  (nach ${CONFIG.slippageBps / 100}% Slippage)`);
      console.log(`  Rate:             1 AVAX = ${(expectedSAvax / Number(testAmountEth)).toFixed(6)} sAVAX`);
      console.log('');

      // Schritt 2: AVAX → sAVAX via KyberSwap
      const ok2 = await confirm(rl, `Schritt 2: ${testAmountEth} AVAX → sAVAX tauschen? (KyberSwap)`);
      if (!ok2) { console.log('  Abgebrochen.'); break; }

      console.log('');
      const { sAvaxReceived } = await aave.stakeAvaxForSAvax(testAmount);

      // Tausch-Ergebnis vs. KyberSwap-Quote prüfen
      const actualSAvax = Number(formatEther(sAvaxReceived));
      console.log('');
      console.log(`  Erhalten:         ${actualSAvax.toFixed(6)} sAVAX`);
      console.log(`  Erwartet:         ${expectedSAvax.toFixed(6)} sAVAX`);
      console.log(`  Minimum (Quote):  ${expectedSAvaxMin.toFixed(6)} sAVAX`);
      if (actualSAvax < expectedSAvaxMin) {
        console.log(`  ⚠️  Erhaltene Menge liegt unter Slippage-Grenze!`);
        const continueDespiteSlippage = await confirm(rl, 'Trotzdem mit Supply fortfahren?');
        if (!continueDespiteSlippage) { console.log('  Abgebrochen.'); break; }
      } else {
        console.log(`  ✓ Tausch ok (Slippage: ${(((expectedSAvax - actualSAvax) / expectedSAvax) * 100).toFixed(3)}%)`);
      }

      // Schritt 3: Supply sAVAX
      const ok3 = await confirm(rl, `Schritt 3: ${formatEther(sAvaxReceived)} sAVAX auf Aave supplyen?`);
      if (!ok3) { console.log('  Abgebrochen.'); break; }

      console.log('');
      await aave.supplySAvax(sAvaxReceived);

      // Schritt 4: E-Mode + Borrow WAVAX
      await doBorrow();

      console.log('');
      console.log('  ── Test abgeschlossen ─────────────────────────────────');
      await aave.printStatus();
      console.log('');
      console.log('  ✓ Testmodus erfolgreich. Überprüfe die Werte oben.');
      console.log('  → Nächster Schritt: npm run loop  (für vollen Leverage-Aufbau)');
      break;
    }

    // =====================================================================
    // LOOP: Leverage aufbauen (mit Bestätigung)
    // =====================================================================
    case 'loop': {
      await aave.printStatus();

      console.log('⚠️  WARNUNG: Dies baut Leverage auf Aave v3 auf!');
      console.log('   Stelle sicher, dass du die Risiken verstehst.');
      console.log(`   Target Leverage:  ~${CONFIG.targetLeverage}x`);
      console.log(`   Target HF:        ~${CONFIG.targetHF}`);
      console.log('');

      // Kurs-Check
      console.log('  ── Kurs-Check ──────────────────────────────────────────');
      const rateCheck = await loop.checkExchangeRate(aave);
      if (!rateCheck.ok) {
        console.log(`  ✗ Kurs-Warnung: ${rateCheck.message}`);
        const proceed = await confirm(rl, 'Trotz Kurs-Warnung mit Loop fortfahren?');
        if (!proceed) { console.log('  Abgebrochen.'); break; }
      } else {
        console.log(`  ✓ ${rateCheck.message}`);
      }

      const ok = await confirm(rl, 'Loop-Aufbau starten?');
      if (!ok) { console.log('  Abgebrochen.'); break; }

      const result = await loop.buildLoop(rl, confirm);

      console.log('\n═══════════════════════════════════════════════');
      console.log('  LOOP RESULT');
      console.log('═══════════════════════════════════════════════');
      console.log(`  Success:     ${result.success}`);
      console.log(`  Iterations:  ${result.iterations}`);
      console.log(`  HF:          ${result.finalSnapshot.healthFactor.toFixed(4)}`);
      console.log(`  Leverage:    ${result.finalSnapshot.leverage.toFixed(2)}x`);
      console.log(`  Collateral:  $${result.finalSnapshot.totalCollateralUsd.toFixed(2)}`);
      console.log(`  Debt:        $${result.finalSnapshot.totalDebtUsd.toFixed(2)}`);
      console.log(`  Txns:        ${result.txHashes.length}`);
      console.log(`  Reason:      ${result.reason}`);
      console.log('═══════════════════════════════════════════════');
      break;
    }

    // =====================================================================
    // MONITOR: HF Überwachung starten
    // =====================================================================
    case 'monitor': {
      const ok = await confirm(rl, 'HF-Monitor starten? (Ctrl+C zum Beenden)');
      if (!ok) { console.log('  Abgebrochen.'); break; }

      await aave.printStatus();
      monitor.start();

      const shutdown = () => {
        console.log('\n  Shutting down monitor...');
        monitor.stop();
        const events = monitor.getLastEvents(20);
        if (events.length > 0) {
          console.log(`\n  Letzte ${events.length} Events:`);
          for (const e of events) {
            console.log(`    ${e.timestamp.toISOString()} | HF: ${e.healthFactor.toFixed(4)} | ${e.action}`);
          }
        }
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      console.log('\n  Monitor läuft. Strg+C zum Beenden.\n');
      break;
    }

    // =====================================================================
    // DELEVERAGE: Manuelles Deleverage
    // =====================================================================
    case 'deleverage': {
      const snap = await aave.printStatus();

      if (snap.totalDebtUsd === 0) {
        console.log('  Kein Debt vorhanden – nichts zu deleveragen.');
        break;
      }

      const targetHFInput = await ask(rl, `  Ziel-HF für Deleverage [aktuell: ${snap.healthFactor.toFixed(4)}, Standard: ${CONFIG.minHFForAction + 0.1}]: `);
      const targetHF = targetHFInput !== '' && !isNaN(Number(targetHFInput))
        ? Number(targetHFInput)
        : CONFIG.minHFForAction + 0.1;

      // Berechnung anzeigen
      const rate = await aave.getSAvaxExchangeRate();
      const calc = risk.calculateDeleverageAmount(snap, targetHF, rate.avaxPerSAvax);
      const { formatEther } = await import('viem');
      const sAvaxPrice = await aave.getAssetPrice('0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE');
      const wavaxPrice = await aave.getAssetPrice('0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7');
      const withdrawToken = risk.baseToTokenAmount(calc.withdrawAmountBase, sAvaxPrice);
      const repayToken = risk.baseToTokenAmount(calc.repayAmountBase, wavaxPrice);

      console.log('');
      console.log('  ── Deleverage Vorschau ─────────────────────────────────');
      console.log(`  Ziel-HF:             ${targetHF}`);
      console.log(`  Withdraw sAVAX:      ~${formatEther(withdrawToken)} sAVAX`);
      console.log(`  Repay WAVAX:         ~${formatEther(repayToken)} WAVAX`);
      console.log(`  Geschätzter HF:      ${calc.estimatedNewHF.toFixed(4)}`);
      console.log(`  Geschätzter Lever.:  ${calc.estimatedNewLeverage.toFixed(2)}x`);
      console.log('');

      const ok = await confirm(rl, `Deleverage auf HF ≥ ${targetHF} starten?`);
      if (!ok) { console.log('  Abgebrochen.'); break; }

      const result = await loop.deleverage(targetHF);
      console.log(`\n  Result: ${result.success ? '✓' : '✗'} – ${result.reason}`);
      await aave.printStatus();
      break;
    }

    // =====================================================================
    // UNWIND: Alle Positionen schließen
    // =====================================================================
    case 'unwind': {
      console.log('⚠️  WARNUNG: Dies schließt ALLE Aave-Positionen!');
      const snap = await aave.printStatus();

      if (snap.totalDebtUsd === 0 && snap.totalCollateralUsd === 0) {
        console.log('  Keine offenen Positionen.');
        break;
      }

      const ok = await confirm(rl, 'Wirklich ALLE Positionen schließen?');
      if (!ok) { console.log('  Abgebrochen.'); break; }
      const ok2 = await confirm(rl, 'Bist du sicher? Dies kann nicht rückgängig gemacht werden.');
      if (!ok2) { console.log('  Abgebrochen.'); break; }

      const result = await loop.fullUnwind();
      console.log(`\n  Result: ${result.success ? '✓' : '✗'} – ${result.reason}`);
      await aave.printStatus();
      break;
    }

    // =====================================================================
    // UNWIND-LOOP: Iterativer Abbau via withdraw sAVAX → swap → wrap → repay
    // =====================================================================
    case 'unwind-loop': {
      console.log('⚠️  WARNUNG: Dies baut den gesamten Leverage iterativ ab!');
      console.log('   Jede Iteration: withdraw sAVAX → swap sAVAX→AVAX → wrap AVAX→WAVAX → repay WAVAX');
      const snap = await aave.printStatus();

      if (snap.totalDebtUsd === 0 && snap.totalCollateralUsd === 0) {
        console.log('  Keine offenen Positionen.');
        break;
      }

      if (snap.totalDebtUsd === 0) {
        console.log(`  Kein Debt vorhanden. Collateral: $${snap.totalCollateralUsd.toFixed(2)}`);
        const okWithdraw = await confirm(rl, 'Verbleibendes Collateral (sAVAX) zurückziehen?');
        if (okWithdraw) {
          const withdrawHash = await aave.withdrawSAvax(2n ** 256n - 1n);
          console.log(`  ✓ Withdrawn: ${withdrawHash}`);
          await aave.printStatus();
        } else {
          console.log('  Abgebrochen.');
        }
        break;
      }

      const ok = await confirm(rl, 'Loop-Abbau starten? (iterativ, mit HF-Sicherheitscheck)');
      if (!ok) { console.log('  Abgebrochen.'); break; }

      const result = await loop.unwindLoop(rl, confirm);

      console.log('\n═══════════════════════════════════════════════');
      console.log('  UNWIND RESULT');
      console.log('═══════════════════════════════════════════════');
      console.log(`  Success:     ${result.success}`);
      console.log(`  Iterations:  ${result.iterations}`);
      console.log(`  HF:          ${result.finalSnapshot.healthFactor.toFixed(4)}`);
      console.log(`  Leverage:    ${result.finalSnapshot.leverage.toFixed(2)}x`);
      console.log(`  Collateral:  $${result.finalSnapshot.totalCollateralUsd.toFixed(2)}`);
      console.log(`  Debt:        $${result.finalSnapshot.totalDebtUsd.toFixed(2)}`);
      console.log(`  Txns:        ${result.txHashes.length}`);
      console.log(`  Reason:      ${result.reason}`);
      console.log('═══════════════════════════════════════════════');
      await aave.printStatus();
      break;
    }

    // =====================================================================
    // E-MODE: E-Mode aktivieren
    // =====================================================================
    case 'emode': {
      const eModeBefore = await aave.getUserEMode();
      console.log(`  E-Mode aktuell: ${eModeBefore === EMODE.categoryId ? `✓ Active (Cat. ${eModeBefore})` : `✗ Inactive (${eModeBefore})`}`);

      if (eModeBefore === EMODE.categoryId) {
        console.log('  E-Mode ist bereits aktiv.');
        break;
      }

      const ok = await confirm(rl, `E-Mode Kategorie ${EMODE.categoryId} aktivieren?`);
      if (!ok) { console.log('  Abgebrochen.'); break; }

      await aave.enableEMode();
      const eModeAfter = await aave.getUserEMode();
      console.log(`  E-Mode Status: ${eModeAfter === EMODE.categoryId ? '✓ Active' : '✗ Inactive'} (Category: ${eModeAfter})`);
      break;
    }

    // =====================================================================
    // WIZARD (Default ohne --action): Interaktiver Einstieg
    // =====================================================================
    case 'wizard': {
      console.log('');
      console.log('  Aktueller Status wird geladen...');
      await aave.printStatus();

      console.log('  Wähle eine Aktion:');
      console.log('  [1] status       – Account Status anzeigen');
      console.log('  [2] test         – Testmodus (ein Schritt)');
      console.log('  [3] emode        – E-Mode aktivieren');
      console.log('  [4] loop         – Leverage-Loop aufbauen');
      console.log('  [5] monitor      – HF-Monitor starten');
      console.log('  [6] deleverage   – Manuelles Deleverage');
      console.log('  [7] unwind       – Alle Positionen schließen (fullUnwind)');
      console.log('  [8] unwind-loop  – Loop iterativ abbauen (sAVAX→AVAX→repay)');
      console.log('');

      const choice = await ask(rl, '  Auswahl [1-8]: ');
      const actionMap: Record<string, string> = {
        '1': 'status', '2': 'test', '3': 'emode',
        '4': 'loop',   '5': 'monitor', '6': 'deleverage',
        '7': 'unwind', '8': 'unwind-loop',
      };
      const chosen = actionMap[choice];
      if (!chosen) {
        console.log('  Ungültige Auswahl.');
        break;
      }

      // Neustart mit gewählter Action (ohne Wizard)
      const { execFileSync } = await import('child_process');
      const isTsx = process.argv[1]?.endsWith('.ts') || process.execArgv.some(a => a.includes('tsx'));
      const args = [...process.argv.slice(1), `--action=${chosen}`, '--no-wizard'];
      if (isTsx) {
        const tsxBin = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
        execFileSync(tsxBin, args, { stdio: 'inherit', env: process.env });
      } else {
        execFileSync(process.execPath, args, { stdio: 'inherit', env: process.env });
      }
      break;
    }

    default:
      console.error(`  Unbekannte Action: ${action}`);
      console.log('  Verfügbare Actions:');
      console.log('    --action=status       Account Status');
      console.log('    --action=test         Testmodus (ein Schritt)');
      console.log('    --action=loop         Leverage aufbauen');
      console.log('    --action=monitor      HF Monitor (Daemon)');
      console.log('    --action=deleverage   Manuelles Deleverage');
      console.log('    --action=unwind       Alles schließen (fullUnwind)');
      console.log('    --action=unwind-loop  Loop iterativ abbauen (sAVAX→AVAX→repay)');
      console.log('    --action=emode        E-Mode aktivieren');
      process.exit(1);
  }

  rl.close();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
main().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
