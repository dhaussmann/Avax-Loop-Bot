// ============================================================================
// kyberswap.ts – KyberSwap Aggregator API Client
// ============================================================================
// Nutzt die KyberSwap Aggregator API v1 für optimale Swap-Routen.
//
// Flow:
//   1. GET /api/v1/routes  → beste Route abfragen + Quote erhalten
//   2. POST /api/v1/route/build → Transaktion encodieren
//   3. WalletClient.sendTransaction() → ausführen
//
// Docs: https://docs.kyberswap.com/kyberswap-solutions/kyberswap-aggregator/aggregator-api-specification/evm-swaps
// ============================================================================

import {
  type WalletClient,
  type PublicClient,
  type Chain,
  type Transport,
  type Account,
  formatEther,
} from 'viem';
import { CONFIG } from './config.js';

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------
const KYBERSWAP_BASE = 'https://aggregator-api.kyberswap.com/avalanche/api/v1';

/** Native AVAX Token-Adresse (KyberSwap-Konvention) */
export const NATIVE_AVAX = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const;

/** sAVAX (BENQI) */
export const SAVAX_ADDRESS = '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE' as const;

// ---------------------------------------------------------------------------
// API-Typen
// ---------------------------------------------------------------------------
type RouteSummary = {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;       // Erwarteter Output (ohne Slippage)
  amountOutUsd: string;
  gas: string;
  gasPrice: string;
  route: unknown[];
  routeID: string;
  checksum: string;
  [key: string]: unknown;  // weitere Felder die KyberSwap zurückgibt
};

type RouteResponse = {
  code: number;
  message: string;
  data: {
    routeSummary: RouteSummary;
    routerAddress: string;
  };
};

type BuildResponse = {
  code: number;
  message: string;
  data: {
    amountOut: string;        // Tatsächlicher Output nach Slippage
    amountIn: string;
    data: `0x${string}`;     // Calldata
    routerAddress: string;   // Router-Adresse (Empfänger der Transaktion)
    transactionValue: string; // Wei (für native AVAX als tokenIn)
    gas: string;
    gasPrice: string;
    gasUsd: string;
  };
};

// ---------------------------------------------------------------------------
// Quote-Ergebnis (für Anzeige vor Bestätigung)
// ---------------------------------------------------------------------------
export type SwapQuote = {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;           // Erwarteter Output (exakt, ohne Slippage)
  amountOutMin: bigint;        // Minimum Output (nach Slippage)
  priceImpactPct: number;
  routeSummary: RouteSummary;
  routerAddress: `0x${string}`;
};

// ---------------------------------------------------------------------------
// KyberSwap Client
// ---------------------------------------------------------------------------
export class KyberSwapClient {
  constructor(
    private readonly publicClient: PublicClient<Transport, Chain>,
    private readonly walletClient: WalletClient<Transport, Chain, Account>,
  ) {}

  // =========================================================================
  // INTERN: waitForReceipt – mit Retry bei "unfinalized data" RPC-Fehler
  // =========================================================================

  private async waitForReceipt(hash: `0x${string}`, maxRetries = 12): Promise<{ status: 'success' | 'reverted' }> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRetryable =
          msg.includes('unfinalized') ||
          msg.includes('cannot query') ||
          msg.includes('could not be found') ||
          msg.includes('not processed on a block') ||
          msg.includes('TransactionReceiptNotFound');
        if (isRetryable) {
          const delay = attempt * 2000;
          console.log(`  ⚠ Warte auf Tx-Bestätigung (Versuch ${attempt}/${maxRetries}, ${delay}ms)...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`waitForReceipt: Tx ${hash} nach ${maxRetries} Versuchen nicht bestätigt.`);
  }

  // =========================================================================
  // Schritt 1: Route + Quote abfragen
  // =========================================================================

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<SwapQuote> {
    const params = new URLSearchParams({
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      excludedSources: 'dexalot', // Dexalot RFQ ist zeitkritisch und schlägt beim Build oft fehl
    });

    const url = `${KYBERSWAP_BASE}/routes?${params}`;
    console.log(`  → KyberSwap Route: ${url}`);

    const res = await fetch(url, {
      headers: {
        'x-client-id': 'savax-loop-bot',
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`KyberSwap Route API Fehler: ${res.status} ${await res.text()}`);
    }

    const json: RouteResponse = await res.json() as RouteResponse;

    if (json.code !== 0) {
      throw new Error(`KyberSwap Route Fehler: ${json.message}`);
    }

    const { routeSummary, routerAddress } = json.data;
    const amountOut = BigInt(routeSummary.amountOut);

    // Minimum Output nach Slippage berechnen
    const slippageFactor = BigInt(10000 - CONFIG.slippageBps);
    const amountOutMin = (amountOut * slippageFactor) / 10000n;

    // Preis-Impact: Vergleich amountOutUsd vs. amountIn USD-Wert
    // (KyberSwap gibt keinen expliziten priceImpact zurück – wir schätzen ihn)
    const priceImpactPct = 0; // Wird nach Build genauer bekannt

    return {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      amountOutMin,
      priceImpactPct,
      routeSummary,
      routerAddress: routerAddress as `0x${string}`,
    };
  }

  // =========================================================================
  // Schritt 2: Transaktion encodieren
  // =========================================================================

  async buildTransaction(quote: SwapQuote): Promise<{
    to: `0x${string}`;
    data: `0x${string}`;
    value: bigint;
    gas: bigint;
    amountOutMin: bigint;
    amountOutActual: bigint;
  }> {
    const body = {
      routeSummary: quote.routeSummary,
      sender: this.walletClient.account.address,
      recipient: this.walletClient.account.address,
      slippageTolerance: CONFIG.slippageBps,    // in bps (50 = 0.5%)
    };

    const res = await fetch(`${KYBERSWAP_BASE}/route/build`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': 'savax-loop-bot',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`KyberSwap Build API Fehler: ${res.status} ${await res.text()}`);
    }

    const json: BuildResponse = await res.json() as BuildResponse;

    if (json.code !== 0) {
      throw new Error(`KyberSwap Build Fehler: ${json.message}`);
    }

    const { data } = json;
    return {
      to: data.routerAddress as `0x${string}`,
      data: data.data,
      value: BigInt(data.transactionValue || '0'),
      gas: BigInt(data.gas || '500000'),
      amountOutMin: quote.amountOutMin,
      amountOutActual: BigInt(data.amountOut),
    };
  }

  // =========================================================================
  // Schritt 3: Swap ausführen (Quote + Build + Senden)
  // =========================================================================

  async swap(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    tokenOutSymbol: string = 'Token',
    _attempt: number = 1,
    onRetryExhausted?: () => Promise<boolean>,
  ): Promise<{ hash: `0x${string}`; amountOut: bigint; quote: SwapQuote }> {
    // 1. Quote holen
    console.log(`  → Quote: ${formatEther(amountIn)} ${tokenIn === NATIVE_AVAX ? 'AVAX' : tokenIn.slice(0, 8)} → ${tokenOutSymbol}`);
    const quote = await this.getQuote(tokenIn, tokenOut, amountIn);

    console.log(`  → Erwarteter Output:  ${formatEther(quote.amountOut)} ${tokenOutSymbol}`);
    console.log(`  → Minimum Output:     ${formatEther(quote.amountOutMin)} ${tokenOutSymbol} (nach ${CONFIG.slippageBps / 100}% Slippage)`);

    // 2. Transaktion bauen (mit Retry bei RFQ-Fehlern)
    let tx: Awaited<ReturnType<typeof this.buildTransaction>>;
    try {
      tx = await this.buildTransaction(quote);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (_attempt < 3 && msg.includes('RFQ')) {
        console.log(`  ⚠ Build fehlgeschlagen (${msg.split('\n')[0]}), neuer Versuch ${_attempt + 1}/3...`);
        return this.swap(tokenIn, tokenOut, amountIn, tokenOutSymbol, _attempt + 1, onRetryExhausted);
      }
      throw err;
    }

    console.log(`  → Router:             ${tx.to}`);
    console.log(`  → Gas (geschätzt):    ${tx.gas.toString()}`);

    // 3. Transaktion senden
    const hash = await this.walletClient.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: tx.gas,
    });

    console.log(`  → Tx gesendet: ${hash}`);

    // 4. Warten bis bestätigt
    const receipt = await this.waitForReceipt(hash);

    if (receipt.status !== 'success') {
      // On-chain Revert → frischen Quote + Retry (Slippage/Preis hat sich bewegt)
      if (_attempt < 3) {
        console.log(`  ⚠ Swap revertiert (${hash}), neuer Quote + Versuch ${_attempt + 1}/3...`);
        await new Promise(r => setTimeout(r, 2000));
        return this.swap(tokenIn, tokenOut, amountIn, tokenOutSymbol, _attempt + 1, onRetryExhausted);
      }
      // 3 Versuche erschöpft → Nutzer befragen ob weitermachen
      console.log(`  ✗ Swap fehlgeschlagen nach 3 Versuchen. Letzter Tx: ${hash}`);
      if (onRetryExhausted) {
        const retry = await onRetryExhausted();
        if (retry) {
          console.log('  → Starte neuen Versuchszyklus...');
          await new Promise(r => setTimeout(r, 2000));
          return this.swap(tokenIn, tokenOut, amountIn, tokenOutSymbol, 1, onRetryExhausted);
        }
      }
      throw new Error(`Swap-Transaktion fehlgeschlagen nach ${_attempt} Versuchen: ${hash}`);
    }

    console.log(`  ✓ Swap erfolgreich: ${hash}`);

    return { hash, amountOut: tx.amountOutActual, quote };
  }

  // =========================================================================
  // Nur Quote anzeigen (ohne Swap) – für Kurs-Check
  // =========================================================================

  async fetchQuoteOnly(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<SwapQuote> {
    return this.getQuote(tokenIn, tokenOut, amountIn);
  }
}
