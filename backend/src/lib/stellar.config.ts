const NETWORK = process.env.STELLAR_NETWORK ?? 'testnet';

export const STELLAR_NETWORK = NETWORK as 'testnet' | 'mainnet';

export const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ??
  (STELLAR_NETWORK === 'mainnet'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org');

export const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL ??
  (STELLAR_NETWORK === 'mainnet'
    ? 'https://soroban.stellar.org'
    : 'https://soroban-testnet.stellar.org');

export const USDC_ISSUER =
  process.env.USDC_ISSUER ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'; // default testnet issuer

export const getNetworkPassphrase = () => {
  if (STELLAR_NETWORK === 'mainnet') {
    return 'Public Global Stellar Network ; September 2015';
  }
  return 'Test SDF Network ; September 2015';
};
