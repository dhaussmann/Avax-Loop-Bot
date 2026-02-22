# sAVAX Loop Bot – Aave v3 Avalanche

Automatisierter Supply/Borrow-Loop für **sAVAX** auf **Aave v3 Avalanche** mit Health Factor Monitoring und Auto-Protection.

## Strategie

```
AVAX → sAVAX (BENQI Liquid Staking)
  → supply sAVAX als Collateral auf Aave v3
  → borrow WAVAX gegen sAVAX (E-Mode, 92.5% LTV)
  → unwrap WAVAX → AVAX
  → AVAX → sAVAX (BENQI)
  → supply sAVAX
  → repeat bis ~14x Leverage, HF ≈ 1.02
```

**Kern-Idee:** sAVAX und AVAX sind korrelierte Assets. Im E-Mode erlaubt Aave v3 bis zu 92.5% LTV, was theoretisch ~13.3x Leverage ermöglicht. Bei aggressiverer Nutzung (~14x) liegt der HF knapp über 1.

## Architektur

```
src/
├── config.ts       # Adressen, Parameter, Schwellwerte
├── abis.ts         # Minimale ABIs (Aave Pool, ERC20, sAVAX, WAVAX, Oracle)
├── aaveClient.ts   # Low-Level: supply, borrow, repay, withdraw, balances
├── riskEngine.ts   # HF-Formeln, Leverage-Berechnung, Deleverage-Math
├── loopEngine.ts   # Loop aufbauen & Deleverage orchestrieren
├── monitor.ts      # Periodische HF-Überwachung mit Auto-Protection
└── index.ts        # CLI Entry Point
```

## Verifizierte Contract-Adressen (Avalanche C-Chain Mainnet)

| Contract | Adresse |
|----------|---------|
| Aave v3 Pool | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| PoolAddressesProvider | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` |
| Aave Oracle | `0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C` |
| sAVAX (BENQI) | `0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE` |
| WAVAX | `0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7` |

## E-Mode Parameter (AVAX-korrelierte Assets)

| Parameter | Wert |
|-----------|------|
| LTV | 92.5% |
| Liquidation Threshold | 95% |
| Liquidation Bonus | 1% |
| Max theoretisches Leverage | ~13.33x |

## Setup

```bash
# 1. Dependencies installieren
npm install

# 2. Environment konfigurieren
cp .env.example .env
# → PRIVATE_KEY und optional AVAX_RPC_URL eintragen

# 3. TypeScript kompilieren (optional, tsx macht das auch)
npm run build
```

## Verwendung

```bash
# Account Status anzeigen
npm run status

# E-Mode aktivieren (Voraussetzung für hohe LTV)
npm run dev -- --action=emode

# Leverage-Loop aufbauen (VORSICHT!)
npm run loop

# HF Monitor starten (Daemon, Ctrl+C zum Beenden)
npm run monitor

# Manuelles Deleverage (Default: HF → 1.15)
npm run deleverage
# Mit spezifischem Ziel-HF:
npm run dev -- --action=deleverage --target-hf=1.5

# Komplett-Unwind (alle Positionen schließen)
npm run dev -- --action=unwind
```

## Konfiguration (.env)

| Variable | Default | Beschreibung |
|----------|---------|--------------|
| `PRIVATE_KEY` | – | EOA Private Key (0x-prefixed) |
| `AVAX_RPC_URL` | `https://api.avax.network/ext/bc/C/rpc` | Avalanche C-Chain RPC |
| `TARGET_LEVERAGE` | `14` | Ziel-Leverage |
| `TARGET_HF` | `1.02` | Ziel Health Factor |
| `MIN_HF_ACTION` | `1.05` | HF-Schwelle für auto Deleverage |
| `EMERGENCY_HF` | `1.01` | Emergency Deleverage Trigger |
| `MONITOR_INTERVAL_MS` | `30000` | Monitor-Intervall (ms) |
| `MAX_LOOP_ITERATIONS` | `50` | Max Loop-Iterationen |
| `SLIPPAGE_BPS` | `50` | Slippage Toleranz (Basis Points) |

## HF-Formeln

```
Health Factor = (Collateral_USD × Liquidation_Threshold) / Debt_USD

Leverage = Collateral / (Collateral - Debt)

Max Leverage = 1 / (1 - LTV)
  → E-Mode: 1 / (1 - 0.925) = 13.33x

Leverage bei Ziel-HF:
  L = 1 / (1 - LT/HF)
  → HF=1.02: 1 / (1 - 0.95/1.02) = ~14.6x
  → HF=1.05: 1 / (1 - 0.95/1.05) = ~10.5x
```

## ⚠️ RISIKEN

**Dieses Tool ist experimentell und für den Einsatz mit echtem Geld extrem riskant:**

1. **Liquidation:** Bei HF < 1 wird deine Position liquidiert. Bei 14x Leverage reicht ein ~5% Preisabweichung von sAVAX relativ zu AVAX für eine Liquidation.

2. **Smart Contract Risiko:** Bugs in Aave, BENQI oder diesem Bot können zu Totalverlust führen.

3. **Oracle Risiko:** Fehlerhafte Price-Feeds können falsche HF-Berechnungen verursachen.

4. **Slippage:** DEX-Swaps bei sAVAX → AVAX können unerwartete Slippage haben, besonders bei großen Beträgen oder niedriger Liquidität.

5. **Gas-Kosten:** Viele Transaktionen pro Loop-Iteration. Auf Avalanche moderat, aber summiert sich.

6. **Netzwerk-Ausfälle:** Wenn der Bot oder RPC ausfällt, kann er nicht deleveragen.

## TODO für Produktion

- [ ] **DEX-Swap Module:** LFJ (Trader Joe) / Pangolin Router für sAVAX ↔ AVAX Swaps mit Slippage-Protection
- [ ] **Flashloan-basierter Loop:** Gesamten Loop in einer Tx via Aave Flashloan
- [ ] **Gelato/Chainlink Automation:** On-chain Fallback-Trigger bei HF < Schwelle
- [ ] **Telegram/Discord Alerts:** Benachrichtigungen bei HF-Änderungen
- [ ] **Cloudflare Workers Deployment:** Für Scheduling passt zu deinem Stack
- [ ] **Circuit Breaker:** Automatischer Stop bei zu vielen Fehlern
- [ ] **Multi-Wallet Support:** Vault-Contracts statt EOA
- [ ] **Anvil Fork Testing:** Lokale Tests mit Avalanche-Fork

## Lizenz

Privat – Nutzung auf eigenes Risiko.
