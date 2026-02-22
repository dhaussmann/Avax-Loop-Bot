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
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AaveClient } from './aaveClient.js';
import { RiskEngine } from './riskEngine.js';
import { LoopEngine } from './loopEngine.js';
import { Monitor } from './monitor.js';
import { CONFIG, EMODE, logConfig } from './config.js';
import { keystoreExists, createKeystore, loadKeystore, promptPassword } from './keystore.js';
import { saveSessionLog, printSessionSummary } from './logger.js';

const KEYSTORE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'wallet.enc');

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

// autoApprove-Flag: wird gesetzt wenn User "a" wählt → alle weiteren confirms automatisch true
let autoApprove = false;

async function confirm(rl: readline.Interface, message: string): Promise<boolean> {
  if (autoApprove) return true;
  while (true) {
    const answer = await ask(rl, `\n  ${message} [j/n/a]: `);
    const lower = answer.toLowerCase();
    if (lower === 'j' || lower === 'ja') return true;
    if (lower === 'n' || lower === 'nein') return false;
    if (lower === 'a' || lower === 'alle') {
      autoApprove = true;
      console.log('  → Alle weiteren Schritte werden automatisch bestätigt.');
      return true;
    }
    console.log('  Bitte "j", "n" oder "a" (alle) eingeben.');
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
// Main
// ---------------------------------------------------------------------------
async function main() {
  // ── Wallet-Auswahl via Keystore ───────────────────────────────────────────
  if (keystoreExists(KEYSTORE_PATH)) {
    // Keystore vorhanden → Passwort abfragen und entschlüsseln
    console.log('');
    console.log('  ┌─── Encrypted Keystore gefunden ─────────────────────────┐');
    console.log(`  │  Datei: ${KEYSTORE_PATH}`);
    console.log('  └─────────────────────────────────────────────────────────┘');
    console.log('');

    let privateKey: string;
    try {
      const password = await promptPassword('  Wallet-Passwort: ', false);
      console.log('');
      process.stdout.write('  Entschlüssele Keystore...');
      privateKey = loadKeystore(password, KEYSTORE_PATH);
      console.log(' ✓');
    } catch (err) {
      console.log('');
      console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    CONFIG.privateKey = privateKey as `0x${string}`;
    const account = privateKeyToAccount(CONFIG.privateKey);
    console.log(`  Wallet: ${account.address}`);
    console.log('');

  } else {
    // Kein Keystore → Setup-Wizard
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║       ERSTER START – WALLET SETUP                        ║');
    console.log('║  Kein Keystore gefunden. Bitte wählen:                   ║');
    console.log('║    [1] Bestehenden Private Key verschlüsseln             ║');
    console.log('║    [2] Neue Wallet generieren                            ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');

    // Einfache Zeilen-Eingabe über Raw-Mode (kompatibel mit promptPassword)
    const readLine = (prompt: string): Promise<string> => new Promise(resolve => {
      process.stdout.write(prompt);
      const stdin = process.stdin;
      const wasPaused = stdin.isPaused();
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      let buf = '';
      const onData = (chunk: string) => {
        for (const char of chunk) {
          const code = char.charCodeAt(0);
          if (char === '\r' || char === '\n' || code === 13 || code === 10) {
            stdin.removeListener('data', onData);
            if (stdin.isTTY) stdin.setRawMode(false);
            if (wasPaused) stdin.pause();
            process.stdout.write('\n');
            resolve(buf);
            return;
          }
          if (code === 3) { process.stdout.write('\n'); process.exit(130); }
          if (code === 127 || code === 8) {
            if (buf.length > 0) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
          } else if (code >= 32) {
            buf += char; process.stdout.write(char);
          }
        }
      };
      stdin.on('data', onData);
    });

    const choice = await readLine('  Auswahl [1/2]: ');

    let privateKey: string;

    if (choice === '1') {
      // Bestehenden Key eingeben (sichtbar, da kein Sicherheitsrisiko beim Eintippen in eigenem Terminal)
      privateKey = await readLine('  Private Key (0x...): ');
      if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
        console.error('  ✗ Ungültiger Private Key (muss 0x + 64 Hex-Zeichen sein).');
        process.exit(1);
      }
    } else {
      // Neue Wallet generieren
      privateKey = generatePrivateKey();
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      console.log('');
      console.log('╔═══════════════════════════════════════════════════════════╗');
      console.log('║           NEUE WALLET GENERIERT                          ║');
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log(`║  Adresse:     ${account.address}  ║`);
      console.log(`║  Private Key: ${privateKey}  ║`);
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log('║  ⚠️  Notiere den Private Key jetzt – er wird danach      ║');
      console.log('║      nur noch verschlüsselt gespeichert!                 ║');
      console.log('╚═══════════════════════════════════════════════════════════╝');
      console.log('');
    }

    // Passwort für Keystore wählen
    console.log('  Wähle ein Passwort für den Keystore (mind. 8 Zeichen):');
    let password: string;
    try {
      password = await promptPassword('  Passwort: ', true);
    } catch (err) {
      console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // Keystore erstellen
    process.stdout.write('  Erstelle Keystore (scrypt KDF – dauert ~1s)...');
    createKeystore(privateKey, password, KEYSTORE_PATH);
    console.log(' ✓');
    console.log(`  Keystore gespeichert: ${KEYSTORE_PATH}`);
    console.log('');
    console.log('  Hinweis: PRIVATE_KEY in .env wird nicht mehr benötigt.');
    console.log('           Du kannst ihn aus .env entfernen.');
    console.log('');

    CONFIG.privateKey = privateKey as `0x${string}`;
    const account = privateKeyToAccount(CONFIG.privateKey);
    console.log(`  Wallet: ${account.address}`);
    console.log('');
  }

  // ── Readline Interface ────────────────────────────────────────────────────
  const rl = createRL();

  // ── Parameter-Wizard (einmalig bei Direktaufruf ohne --action) ───────────
  const initialAction = getAction();
  if (!hasFlag('--no-wizard') && initialAction === 'wizard') {
    await runParameterWizard(rl);
  }

  logConfig();

  // ── Initialisierung ───────────────────────────────────────────────────────
  const aave = new AaveClient();
  const risk = new RiskEngine();
  const loop = new LoopEngine(aave, risk);
  const monitor = new Monitor(aave, risk, loop);

  console.log(`  Wallet: ${aave.userAddress}`);

  // ── Aktions-Schleife ──────────────────────────────────────────────────────
  // Bei direktem --action=X wird nur diese eine Aktion ausgeführt, dann Ende.
  // Im Wizard-Modus (kein --action) läuft die Schleife bis [0] Beenden.
  const isWizardMode = initialAction === 'wizard';

  const runAction = async (action: string): Promise<void> => {
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
      console.log('║           TESTMODUS – EIN LOOP-SCHRITT                    ║');
      console.log('║  Führt genau eine Iteration aus:                          ║');
      console.log('║    1. Kurs-Check AVAX → sAVAX                             ║');
      console.log('║    2. AVAX → sAVAX tauschen (BENQI)                       ║');
      console.log('║    3. sAVAX als Collateral auf Aave supplyen              ║');
      console.log('║    4. WAVAX gegen sAVAX borgen                            ║');
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
      const { sAvaxReceived } = await aave.swapAvaxForSAvax(
        testAmount,
        async () => confirm(rl, 'Swap nach 3 Versuchen fehlgeschlagen. Nochmals versuchen?'),
      );

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
      printSessionSummary(result);
      saveSessionLog(result);
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
    case 'unwind':
    case 'unwind-loop': {
      console.log('⚠️  WARNUNG: Dies schließt ALLE Aave-Positionen!');
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

      const ok = await confirm(rl, 'Wirklich ALLE Positionen schließen?');
      if (!ok) { console.log('  Abgebrochen.'); break; }
      const ok2 = await confirm(rl, 'Bist du sicher? Dies kann nicht rückgängig gemacht werden.');
      if (!ok2) { console.log('  Abgebrochen.'); break; }

      const result = await loop.unwindLoop(rl, confirm);
      printSessionSummary(result);
      saveSessionLog(result);
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
  }; // Ende runAction

  if (isWizardMode) {
    // ── Interaktive Hauptschleife ─────────────────────────────────────────
    const actionMap: Record<string, string> = {
      '1': 'status', '2': 'test', '3': 'emode',
      '4': 'loop',   '5': 'monitor', '6': 'deleverage',
      '7': 'unwind', '8': 'unwind-loop',
    };

    while (true) {
      console.log('');
      console.log('┌─────────────────────────────────────────────────────────────┐');
      console.log('│  Wähle eine Aktion:                                         │');
      console.log('│  [1] status       – Account Status anzeigen                 │');
      console.log('│  [2] test         – Testmodus (ein Schritt)                 │');
      console.log('│  [3] emode        – E-Mode aktivieren                       │');
      console.log('│  [4] loop         – Leverage-Loop aufbauen                  │');
      console.log('│  [5] monitor      – HF-Monitor starten                      │');
      console.log('│  [6] deleverage   – Manuelles Deleverage                    │');
      console.log('│  [7] unwind       – Alle Positionen schließen (fullUnwind)  │');
      console.log('│  [8] unwind-loop  – Loop iterativ abbauen                   │');
      console.log('│  [0] Beenden                                                 │');
      console.log('└─────────────────────────────────────────────────────────────┘');

      const choice = await ask(rl, '  Auswahl [0-8]: ');

      if (choice === '0') {
        console.log('  Auf Wiedersehen!');
        break;
      }

      const chosen = actionMap[choice];
      if (!chosen) {
        console.log('  Ungültige Auswahl – bitte 0-8 eingeben.');
        continue;
      }

      console.log('');
      await runAction(chosen);
      autoApprove = false; // Reset nach jeder Aktion
      // monitor endet nie über die Schleife (SIGINT handled intern)
    }
  } else {
    // ── Direkt-Aufruf via --action=X ─────────────────────────────────────
    console.log(`\n  Action: ${initialAction}\n`);
    await runAction(initialAction);
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
