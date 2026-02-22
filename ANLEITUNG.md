# sAVAX Loop Bot – Setup & Anleitung

## Inhaltsverzeichnis
1. [Was macht der Bot?](#1-was-macht-der-bot)
2. [Voraussetzungen installieren – macOS](#2-voraussetzungen-installieren--macos)
3. [Voraussetzungen installieren – Windows](#3-voraussetzungen-installieren--windows)
4. [Bot einrichten](#4-bot-einrichten)
5. [Wallet einrichten (erster Start)](#5-wallet-einrichten-erster-start)
6. [Konfiguration (.env)](#6-konfiguration-env)
7. [Bedienung](#7-bedienung)
8. [Transaction Log / Quittungen](#8-transaction-log--quittungen)
9. [Parameter-Erklärungen](#9-parameter-erklärungen)
10. [Risiken & Sicherheit](#10-risiken--sicherheit)
11. [Häufige Fehler](#11-häufige-fehler)

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

## 2. Voraussetzungen installieren – macOS

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

Weiter mit [Abschnitt 4 – Bot einrichten](#4-bot-einrichten).

---

## 3. Voraussetzungen installieren – Windows

Ausgehend von einem frischen Windows-PC (Windows 10 oder 11) ohne installierte Tools.

> **Empfehlung:** Alle Befehle in **Windows Terminal** oder **PowerShell** ausführen (nicht die alte CMD). Windows Terminal kann aus dem Microsoft Store installiert werden.

### 3.1 Node.js installieren

Node.js direkt von der offiziellen Website herunterladen:

1. [nodejs.org](https://nodejs.org) öffnen
2. **"LTS"**-Version herunterladen (aktuell v22.x)
3. Installer ausführen – alle Standardoptionen belassen
4. **Wichtig:** Den Haken bei _"Automatically install the necessary tools"_ setzen (installiert auch Build-Tools)

Nach der Installation PowerShell neu öffnen und prüfen:
```powershell
node --version   # z.B. v22.x.x
npm --version    # z.B. 10.x.x
```

### 3.2 Git installieren

1. [git-scm.com/download/win](https://git-scm.com/download/win) öffnen
2. Installer herunterladen und ausführen
3. Standardoptionen belassen – bei "Default editor" kann VS Code gewählt werden falls vorhanden
4. Bei "Adjusting your PATH environment": **"Git from the command line and also from 3rd-party software"** wählen

Nach der Installation PowerShell neu öffnen und prüfen:
```powershell
git --version
```

### 3.3 Ausführungsrichtlinie für PowerShell anpassen

Damit `npm`-Skripte in PowerShell ausgeführt werden können, muss die Ausführungsrichtlinie einmalig angepasst werden. PowerShell **als Administrator** öffnen (Rechtsklick → "Als Administrator ausführen"):

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Bestätigen mit `J` (Ja).

### 3.4 Zeilenenden konfigurieren (wichtig!)

Git unter Windows wandelt Zeilenenden automatisch um, was zu Problemen führen kann. Einmalig setzen:

```powershell
git config --global core.autocrlf false
```

Weiter mit [Abschnitt 4 – Bot einrichten](#4-bot-einrichten).

---

## 4. Bot einrichten

### 4.1 Repository klonen

**macOS:**
```bash
git clone <repo-url>
cd savax-loop-bot
```

**Windows (PowerShell):**
```powershell
git clone <repo-url>
cd savax-loop-bot
```

### 4.2 Abhängigkeiten installieren

```bash
npm install
```

### 4.3 Projekt bauen

```bash
npm run build
```

> Beim nächsten Start nach Code-Änderungen immer wieder `npm run build` ausführen.

### 4.4 .env-Datei anlegen

**macOS:**
```bash
cp .env.example .env
```

**Windows (PowerShell):**
```powershell
copy .env.example .env
```

Dann `.env` mit einem Texteditor öffnen (z.B. Notepad, VS Code) und anpassen — siehe [Abschnitt 6](#6-konfiguration-env).

---

## 5. Wallet einrichten (erster Start)

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

## 6. Konfiguration (.env)

Die Datei `.env` im Projektverzeichnis enthält alle einstellbaren Parameter:

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

## 7. Bedienung

### 7.1 Starten

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

### 7.2 Empfohlene Reihenfolge beim ersten Mal

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

### 7.3 Position abbauen

**Teilweise (Deleverage auf Ziel-HF):**
```
→ [6] Deleverage
```

**Vollständig (alle Schulden zurückzahlen, sAVAX in Wallet):**
```
→ [7] Unwind
```

### 7.4 Direkte Befehle (ohne Menü)

```bash
npm start -- --action=status       # Nur Status anzeigen
npm start -- --action=loop         # Loop direkt starten
npm start -- --action=monitor      # Nur Monitor starten
npm start -- --action=unwind-loop  # Direkt unwind starten
```

---

## 8. Transaction Log / Quittungen

Nach jedem Loop oder Unwind wird automatisch eine vollständige Dokumentation erstellt.

### 8.1 Terminal-Zusammenfassung

Direkt nach Abschluss erscheint im Terminal:

```
╔═════════════════════════════════════════════╗
║  SESSION SUMMARY – LOOP BUILD               ║
╚═════════════════════════════════════════════╝
  Session:     2025-02-22T14-30-00
  Gestartet:   2025-02-22 14:30:00
  Beendet:     2025-02-22 14:32:15
  Dauer:       135s
  Iterationen: 8
  Status:      ✓ OK

  Positionsveränderung:
    Collateral: $0.00 → $95.43
    Debt:       $0.00 → $91.77
    Leverage:   1.00x → 12.30x
    HF:         100.0000 → 1.0421

  Transaktionen (25):
  ───────────────────────────────────────────────
  [14:30:05] SWAP     0.4 AVAX → 0.348712 sAVAX @ 0.871780 sAVAX/AVAX  [INIT – AVAX → sAVAX]
             https://snowtrace.io/tx/0xabc...
  [14:30:12] SUPPLY   0.348712 sAVAX  [INIT – sAVAX supplyen]
             https://snowtrace.io/tx/0xdef...
  [14:30:25] BORROW   1.234567 WAVAX ($34.12)  [Iteration 1 – Borrow WAVAX]
             https://snowtrace.io/tx/0x123...
  ...
```

### 8.2 JSON-Datei (Quittung)

Gleichzeitig wird eine JSON-Datei im Ordner `logs/` gespeichert:

```
logs/
  2025-02-22T14-30-00_build.json    ← Loop-Session
  2025-02-22T15-45-00_unwind.json   ← Unwind-Session
```

**Dateiinhalt (Auszug):**
```json
{
  "sessionId": "2025-02-22T14-30-00",
  "action": "build",
  "startedAt": "2025-02-22T14:30:00.123Z",
  "finishedAt": "2025-02-22T14:32:15.456Z",
  "iterations": 8,
  "success": true,
  "records": [
    {
      "type": "swap",
      "hash": "0xabc...",
      "timestamp": "2025-02-22T14:30:05.000Z",
      "tokenIn": "AVAX",
      "amountIn": "0.4",
      "tokenOut": "sAVAX",
      "amountOut": "0.348712",
      "rate": "0.871780 sAVAX/AVAX",
      "snowtraceUrl": "https://snowtrace.io/tx/0xabc..."
    }
  ]
}
```

### 8.3 Transaktionen auf Snowtrace prüfen

Jede Transaktion enthält einen direkten Link zu [Snowtrace](https://snowtrace.io) (Avalanche Block Explorer). Dort sind alle Details on-chain nachvollziehbar:
- Genaue Token-Mengen
- Gas-Kosten
- Zeitstempel
- Vertragsinteraktionen

> Die `logs/`-Dateien werden **nicht** in Git committed (in `.gitignore` eingetragen).

---

## 9. Parameter-Erklärungen

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

## 10. Risiken & Sicherheit

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
- `wallet.enc` regelmäßig sichern

---

## 11. Häufige Fehler

### Allgemein

| Fehler | Bedeutung | Lösung |
|--------|-----------|--------|
| `Swap revertiert` | Slippage überschritten | `SLIPPAGE_BPS` in `.env` erhöhen (z.B. auf 100) |
| `Borrow-Menge zu klein` | Loop hat Ziel bereits erreicht | Normal – Position ist fertig aufgebaut |
| `NotBorrowableInEMode` | E-Mode nicht aktiv | Menüpunkt [2] E-Mode aktivieren |
| `Wallet-Passwort falsch` | Falsches Passwort eingegeben | Nochmals versuchen – case-sensitive |
| `AVAX Balance zu niedrig` | Weniger als 0.1 AVAX in Wallet | AVAX zur Wallet hinzufügen |
| `KyberSwap 400 Fehler` | Swap-Betrag zu klein | Mehr AVAX in Wallet bereitstellen |
| `TransactionReceiptNotFoundError` | RPC-Latenz | Bot wiederholt automatisch (bis 12×) |

### Windows-spezifisch

| Problem | Ursache | Lösung |
|---------|---------|--------|
| `npm : Die Datei ... kann nicht geladen werden` | PowerShell-Ausführungsrichtlinie | `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` als Administrator |
| `node` oder `npm` wird nicht gefunden | PATH nicht aktualisiert | PowerShell/Terminal neu öffnen nach Installation |
| Fehlerhafte Sonderzeichen im Terminal | Falsche Zeichenkodierung | PowerShell: `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` |
| `CRLF`-Warnungen beim Git-Commit | Zeilenenden-Konvertierung | `git config --global core.autocrlf false` |
| `ENOENT: no such file or directory` beim Start | Falsches Verzeichnis | `cd savax-loop-bot` vor `npm start` |
