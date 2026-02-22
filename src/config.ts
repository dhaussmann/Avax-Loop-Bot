// ============================================================================
// config.ts – Zentrale Konfiguration für den sAVAX Loop Bot
// ============================================================================
// Alle Adressen verifiziert gegen:
// - Aave v3 Avalanche Docs: https://docs.aave.com/developers/deployed-contracts/v3-mainnet/avalanche
// - BENQI Docs: https://docs.benqi.fi/resources/contracts
// - Snowtrace: https://snowtrace.io
// ============================================================================

import { avalanche } from 'viem/chains';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

// ---------------------------------------------------------------------------
// .env laden (falls vorhanden) – vor allen anderen process.env Zugriffen
// ---------------------------------------------------------------------------
(function loadDotEnv() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const envPath = join(dir, '..', '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Nur setzen wenn nicht bereits von außen gesetzt (Shell-Variable hat Vorrang)
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
})();

// ---------------------------------------------------------------------------
// Contract Addresses (Avalanche C-Chain, Mainnet)
// ---------------------------------------------------------------------------
export const ADDRESSES = {
  // Aave v3 Core
  pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as const,             // Aave v3 Pool Proxy
  poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb' as const, // PoolAddressesProvider
  aaveOracle: '0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C' as const,       // Aave v3 Price Oracle

  // Tokens
  sAVAX: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE' as const,           // BENQI Staked AVAX
  WAVAX: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7' as const,           // Wrapped AVAX
  aSAVAX: '0x513c7E3a9c69cA3e22550eF58AC1C0088e918FFf' as const,          // Aave aToken: asAVAX (Collateral-Receipt, on-chain verifiziert)
  
  // BENQI Liquid Staking (für AVAX → sAVAX Staking)
  benqiStaking: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE' as const,    // sAVAX contract = staking contract

  // DEX – LFJ (Trader Joe) V2.1 Router auf Avalanche
  lfjRouter: '0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30' as const,       // LB Router v2.1

  // Aave V3 WrappedTokenGateway – repay mit nativem AVAX (kein WAVAX-Wrap nötig)
  wrappedTokenGateway: '0x2825cE5921538d17cc15Ae00a8B24fF759C6CDaE' as const, // WETH_GATEWAY Avalanche Mainnet
} as const;

// ---------------------------------------------------------------------------
// E-Mode Konfiguration (AVAX-korrelierte Assets)
// ---------------------------------------------------------------------------
export const EMODE = {
  categoryId: 2,                    // AVAX-korrelierte Assets E-Mode Kategorie (2 = "AVAX correlated")
  ltv: 0.93,                        // 93% LTV in E-Mode (on-chain verifiziert)
  liquidationThreshold: 0.95,       // 95% Liquidation Threshold in E-Mode
  liquidationBonus: 0.01,           // 1% Liquidation Bonus
  // Max theoretisches Leverage: 1 / (1 - 0.93) = ~14.28x
  // Praxis bei HF ~1.02: effektiv ~12-14x je nach Preisratio sAVAX/AVAX
} as const;

// ---------------------------------------------------------------------------
// Bot-Parameter
// ---------------------------------------------------------------------------
export const CONFIG: {
  chainId: number;
  rpcUrl: string;
  privateKey: `0x${string}`;
  targetLeverage: number;
  targetHF: number;
  minHFForAction: number;
  emergencyHF: number;
  maxIterations: number;
  slippageBps: number;
  monitorIntervalMs: number;
  maxGasPriceGwei: bigint;
  gasLimitMultiplier: number;
  gasReserveAvax: string;
} = {
  chainId: avalanche.id,            // 43114
  rpcUrl: process.env.AVAX_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc',
  privateKey: '' as `0x${string}`,  // wird nach Passwort-Eingabe gesetzt (keystore)

  // Leverage-Ziele
  targetLeverage: Number(process.env.TARGET_LEVERAGE) || 14,
  targetHF: Number(process.env.TARGET_HF) || 1.02,           // Angestrebter Health Factor
  minHFForAction: Number(process.env.MIN_HF_ACTION) || 1.05, // Bei Unterschreiten → Deleverage
  emergencyHF: Number(process.env.EMERGENCY_HF) || 1.01,     // Notfall → sofort max Deleverage

  // Loop-Limits
  maxIterations: Number(process.env.MAX_LOOP_ITERATIONS) || 50,
  
  // Swap-Parameter
  slippageBps: Number(process.env.SLIPPAGE_BPS) || 50,       // 0.5% Default Slippage
  
  // Monitor
  monitorIntervalMs: Number(process.env.MONITOR_INTERVAL_MS) || 30_000,

  // Gas
  maxGasPriceGwei: 100n,                                     // Max Gas Price in Gwei
  gasLimitMultiplier: 1.2,                                    // 20% Buffer auf estimated Gas

  // Mindest-AVAX-Reserve die IMMER in der Wallet bleiben muss (für Gas)
  gasReserveAvax: '0.1',                                     // 0.1 AVAX ≈ 3-5 Txn-Gebühren auf Avalanche
};

// ---------------------------------------------------------------------------
// Logging Helper
// ---------------------------------------------------------------------------
export function logConfig() {
  console.log('═══════════════════════════════════════════════');
  console.log('  sAVAX Loop Bot – Konfiguration');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Chain:            Avalanche C-Chain (${CONFIG.chainId})`);
  console.log(`  RPC:              ${CONFIG.rpcUrl}`);
  console.log(`  Target Leverage:  ${CONFIG.targetLeverage}x`);
  console.log(`  Target HF:        ${CONFIG.targetHF}`);
  console.log(`  Min HF Action:    ${CONFIG.minHFForAction}`);
  console.log(`  Emergency HF:     ${CONFIG.emergencyHF}`);
  console.log(`  Max Iterations:   ${CONFIG.maxIterations}`);
  console.log(`  Slippage:         ${CONFIG.slippageBps} bps`);
  console.log(`  E-Mode LTV:       ${EMODE.ltv * 100}%`);
  console.log(`  E-Mode Liq.Thr.:  ${EMODE.liquidationThreshold * 100}%`);
  console.log('═══════════════════════════════════════════════');
}
