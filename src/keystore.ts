// ============================================================================
// keystore.ts – AES-256-GCM Encrypted Keystore
// ============================================================================
// Verschlüsselt den Private Key mit AES-256-GCM und scrypt KDF.
// Kein zusätzliches npm-Paket nötig – nur Node.js built-in crypto.
//
// Dateiformat (wallet.enc):
//   { version, salt, iv, authTag, ciphertext } – alle Werte hex-kodiert
//
// Sicherheitseigenschaften:
//   - AES-256-GCM: authentifizierte Verschlüsselung (verhindert Manipulation)
//   - scrypt (N=16384): ~34ms pro Versuch → Brute-Force-Schutz
//   - Salt + IV: zufällig pro Erstellung → keine Rainbow-Tables
// ============================================================================

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------
const KEYSTORE_VERSION = 1;
const SCRYPT_N = 16384;  // 2^14 – macOS-kompatibel, ~34ms pro Versuch
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;      // 256 bit für AES-256
const SALT_LEN = 16;
const IV_LEN = 12;       // 96 bit – GCM Standard

// ---------------------------------------------------------------------------
// Keystore-Dateiformat
// ---------------------------------------------------------------------------
type KeystoreFile = {
  version: number;
  salt: string;   // hex
  iv: string;     // hex
  authTag: string; // hex
  ciphertext: string; // hex
};

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

/** Prüft ob eine wallet.enc Datei existiert */
export function keystoreExists(filePath: string): boolean {
  return existsSync(filePath);
}

/**
 * Erstellt einen neuen verschlüsselten Keystore.
 * @param privateKey  Private Key im Format "0x..."
 * @param password    Benutzerpasswort (Klartext – wird nicht gespeichert)
 * @param filePath    Pfad zur wallet.enc Datei
 */
export function createKeystore(
  privateKey: string,
  password: string,
  filePath: string,
): void {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);

  // Schlüssel aus Passwort ableiten (scrypt)
  const derivedKey = scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  // Verschlüsseln
  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(privateKey, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const keystore: KeystoreFile = {
    version: KEYSTORE_VERSION,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };

  writeFileSync(filePath, JSON.stringify(keystore, null, 2), 'utf8');
}

/**
 * Lädt und entschlüsselt einen Keystore.
 * @returns Private Key als "0x..." String
 * @throws  Bei falschem Passwort oder beschädigtem Keystore
 */
export function loadKeystore(password: string, filePath: string): string {
  const raw = readFileSync(filePath, 'utf8');
  const keystore: KeystoreFile = JSON.parse(raw) as KeystoreFile;

  if (keystore.version !== KEYSTORE_VERSION) {
    throw new Error(`Unbekannte Keystore-Version: ${keystore.version}`);
  }

  const salt = Buffer.from(keystore.salt, 'hex');
  const iv = Buffer.from(keystore.iv, 'hex');
  const authTag = Buffer.from(keystore.authTag, 'hex');
  const ciphertext = Buffer.from(keystore.ciphertext, 'hex');

  // Schlüssel ableiten
  const derivedKey = scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  // Entschlüsseln
  try {
    const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    throw new Error('Falsches Passwort oder beschädigter Keystore.');
  }
}

/**
 * Liest ein Passwort von stdin ohne Echo (Terminal-Eingabe).
 * @param prompt   Angezeigter Text vor der Eingabe
 * @param confirm  Wenn true: Passwort wird zweimal abgefragt und verglichen
 */
export async function promptPassword(
  prompt: string = 'Passwort: ',
  confirm: boolean = false,
): Promise<string> {
  const password = await readPasswordLine(prompt);

  if (!confirm) {
    return password;
  }

  if (password.length < 8) {
    throw new Error('Passwort muss mindestens 8 Zeichen haben.');
  }
  const password2 = await readPasswordLine('  Passwort bestätigen: ');
  if (password !== password2) {
    throw new Error('Passwörter stimmen nicht überein.');
  }

  return password;
}

// ---------------------------------------------------------------------------
// Intern: Password-Input mit * Echo über Raw-Mode stdin
// ---------------------------------------------------------------------------
function readPasswordLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);

    // stdin muss im flowing/paused-Modus sein, nicht im readline-Modus
    const stdin = process.stdin;

    // Raw-Mode: jedes Byte kommt sofort (kein Zeilenpuffer, kein Echo)
    const wasPaused = stdin.isPaused();
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    } else {
      // Kein TTY (z.B. pipe) → fallback: normales readline ohne Echo
      reject(new Error('Kein interaktives Terminal – Passwort-Eingabe nicht möglich.'));
      return;
    }
    stdin.resume();
    stdin.setEncoding('utf8');

    let password = '';

    const onData = (chunk: string) => {
      for (const char of chunk) {
        const code = char.charCodeAt(0);

        if (char === '\r' || char === '\n' || code === 13 || code === 10) {
          // Enter → fertig
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          if (wasPaused) stdin.pause();
          process.stdout.write('\n');
          resolve(password);
          return;
        }

        if (code === 3) {
          // Ctrl+C
          process.stdout.write('\n');
          process.exit(130);
        }

        if (code === 127 || code === 8) {
          // Backspace / Delete
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }

        if (code >= 32 && code < 127) {
          // Druckbares ASCII-Zeichen
          password += char;
          process.stdout.write('*');
        }
      }
    };

    stdin.on('data', onData);
  });
}
