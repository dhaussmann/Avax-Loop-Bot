// ============================================================================
// aaveClient.ts – Low-Level Aave v3 Pool Interaktion
// ============================================================================
// Direkte viem-Calls an den Aave v3 Pool Contract auf Avalanche.
// Kein @aave/client Dependency – reine viem readContract/writeContract Calls.
// ============================================================================

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  formatUnits,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
} from 'viem';
import { avalanche } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { CONFIG, ADDRESSES, EMODE } from './config.js';
import { AAVE_V3_POOL_ABI, ERC20_ABI, SAVAX_ABI, WAVAX_ABI, AAVE_ORACLE_ABI, WRAPPED_TOKEN_GATEWAY_ABI } from './abis.js';
import { KyberSwapClient, NATIVE_AVAX, SAVAX_ADDRESS } from './kyberswap.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type AccountData = {
  totalCollateralBase: bigint;    // USD value, 8 decimals
  totalDebtBase: bigint;          // USD value, 8 decimals
  availableBorrowsBase: bigint;   // USD value, 8 decimals
  currentLiquidationThreshold: bigint; // bps (10000 = 100%)
  ltv: bigint;                    // bps
  healthFactor: bigint;           // 1e18
};

export type AccountSnapshot = {
  raw: AccountData;
  healthFactor: number;
  leverage: number;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  ltvPct: number;
  liquidationThresholdPct: number;
};

// ---------------------------------------------------------------------------
// AaveClient Klasse
// ---------------------------------------------------------------------------
export class AaveClient {
  public readonly publicClient: PublicClient<Transport, Chain>;
  public readonly walletClient: WalletClient<Transport, Chain, Account>;
  public readonly userAddress: `0x${string}`;
  public readonly kyberswap: KyberSwapClient;

  constructor() {
    const account = privateKeyToAccount(CONFIG.privateKey);

    this.publicClient = createPublicClient({
      chain: avalanche,
      transport: http(CONFIG.rpcUrl),
    });

    this.walletClient = createWalletClient({
      chain: avalanche,
      transport: http(CONFIG.rpcUrl),
      account,
    });

    this.userAddress = account.address;
    this.kyberswap = new KyberSwapClient(this.publicClient, this.walletClient);
  }

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
  // READ: Account Data
  // =========================================================================

  async getAccountData(): Promise<AccountData> {
    const result = await this.publicClient.readContract({
      address: ADDRESSES.pool,
      abi: AAVE_V3_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [this.userAddress],
    });

    return {
      totalCollateralBase: result[0],
      totalDebtBase: result[1],
      availableBorrowsBase: result[2],
      currentLiquidationThreshold: result[3],
      ltv: result[4],
      healthFactor: result[5],
    };
  }

  async getAccountSnapshot(): Promise<AccountSnapshot> {
    const raw = await this.getAccountData();
    const hf = Number(raw.healthFactor) / 1e18;
    const collateral = Number(raw.totalCollateralBase) / 1e8;
    const debt = Number(raw.totalDebtBase) / 1e8;
    const equity = collateral - debt;
    
    return {
      raw,
      healthFactor: hf,
      leverage: equity > 0 ? collateral / equity : 0,
      totalCollateralUsd: collateral,
      totalDebtUsd: debt,
      availableBorrowsUsd: Number(raw.availableBorrowsBase) / 1e8,
      ltvPct: Number(raw.ltv) / 100,
      liquidationThresholdPct: Number(raw.currentLiquidationThreshold) / 100,
    };
  }

  // =========================================================================
  // READ: E-Mode Status
  // =========================================================================
  
  async getUserEMode(): Promise<number> {
    const result = await this.publicClient.readContract({
      address: ADDRESSES.pool,
      abi: AAVE_V3_POOL_ABI,
      functionName: 'getUserEMode',
      args: [this.userAddress],
    });
    return Number(result);
  }

  // =========================================================================
  // READ: Token Balances & Prices
  // =========================================================================
  
  async getBalance(token: `0x${string}`): Promise<bigint> {
    return this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [this.userAddress],
    });
  }

  /**
   * Liest die Balance wiederholt bis sie sich gegenüber `before` erhöht hat.
   * Nötig weil RPC-Nodes nach einem Block manchmal noch den alten Stand liefern.
   */
  private async getBalanceAfterTx(
    token: `0x${string}`,
    before: bigint,
    maxRetries = 8,
    delayMs = 1500,
  ): Promise<bigint> {
    for (let i = 0; i < maxRetries; i++) {
      const bal = await this.getBalance(token);
      if (bal > before) return bal;
      await new Promise(r => setTimeout(r, delayMs));
    }
    // Fallback: letzter gelesener Wert (kann gleich before sein)
    return this.getBalance(token);
  }

  async getNativeBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.userAddress });
  }

  async getAssetPrice(asset: `0x${string}`): Promise<bigint> {
    return this.publicClient.readContract({
      address: ADDRESSES.aaveOracle,
      abi: AAVE_ORACLE_ABI,
      functionName: 'getAssetPrice',
      args: [asset],
    });
  }

  /** sAVAX/AVAX Exchange Rate aus dem BENQI Contract */
  async getSAvaxExchangeRate(): Promise<{ avaxPerSAvax: number; sAvaxPerAvax: number }> {
    const oneEther = 1_000_000_000_000_000_000n; // 1e18
    
    const avaxForOneSAvax = await this.publicClient.readContract({
      address: ADDRESSES.sAVAX,
      abi: SAVAX_ABI,
      functionName: 'getPooledAvaxByShares',
      args: [oneEther],
    });

    const sAvaxForOneAvax = await this.publicClient.readContract({
      address: ADDRESSES.sAVAX,
      abi: SAVAX_ABI,
      functionName: 'getSharesByPooledAvax',
      args: [oneEther],
    });

    return {
      avaxPerSAvax: Number(avaxForOneSAvax) / 1e18,
      sAvaxPerAvax: Number(sAvaxForOneAvax) / 1e18,
    };
  }

  // =========================================================================
  // WRITE: E-Mode aktivieren
  // =========================================================================
  
  async enableEMode(): Promise<`0x${string}`> {
    const currentEMode = await this.getUserEMode();
    if (currentEMode === EMODE.categoryId) {
      console.log(`  ✓ E-Mode bereits aktiv (Kategorie ${EMODE.categoryId})`);
      return '0x0' as `0x${string}`;
    }

    console.log(`  → Aktiviere E-Mode Kategorie ${EMODE.categoryId}...`);
    const hash = await this.walletClient.writeContract({
      address: ADDRESSES.pool,
      abi: AAVE_V3_POOL_ABI,
      functionName: 'setUserEMode',
      args: [EMODE.categoryId],
    });

    await this.waitForReceipt(hash);
    console.log(`  ✓ E-Mode aktiviert: ${hash}`);
    return hash;
  }

  // =========================================================================
  // WRITE: ERC20 Approve (mit Allowance-Check)
  // =========================================================================
  
  async ensureApproval(
    token: `0x${string}`,
    spender: `0x${string}`,
    amount: bigint,
  ): Promise<void> {
    const readAllowance = () => this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [this.userAddress, spender],
    });

    const currentAllowance = await readAllowance();

    if (currentAllowance >= amount) {
      return; // Bereits genug approved
    }

    console.log(`  → Approve ${formatEther(amount)} Token für ${spender}...`);
    const hash = await this.walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, amount],
    });

    await this.waitForReceipt(hash);

    // Warten bis RPC-Node die neue Allowance reflektiert (Timing-Bug auf Avalanche RPC)
    for (let i = 0; i < 8; i++) {
      const confirmed = await readAllowance();
      if (confirmed >= amount) break;
      await new Promise(r => setTimeout(r, 1500));
    }

    console.log(`  ✓ Approved: ${hash}`);
  }

  // =========================================================================
  // WRITE: AVAX → sAVAX via KyberSwap Aggregator
  // =========================================================================

  async swapAvaxForSAvax(
    avaxAmount: bigint,
    onRetryExhausted?: () => Promise<boolean>,
  ): Promise<{ hash: `0x${string}`; sAvaxReceived: bigint; quote: import('./kyberswap.js').SwapQuote }> {
    console.log(`  → Swap ${formatEther(avaxAmount)} AVAX → sAVAX via KyberSwap...`);

    // Balance vor dem Swap messen
    const sAvaxBefore = await this.getBalance(ADDRESSES.sAVAX);

    const { hash, quote } = await this.kyberswap.swap(
      NATIVE_AVAX,
      SAVAX_ADDRESS,
      avaxAmount,
      'sAVAX',
      1,
      onRetryExhausted,
    );

    // Echte sAVAX-Balance nach Swap lesen – mit Retry falls RPC-Node noch alten Stand liefert
    const sAvaxAfter = await this.getBalanceAfterTx(ADDRESSES.sAVAX, sAvaxBefore);
    const sAvaxReceived = sAvaxAfter > sAvaxBefore ? sAvaxAfter - sAvaxBefore : 0n;
    console.log(`  ✓ Erhalten: ${formatEther(sAvaxReceived)} sAVAX (Wallet: ${formatEther(sAvaxAfter)} sAVAX)`);
    return { hash, sAvaxReceived, quote };
  }

  /** @deprecated Verwende swapAvaxForSAvax() – bleibt für Rückwärtskompatibilität */
  async stakeAvaxForSAvax(
    avaxAmount: bigint,
    onRetryExhausted?: () => Promise<boolean>,
  ): Promise<{ hash: `0x${string}`; sAvaxReceived: bigint }> {
    const result = await this.swapAvaxForSAvax(avaxAmount, onRetryExhausted);
    return { hash: result.hash, sAvaxReceived: result.sAvaxReceived };
  }

  // =========================================================================
  // WRITE: WAVAX → sAVAX via KyberSwap (kein Unwrap nötig)
  // =========================================================================

  async swapWavaxForSAvax(
    wavaxAmount: bigint,
    onRetryExhausted?: () => Promise<boolean>,
  ): Promise<{ hash: `0x${string}`; sAvaxReceived: bigint }> {
    console.log(`  → Swap ${formatEther(wavaxAmount)} WAVAX → sAVAX via KyberSwap...`);

    // WAVAX-Approval für KyberSwap Router (Adresse kommt aus Quote)
    const quote = await this.kyberswap.fetchQuoteOnly(ADDRESSES.WAVAX, SAVAX_ADDRESS, wavaxAmount);
    await this.ensureApproval(ADDRESSES.WAVAX, quote.routerAddress, wavaxAmount);

    // Balance vor dem Swap messen
    const sAvaxBefore = await this.getBalance(ADDRESSES.sAVAX);

    const { hash } = await this.kyberswap.swap(
      ADDRESSES.WAVAX,
      SAVAX_ADDRESS,
      wavaxAmount,
      'sAVAX',
      1,
      onRetryExhausted,
    );

    // Echte sAVAX-Balance nach Swap lesen – mit Retry falls RPC-Node noch alten Stand liefert
    const sAvaxAfter = await this.getBalanceAfterTx(ADDRESSES.sAVAX, sAvaxBefore);
    const sAvaxReceived = sAvaxAfter > sAvaxBefore ? sAvaxAfter - sAvaxBefore : 0n;
    console.log(`  ✓ Erhalten: ${formatEther(sAvaxReceived)} sAVAX (Wallet: ${formatEther(sAvaxAfter)} sAVAX)`);
    return { hash, sAvaxReceived };
  }

  // =========================================================================
  // WRITE: native AVAX → WAVAX wrap
  // =========================================================================

  async wrapAvax(amount: bigint): Promise<`0x${string}`> {
    console.log(`  → Wrap ${formatEther(amount)} AVAX → WAVAX...`);
    const hash = await this.walletClient.writeContract({
      address: ADDRESSES.WAVAX,
      abi: WAVAX_ABI,
      functionName: 'deposit',
      args: [],
      value: amount,
    });
    await this.waitForReceipt(hash);
    console.log(`  ✓ Wrapped: ${hash}`);
    return hash;
  }

  // =========================================================================
  // WRITE: sAVAX → AVAX via KyberSwap
  // =========================================================================

  async swapSAvaxForAvax(
    sAvaxAmount: bigint,
    onRetryExhausted?: () => Promise<boolean>,
  ): Promise<{ hash: `0x${string}`; avaxReceived: bigint }> {
    console.log(`  → Swap ${formatEther(sAvaxAmount)} sAVAX → AVAX via KyberSwap...`);

    // sAVAX approval für KyberSwap Router
    const quote = await this.kyberswap.fetchQuoteOnly(SAVAX_ADDRESS, NATIVE_AVAX, sAvaxAmount);
    await this.ensureApproval(ADDRESSES.sAVAX, quote.routerAddress, sAvaxAmount);

    const { hash, amountOut } = await this.kyberswap.swap(
      SAVAX_ADDRESS,
      NATIVE_AVAX,
      sAvaxAmount,
      'AVAX',
      1,
      onRetryExhausted,
    );

    console.log(`  ✓ Erhalten: ${formatEther(amountOut)} AVAX`);
    return { hash, avaxReceived: amountOut };
  }

  // =========================================================================
  // WRITE: Swap sAVAX → WAVAX via KyberSwap (für Repay ohne Gateway)
  // =========================================================================

  async swapSAvaxForWavax(
    sAvaxAmount: bigint,
    onRetryExhausted?: () => Promise<boolean>,
  ): Promise<{ hash: `0x${string}`; wavaxReceived: bigint }> {
    console.log(`  → Swap ${formatEther(sAvaxAmount)} sAVAX → WAVAX via KyberSwap...`);

    const wavaxBefore = await this.getBalance(ADDRESSES.WAVAX);

    const quote = await this.kyberswap.fetchQuoteOnly(SAVAX_ADDRESS, ADDRESSES.WAVAX, sAvaxAmount);
    await this.ensureApproval(ADDRESSES.sAVAX, quote.routerAddress, sAvaxAmount);

    const { hash } = await this.kyberswap.swap(
      SAVAX_ADDRESS,
      ADDRESSES.WAVAX,
      sAvaxAmount,
      'WAVAX',
      1,
      onRetryExhausted,
    );

    // Echte WAVAX-Balance nach Swap lesen – mit Retry falls RPC-Node noch alten Stand liefert
    const wavaxAfter = await this.getBalanceAfterTx(ADDRESSES.WAVAX, wavaxBefore);
    const wavaxReceived = wavaxAfter > wavaxBefore ? wavaxAfter - wavaxBefore : 0n;
    console.log(`  ✓ Erhalten: ${formatEther(wavaxReceived)} WAVAX (Wallet: ${formatEther(wavaxAfter)} WAVAX)`);
    return { hash, wavaxReceived };
  }

  // =========================================================================
  // WRITE: WAVAX unwrap → native AVAX
  // =========================================================================

  async unwrapWavax(amount: bigint): Promise<`0x${string}`> {
    console.log(`  → Unwrap ${formatEther(amount)} WAVAX → AVAX...`);
    const hash = await this.walletClient.writeContract({
      address: ADDRESSES.WAVAX,
      abi: WAVAX_ABI,
      functionName: 'withdraw',
      args: [amount],
    });
    await this.waitForReceipt(hash);
    console.log(`  ✓ Unwrapped: ${hash}`);
    return hash;
  }

  // =========================================================================
  // WRITE: Supply sAVAX to Aave
  // =========================================================================
  
  async supplySAvax(amount: bigint): Promise<`0x${string}`> {
    console.log(`  → Supply ${formatEther(amount)} sAVAX to Aave...`);

    // Approve sAVAX für den Pool
    await this.ensureApproval(ADDRESSES.sAVAX, ADDRESSES.pool, amount);

    const hash = await this.walletClient.writeContract({
      address: ADDRESSES.pool,
      abi: AAVE_V3_POOL_ABI,
      functionName: 'supply',
      args: [ADDRESSES.sAVAX, amount, this.userAddress, 0],
    });

    await this.waitForReceipt(hash);
    console.log(`  ✓ Supplied: ${hash}`);
    return hash;
  }

  // =========================================================================
  // WRITE: Borrow WAVAX from Aave (Variable Rate)
  // =========================================================================
  
  async borrowWavax(amount: bigint): Promise<`0x${string}`> {
    console.log(`  → Borrow ${formatEther(amount)} WAVAX from Aave (Variable)...`);

    const hash = await this.walletClient.writeContract({
      address: ADDRESSES.pool,
      abi: AAVE_V3_POOL_ABI,
      functionName: 'borrow',
      args: [
        ADDRESSES.WAVAX,
        amount,
        2n, // Variable Rate Mode
        0,  // referralCode
        this.userAddress,
      ],
    });

    await this.waitForReceipt(hash);
    console.log(`  ✓ Borrowed: ${hash}`);
    return hash;
  }

  // =========================================================================
  // WRITE: Repay WAVAX to Aave
  // =========================================================================
  
  async repayWavax(amount: bigint): Promise<`0x${string}`> {
    console.log(`  → Repay ${formatEther(amount)} WAVAX to Aave (Variable)...`);

    // Approve WAVAX für den Pool
    await this.ensureApproval(ADDRESSES.WAVAX, ADDRESSES.pool, amount);

    const hash = await this.walletClient.writeContract({
      address: ADDRESSES.pool,
      abi: AAVE_V3_POOL_ABI,
      functionName: 'repay',
      args: [ADDRESSES.WAVAX, amount, 2n, this.userAddress],
    });

    await this.waitForReceipt(hash);
    console.log(`  ✓ Repaid: ${hash}`);
    return hash;
  }

  // =========================================================================
  // WRITE: Repay mit nativem AVAX via WrappedTokenGateway (kein WAVAX-Wrap)
  // =========================================================================

  async repayWithNativeAvax(avaxAmount: bigint): Promise<`0x${string}`> {
    console.log(`  → Repay ${formatEther(avaxAmount)} AVAX via WrappedTokenGateway...`);

    // amount = exakter avaxAmount der gesendet wird (value muss amount entsprechen)
    const hash = await this.walletClient.writeContract({
      address: ADDRESSES.wrappedTokenGateway,
      abi: WRAPPED_TOKEN_GATEWAY_ABI,
      functionName: 'repayETH',
      args: [ADDRESSES.pool, avaxAmount, 2n, this.userAddress],
      value: avaxAmount,
    });

    await this.waitForReceipt(hash);
    console.log(`  ✓ Repaid via Gateway: ${hash}`);
    return hash;
  }

  // =========================================================================
  // WRITE: Withdraw sAVAX from Aave
  // =========================================================================
  
  async withdrawSAvax(amount: bigint): Promise<`0x${string}`> {
    console.log(`  → Withdraw ${formatEther(amount)} sAVAX from Aave...`);

    const hash = await this.walletClient.writeContract({
      address: ADDRESSES.pool,
      abi: AAVE_V3_POOL_ABI,
      functionName: 'withdraw',
      args: [ADDRESSES.sAVAX, amount, this.userAddress],
    });

    await this.waitForReceipt(hash);
    console.log(`  ✓ Withdrawn: ${hash}`);
    return hash;
  }

  // =========================================================================
  // Utility: Pretty-Print Account Status
  // =========================================================================
  
  async printStatus(): Promise<AccountSnapshot> {
    const snap = await this.getAccountSnapshot();
    const eMode = await this.getUserEMode();
    const nativeBal = await this.getNativeBalance();
    const sAvaxBal = await this.getBalance(ADDRESSES.sAVAX);
    const wavaxBal = await this.getBalance(ADDRESSES.WAVAX);

    console.log('');
    console.log('┌─────────────────────────────────────────────┐');
    console.log('│          AAVE v3 ACCOUNT STATUS             │');
    console.log('├─────────────────────────────────────────────┤');
    console.log(`│  Address:        ${this.userAddress}`);
    console.log(`│  E-Mode:         ${eMode === EMODE.categoryId ? `✓ Active (Cat. ${eMode})` : `✗ Inactive (${eMode})`}`);
    console.log(`│  Health Factor:  ${snap.healthFactor.toFixed(4)}`);
    console.log(`│  Leverage:       ${snap.leverage.toFixed(2)}x`);
    console.log(`│  Collateral:     $${snap.totalCollateralUsd.toFixed(2)}`);
    console.log(`│  Debt:           $${snap.totalDebtUsd.toFixed(2)}`);
    console.log(`│  Avail. Borrow:  $${snap.availableBorrowsUsd.toFixed(2)}`);
    console.log(`│  LTV:            ${snap.ltvPct.toFixed(1)}%`);
    console.log(`│  Liq. Threshold: ${snap.liquidationThresholdPct.toFixed(1)}%`);
    console.log('├─────────────────────────────────────────────┤');
    console.log(`│  AVAX Balance:   ${formatEther(nativeBal)}`);
    console.log(`│  sAVAX Balance:  ${formatEther(sAvaxBal)}`);
    console.log(`│  WAVAX Balance:  ${formatEther(wavaxBal)}`);
    console.log('└─────────────────────────────────────────────┘');
    console.log('');

    return snap;
  }
}
