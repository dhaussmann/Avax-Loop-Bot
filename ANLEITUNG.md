# sAVAX Loop Bot – Setup & Anleitung (macOS)

## Inhaltsverzeichnis
1. [Was macht der Bot?](#1-was-macht-der-bot)
2. [Voraussetzungen installieren](#2-voraussetzungen-installieren)
3. [Bot einrichten](#3-bot-einrichten)
4. [Wallet einrichten (erster Start)](#4-wallet-einrichten-erster-start)
5. [Konfiguration (.env)](#5-konfiguration-env)
6. [Bedienung](#6-bedienung)
7. [Parameter-Erklärungen](#7-parameter-erklärungen)
8. [Risiken & Sicherheit](#8-risiken--sicherheit)
9. [Häufige Fehler](#9-häufige-fehler)

---

## 1. Was macht der Bot?

Der Bot automatisiert eine **Leveraged-Staking-Strategie** auf Avalanche:

**Ziel:** Durch wiederholtes Borgen und Staken von AVAX eine größere sAVAX-Position aufbauen als mit eigenem Kapital allein möglich – und damit mehr Staking-Erträge erzielen.

**Loop-Ablauf (pro Iteration):**
```
AVAX in Wallet
  ↓  Swap AVAX → sAVAX (KyberSwap)
sAVAX als Collateral auf Aave supplyen
  ↓
WAVAX borgen (bis zu 93% LTV in E-Mode)
  ↓
Swap WAVAX → sAVAX (KyberSwap, kein Unwrap nötig)
  ↓
sAVAX wieder auf Aave supplyen  ←── wiederholen
```

**Verwendete Protokolle:**
- [Aave v3 Avalanche](https://aave.com) – Lend/Borrow (E-Mode Kategorie 2: AVAX correlated)
- [BENQI](https://benqi.fi) – Liquid Staking (sAVAX)
- [KyberSwap](https://kyberswap.com) – DEX-Aggregator für Swaps

**Maximaler Hebel:** ~14x (bei E-Mode LTV 93%)

---

## 2. Voraussetzungen installieren

Ausgehend von einem frischen Mac ohne installierte Tools.

### 2.1 Homebrew installieren

Homebrew ist der Paketmanager für macOS. Terminal öffnen (`Cmd+Space` → "Terminal"):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Anweisungen im Terminal folgen. Am Ende ggf. Homebrew zum PATH hinzufügen – der Installer zeigt die genauen Befehle an (bei Apple Silicon):

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Prüfen:
```bash
brew --version
```

### 2.2 Node.js installieren

```bash
brew install node
```

Prüfen (muss v22 oder höher sein):
```bash
node --version   # z.B. v22.x.x
npm --version    # z.B. 10.x.x
```

### 2.3 Git installieren

Git kommt bei macOS meistens vorinstalliert. Falls nicht:

```bash
brew install git
```

Prüfen:
```bash
git --version
```

---

## 3. Bot einrichten

### 3.1 Repository klonen

```bash
git clone <repo-url>
cd savax-loop-bot
```

### 3.2 Abhängigkeiten installieren

```bash
npm install
```

### 3.3 Projekt bauen

```bash
npm run build
```

> Beim nächsten Start nach Code-Änderungen immer wieder `npm run build` ausführen.

---

## 4. Wallet einrichten (erster Start)

Der Bot speichert den Private Key **niemals im Klartext**. Stattdessen wird er mit AES-256-GCM verschlüsselt in `wallet.enc` gespeichert.

### Erster Start

```bash
npm start
```

Beim ersten Start ohne `wallet.enc` startet automatisch ein Setup-Wizard:

```
  ╔═══════════════════════════════════════╗
  ║    WALLET SETUP – Erster Start        ║
  ╚═══════════════════════════════════════╝
  Kein verschlüsseltes Wallet gefunden.

  [1] Bestehenden Private Key importieren (0x...)
  [2] Neues Wallet generieren
```

**Option [1] – Private Key importieren (empfohlen wenn du eine Wallet hast):**
- Den Private Key der Avalanche-Wallet eingeben (Format: `0x` gefolgt von 64 Hex-Zeichen)
- Ein sicheres Passwort vergeben (min. 8 Zeichen)
- `wallet.enc` wird erstellt

**Option [2] – Neues Wallet generieren:**
- Bot generiert einen neuen Private Key
- Die angezeigte Adresse und den Private Key **sofort sichern** (z.B. in Passwort-Manager)
- Passwort vergeben → `wallet.enc` wird erstellt

### Spätere Starts

```bash
npm start
```

```
  Wallet gefunden – bitte Passwort eingeben:
  Wallet-Passwort: ████████
```

Passwort eingeben → Bot startet das Hauptmenü.

### Sicherheitshinweise

- `wallet.enc` und `.env` sind in `.gitignore` — werden **nicht** in Git committed
- Passwort gut merken/notieren — es gibt keine Passwort-Wiederherstellung
- `wallet.enc` regelmäßig sichern (z.B. auf verschlüsseltem USB-Stick)
- Mindestens **0.1 AVAX** für Transaktionsgebühren immer in der Wallet lassen

---

## 5. Konfiguration (.env)

Im Projektverzeichnis eine Datei `.env` anlegen (Vorlage: `.env.example`):

```bash
cp .env.example .env
```

Dann mit einem Texteditor öffnen und anpassen:

```env
# RPC-Endpunkt (Standard: öffentlicher Avalanche-RPC)
AVAX_RPC_URL=https://api.avax.network/ext/bc/C/rpc

# Bot-Parameter (alle optional – Defaults in config.ts)
TARGET_LEVERAGE=14
TARGET_HF=1.02
MIN_HF_ACTION=1.01
SLIPPAGE_BPS=50
MAX_LOOP_ITERATIONS=100
```

> Die `.env`-Datei wird automatisch beim Start geladen. Kein `export` oder Shell-Neustart nötig.

**Empfehlung für Einsteiger:** Mit `TARGET_HF=1.10` und `TARGET_LEVERAGE=5` starten – weniger Risiko zum Testen.

---

## 6. Bedienung

### 6.1 Starten

```bash
npm start
```

Zeigt das interaktive Hauptmenü:

```
╔═════════════════════════════════════╗
║        sAVAX Loop Bot               ║
╚═════════════════════════════════════╝
  Adresse: 0x...
  AVAX:    x.xx
  sAVAX:   x.xx
  WAVAX:   x.xx

  [1] Status anzeigen
  [2] E-Mode aktivieren
  [3] Parameter bearbeiten
  [4] Loop starten (Leverage aufbauen)
  [5] Monitor starten
  [6] Deleverage
  [7] Unwind (vollständig schließen)
  [q] Beenden
```

### 6.2 Empfohlene Reihenfolge beim ersten Mal

**Schritt 1: Status prüfen**
```
→ [1] Status anzeigen
```
Zeigt HF, Leverage, Balancen und was der Bot als nächstes tun würde.

**Schritt 2: E-Mode aktivieren**
```
→ [2] E-Mode aktivieren
```
Muss einmalig durchgeführt werden. Ohne E-Mode ist der maximale LTV nur ~70%.

**Schritt 3: AVAX in Wallet sicherstellen**
Mindestens 0.5 AVAX empfohlen (mehr = effizienter). 0.1 AVAX werden als Gas-Reserve behalten.

**Schritt 4: Loop starten**
```
→ [4] Loop starten
```
Der Bot fragt vor jeder Iteration nach Bestätigung:
- `j` – diese Iteration durchführen
- `n` – abbrechen
- `a` – alle weiteren Iterationen automatisch bestätigen (kein weiteres Nachfragen)

**Schritt 5: Monitor starten (optional)**
```
→ [5] Monitor starten
```
Überwacht den HF im Hintergrund und deleveragt automatisch wenn der HF unter `MIN_HF_ACTION` fällt.

### 6.3 Position abbauen

**Teilweise (Deleverage auf Ziel-HF):**
```
→ [6] Deleverage
```

**Vollständig (alle Schulden zurückzahlen, sAVAX in Wallet):**
```
→ [7] Unwind
```

### 6.4 Direkte Befehle (ohne Menü)

```bash
npm start -- --action=status       # Nur Status anzeigen
npm start -- --action=loop         # Loop direkt starten
npm start -- --action=monitor      # Nur Monitor starten
npm start -- --action=unwind-loop  # Direkt unwind starten
```

---

## 7. Parameter-Erklärungen

### TARGET_HF (Standard: 1.02)

Der angestrebte **Health Factor** nach dem Loopen.

```
HF = (Collateral_USD × LiquidationThreshold) / Debt_USD
```

- HF > 1.0 = Position sicher
- HF = 1.0 = Liquidation
- HF = 1.02 → 2% Puffer über Liquidationsgrenze → maximaler Leverage, aber riskant
- **Empfehlung Einsteiger:** 1.05–1.10

### MIN_HF_ACTION (Standard: 1.01)

Ab diesem HF greift der Monitor ein und deleveragt automatisch.

> `MIN_HF_ACTION` muss **kleiner** als `TARGET_HF` sein, sonst deleveragt der Bot direkt nach dem Loopen.

### TARGET_LEVERAGE (Standard: 14)

Maximaler Hebel. Bei E-Mode LTV 93%: theoretisches Maximum = `1 / (1 - 0.93) ≈ 14.3x`.

**Empfehlung Einsteiger:** 5–8x

### SLIPPAGE_BPS (Standard: 50)

Maximale Preisabweichung beim Swap in Basispunkten. `50 bps = 0.5%`.

- Zu niedrig (< 30) → Swaps schlagen häufig fehl
- Zu hoch (> 200) → schlechtere Ausführungspreise

### MAX_LOOP_ITERATIONS (Standard: 100)

Sicherheitsbegrenzung: Maximale Anzahl Borrow→Swap→Supply Zyklen pro Loop-Aufruf.

---

## 8. Risiken & Sicherheit

### Liquidationsrisiko

Bei starkem AVAX-Kursrückgang oder Ausweitung des sAVAX/AVAX-Spreads kann der HF unter 1.0 fallen → Liquidation durch Dritte (10% Penalty).

**Schutzmechanismen des Bots:**
- Monitor mit automatischem Deleverage bei HF < `MIN_HF_ACTION`
- Emergency-Deleverage bei HF < `EMERGENCY_HF` (1.01)
- Gas-Reserve: 0.1 AVAX immer in der Wallet

### Slippage-Risiko

Bei großen Positionen oder illiquiden Märkten weicht der Ausführungspreis vom Quote ab.

**Schutzmechanismen:**
- `SLIPPAGE_BPS` begrenzt maximale Abweichung
- Bis zu 3 automatische Swap-Wiederholungen
- Nach 3 Fehlversuchen: Rückfrage ob weiter versucht werden soll

### Smart Contract Risiko

Aave v3, BENQI und KyberSwap sind geprüfte Protokolle, aber kein Smart Contract ist 100% ausfallsicher.

### Empfehlungen

- Erst mit kleinen Beträgen testen (0.5–1 AVAX)
- Monitor immer aktiv lassen wenn Position offen ist
- `wallet.enc` sichern

---

## 9. Häufige Fehler

| Fehler | Bedeutung | Lösung |
|--------|-----------|--------|
| `Swap revertiert` | Slippage überschritten | `SLIPPAGE_BPS` in `.env` erhöhen (z.B. auf 100) |
| `Borrow-Menge zu klein` | Kein weiterer Borrow sinnvoll | Loop hat Ziel bereits erreicht – normal |
| `NotBorrowableInEMode` | E-Mode nicht aktiv | Menüpunkt [2] E-Mode aktivieren |
| `Wallet-Passwort falsch` | Falsches Passwort eingegeben | Nochmals versuchen – case-sensitive |
| `AVAX Balance zu niedrig` | Weniger als 0.1 AVAX in Wallet | AVAX zur Wallet hinzufügen |
| `KyberSwap 400 Fehler` | Swap-Betrag zu klein | Mehr AVAX in Wallet bereitstellen |
| `TransactionReceiptNotFoundError` | RPC-Latenz | Bot wiederholt automatisch (bis 12×) |
