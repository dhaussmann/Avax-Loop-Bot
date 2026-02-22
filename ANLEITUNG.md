# sAVAX Loop Bot – Ausführliche Anleitung

## Inhaltsverzeichnis
1. [Was ist der sAVAX Loop Bot?](#1-was-ist-der-savax-loop-bot)
2. [Voraussetzungen](#2-voraussetzungen)
3. [Installation & Konfiguration](#3-installation--konfiguration)
4. [Parameter-Erklärungen](#4-parameter-erklärungen)
5. [Aktionen im Detail](#5-aktionen-im-detail)
6. [Risiken & Sicherheitsmechanismen](#6-risiken--sicherheitsmechanismen)
7. [Häufige Fehlermeldungen](#7-häufige-fehlermeldungen)
8. [Technische Konzepte](#8-technische-konzepte)

---

## 1. Was ist der sAVAX Loop Bot?

Der Bot automatisiert eine **Leveraged-Staking-Strategie** auf Avalanche:

- **Ziel:** Durch wiederholtes Borgen und Staken von AVAX eine höhere sAVAX-Position aufbauen als mit eigenem Kapital allein möglich wäre.
- **Protokolle:** [Aave v3](https://aave.com) (Lend/Borrow) + [BENQI](https://benqi.fi) (Liquid Staking via sAVAX) + [KyberSwap](https://kyberswap.com) (DEX-Aggregator für Swaps)
- **Netzwerk:** Avalanche C-Chain (Mainnet)

### Grundprinzip

```
Eigenes AVAX
    ↓  swap via KyberSwap
  sAVAX  ──→  Supply auf Aave als Collateral
                    ↓
              Borrow WAVAX (bis ~93% LTV)
                    ↓
              Unwrap WAVAX → AVAX
                    ↓
              Swap AVAX → sAVAX (KyberSwap)
                    ↓
              Supply sAVAX als Collateral  ←── Schleife
```

Jede Iteration erhöht die sAVAX-Position (und damit die stETH-Staking-Erträge), aber auch die WAVAX-Schulden auf Aave.

---

## 2. Voraussetzungen

### Software
- **Node.js** v22 oder höher
- **npm** (kommt mit Node.js)

### Wallet
- Eine Avalanche-Wallet mit einem **Private Key** (Hex-Format: `0x...`)
- **Mindestkapital:** Empfohlen mind. 0.5 AVAX (je mehr, desto effizienter)
- **Gas-Reserve:** Mindestens 0.1 AVAX müssen immer in der Wallet bleiben (für Transaktionsgebühren)

> ⚠️ **Sicherheitshinweis:** Der Private Key wird in der `.env`-Datei gespeichert. Niemals committen, niemals teilen. Die `.env`-Datei ist in `.gitignore` eingetragen.

### Aave E-Mode
Der Bot nutzt den **E-Mode Kategorie 2 "AVAX correlated"** auf Aave v3:
- Erlaubt 93% LTV (statt normalerweise ~70%)
- Liquidation Threshold: 95%
- Nur sAVAX und WAVAX als Assets erlaubt

---

## 3. Installation & Konfiguration

### Installation

```bash
git clone <repo>
cd savax-loop-bot
npm install
```

### .env konfigurieren

Die Datei `.env` im Projektverzeichnis enthält alle einstellbaren Parameter:

```env
PRIVATE_KEY=0xDEINER_PRIVATE_KEY_HIER

TARGET_HF=1.02
MIN_HF_ACTION=1.01
TARGET_LEVERAGE=14
SLIPPAGE_BPS=50
MAX_LOOP_ITERATIONS=100
```

> Beim ersten Start ohne konfigurierten Key bietet der Bot an, automatisch eine neue Wallet zu generieren.

### Build

```bash
npm run build
```

### Start

```bash
# Interaktiver Wizard (empfohlen für Einsteiger)
npm start

# Oder direkt eine Aktion:
npm start -- --action=status
npm start -- --action=loop
npm run unwind    # = --action=unwind-loop
```

---

## 4. Parameter-Erklärungen

### TARGET_HF (Standard: 1.02)
Der angestrebte **Health Factor** nach jeder Loop-Iteration.

- **Was ist der Health Factor?**
  `HF = (Collateral_USD × LiquidationThreshold) / Debt_USD`
  HF > 1.0 = Position ist sicher. HF < 1.0 = Liquidation.

- **Warum 1.02?**
  Sehr nah an der Liquidationsgrenze → maximaler Leverage. Höheres Risiko bei Preisschwankungen.

- **Empfehlung für Einsteiger:** 1.05–1.10 (mehr Puffer)

### MIN_HF_ACTION (Standard: 1.01)
Schwellwert, bei dessen Unterschreitung der Monitor automatisch **deleveraged**.

> ⚠️ `MIN_HF_ACTION` sollte immer **kleiner** als `TARGET_HF` sein, sonst wird der Bot sofort nach dem Loopen wieder deleveragen.

### TARGET_LEVERAGE (Standard: 14)
Maximaler Hebel den der Bot aufbaut.

- Bei E-Mode LTV 93%: Theoretisches Maximum = `1 / (1 - 0.93) ≈ 14.3x`
- Bei HF 1.02 sind realistisch ~12–14x erreichbar.

### SLIPPAGE_BPS (Standard: 50)
Erlaubte Abweichung vom Quote-Preis bei KyberSwap-Swaps in Basispunkten.
- `50 bps = 0.5%`
- Zu niedrig → Swaps schlagen fehl (on-chain Revert)
- Zu hoch → schlechtere Ausführungspreise

### MAX_LOOP_ITERATIONS (Standard: 100)
Maximale Anzahl an Borrow→Stake→Supply Zyklen pro Loop-Aufruf. Sicherheitsbegrenzung.

### gasReserveAvax (fest: 0.1 AVAX)
Dieser AVAX-Betrag bleibt **immer** in der Wallet als Reserve für Transaktionsgebühren. Nicht konfigurierbar über `.env`.

---

## 5. Aktionen im Detail

### `--action=status`
Zeigt den aktuellen Account-Status ohne Transaktionen auszuführen:
- Health Factor, Leverage, Collateral, Debt
- Wallet-Balancen (AVAX, sAVAX, WAVAX)
- Risk-Assessment (was der Bot als nächstes tun würde)
- E-Mode Status

```bash
npm start -- --action=status
```

### `--action=test`
**Empfohlen für den ersten Start.** Führt genau einen Loop-Schritt manuell durch:
1. Kurs-Check (KyberSwap vs. Aave Oracle)
2. Beliebig viel AVAX → sAVAX tauschen (Betrag wählbar)
3. sAVAX auf Aave supplyen
4. WAVAX borgen (50% der verfügbaren Kapazität)

Alle Schritte werden einzeln bestätigt.

### `--action=loop`
Startet den **vollautomatischen Leverage-Aufbau**. Läuft bis:
- `TARGET_LEVERAGE` erreicht
- `TARGET_HF` unterschritten werden würde
- `MAX_LOOP_ITERATIONS` erreicht

Jede Iteration wird einzeln bestätigt (j/n).

### `--action=monitor`
Startet den **HF-Monitor als Hintergrundprozess**:
- Prüft alle 30 Sekunden (konfigurierbar) den Health Factor
- Bei HF < `MIN_HF_ACTION`: automatisches Deleverage
- Bei HF < `emergencyHF` (1.01): sofortiges Emergency-Deleverage
- Beenden mit `Ctrl+C`

### `--action=deleverage`
Manuelles Deleverage auf einen gewünschten Health Factor.
- Fragt nach Ziel-HF
- Zeigt Vorschau (wie viel sAVAX withdraw, wie viel WAVAX repay)
- Bestätigung nötig

### `--action=unwind-loop`
**Vollständiger Abbau der Leverage-Position** in Einzelschritten.

Jede Iteration:
1. Withdraw sAVAX aus Aave
2. Swap sAVAX → AVAX (KyberSwap)
3. Wrap AVAX → WAVAX
4. Repay WAVAX an Aave

Endzustand: Kein Debt, gesamtes sAVAX in Wallet.

```bash
npm run unwind
# oder
npm start -- --action=unwind-loop
```

### `--action=emode`
Aktiviert E-Mode Kategorie 2 ("AVAX correlated") falls noch nicht aktiv.

---

## 6. Risiken & Sicherheitsmechanismen

### Liquidationsrisiko
Wenn der AVAX-Preis fällt oder sAVAX/AVAX Spread sich ausweitet, kann der HF unter 1.0 fallen → Liquidation durch Dritte.

**Schutzmechanismen:**
- `MIN_HF_ACTION`: Automatisches Deleverage beim Monitor
- `TARGET_HF`: Borrow-Berechnung lässt immer Puffer
- Gas-Reserve: Wallet immer handlungsfähig

### Slippage-Risiko
Bei großen Positionen oder illiquiden Märkten kann der tatsächliche Swap-Preis vom Quote abweichen.

**Schutzmechanismen:**
- `SLIPPAGE_BPS` begrenzt maximale Abweichung
- Kurs-Check vor dem Loop vergleicht KyberSwap mit Aave Oracle (Warnung bei >1% Abweichung)
- Automatischer Retry bei Swap-Fehlern (bis zu 3×)

### Smart Contract Risiko
Aave v3, BENQI und KyberSwap sind geprüfte Protokolle, aber kein Smart Contract ist 100% sicher.

### Dexalot-Ausschluss
Dexalot wird als Swap-Quelle ausgeschlossen, da RFQ-Quotes zwischen Anfrage und Ausführung ablaufen können.

---

## 7. Häufige Fehlermeldungen

| Fehler | Bedeutung | Lösung |
|--------|-----------|--------|
| `NotBorrowableInEMode (0x57db5bba)` | Falscher E-Mode oder falsches Asset | E-Mode muss Kategorie 2 sein |
| `InvalidAmount (0x2c5211c6)` | Betrag = 0 übergeben | Prüfe ob ausreichend Balance vorhanden |
| `NotEnoughAvailableUserBalance (0x47bc4b2c)` | Mehr withdraw als in Aave liegt | Clamp-Logik greift automatisch |
| `KyberSwap Route API Fehler: 400` | Ungültiger Betrag (oft 0) | Balance-Diff-Prüfung vor dem Swap |
| `Swap revertiert` | Slippage überschritten | Erhöhe `SLIPPAGE_BPS` in `.env` |
| `Kein Withdraw möglich ohne Liquidation` | HF zu niedrig | Bot nutzt Wallet-AVAX für direkten Repay |

---

## 8. Technische Konzepte

### E-Mode (Efficiency Mode)
Aave v3 erlaubt höhere LTVs für korrelierte Asset-Paare. Im AVAX-E-Mode (Kategorie 2) kann sAVAX als Collateral für WAVAX-Schulden mit 93% LTV genutzt werden (normalerweise ~70%).

### sAVAX/AVAX Ratio
sAVAX ist AVAX das bei BENQI gestaked ist und Staking-Rewards akkumuliert. Dadurch ist 1 sAVAX immer > 1 AVAX (typisch ~1.07–1.10 AVAX). Dieser Ratio ist wichtig für die Berechnungen.

### Health Factor Formel
```
HF = (Σ Collateral_i × LiquidationThreshold_i) / Σ Debt_i
   = (sAVAX_USD × 0.95) / WAVAX_USD
```

### Leverage Formel
```
Leverage = Collateral / (Collateral - Debt) = Collateral / Equity
```

### aToken (asAVAX)
Wenn sAVAX auf Aave supplyed wird, erhält man **asAVAX** (Aave Interest Bearing Token). Die asAVAX-Balance repräsentiert die tatsächliche Collateral-Position inkl. aufgelaufener Zinsen.
Adresse: `0x513c7E3a9c69cA3e22550eF58AC1C0088e918FFf`
