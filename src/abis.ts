// ============================================================================
// abis.ts – Minimale ABIs für Aave v3 Pool, ERC20, sAVAX, Oracle, DEX
// ============================================================================

// ---------------------------------------------------------------------------
// Aave v3 Pool – Nur die Funktionen die wir brauchen
// ---------------------------------------------------------------------------
export const AAVE_V3_POOL_ABI = [
  // Supply
  {
    name: 'supply',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  // Borrow
  {
    name: 'borrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint256' },
      { name: 'referralCode', type: 'uint16' },
      { name: 'onBehalfOf', type: 'address' },
    ],
    outputs: [],
  },
  // Repay
  {
    name: 'repay',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Withdraw
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // getUserAccountData
  {
    name: 'getUserAccountData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },  // in Base Currency (USD, 8 decimals)
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' }, // in bps (10000 = 100%)
      { name: 'ltv', type: 'uint256' },                         // in bps
      { name: 'healthFactor', type: 'uint256' },                 // 1e18 scale
    ],
  },
  // setUserEMode
  {
    name: 'setUserEMode',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'categoryId', type: 'uint8' }],
    outputs: [],
  },
  // getUserEMode
  {
    name: 'getUserEMode',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // getReserveData
  {
    name: 'getReserveData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'configuration', type: 'uint256' },
          { name: 'liquidityIndex', type: 'uint128' },
          { name: 'currentLiquidityRate', type: 'uint128' },
          { name: 'variableBorrowIndex', type: 'uint128' },
          { name: 'currentVariableBorrowRate', type: 'uint128' },
          { name: 'currentStableBorrowRate', type: 'uint128' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          { name: 'stableDebtTokenAddress', type: 'address' },
          { name: 'variableDebtTokenAddress', type: 'address' },
          { name: 'interestRateStrategyAddress', type: 'address' },
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
      },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// ERC20 Standard – approve + balanceOf + allowance
// ---------------------------------------------------------------------------
export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

// ---------------------------------------------------------------------------
// BENQI sAVAX – Staking Contract (submit = AVAX → sAVAX)
// ---------------------------------------------------------------------------
export const SAVAX_ABI = [
  // submit() – payable, sendet AVAX und erhält sAVAX zurück
  {
    name: 'submit',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // getPooledAvaxByShares – Berechnet AVAX-Wert für gegebene sAVAX-Menge
  {
    name: 'getPooledAvaxByShares',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'shareAmount', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // getSharesByPooledAvax – Berechnet sAVAX-Menge für gegebenen AVAX-Betrag
  {
    name: 'getSharesByPooledAvax',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'avaxAmount', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // totalPooledAvax
  {
    name: 'totalPooledAvax',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // totalSupply (ERC20)
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Standard ERC20 functions inherited
  ...ERC20_ABI,
] as const;

// ---------------------------------------------------------------------------
// WAVAX – Wrapped AVAX (deposit/withdraw)
// ---------------------------------------------------------------------------
export const WAVAX_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
  ...ERC20_ABI,
] as const;

// ---------------------------------------------------------------------------
// Aave Oracle – getAssetPrice
// ---------------------------------------------------------------------------
export const AAVE_ORACLE_ABI = [
  {
    name: 'getAssetPrice',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],  // USD price in 8 decimals
  },
  {
    name: 'getAssetsPrices',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'assets', type: 'address[]' }],
    outputs: [{ name: '', type: 'uint256[]' }],
  },
] as const;

// ---------------------------------------------------------------------------
// Aave V3 WrappedTokenGateway – repay mit nativem AVAX (ohne WAVAX wrap)
// ---------------------------------------------------------------------------
export const WRAPPED_TOKEN_GATEWAY_ABI = [
  {
    name: 'repayETH',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'pool', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'rateMode', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
    ],
    outputs: [],
  },
] as const;
