import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SellPage from './SellPage';
import { I18nProvider } from '../i18n';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    createDataset: vi.fn(),
  },
}));

const validWallet = `G${'A'.repeat(55)}`;
const walletError =
  'Enter a valid Stellar public key (starts with G, uses A-Z or 2-7, and is exactly 56 characters)';

function renderSellPage() {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter>
        <SellPage />
      </MemoryRouter>
    </I18nProvider>,
  );
}

function getFileInput(container: HTMLElement) {
  const fileInput = container.querySelector('input[type="file"]');
  expect(fileInput).toBeTruthy();
  return fileInput as HTMLInputElement;
}

function fillRequiredFields() {
  fireEvent.change(
    screen.getByPlaceholderText('e.g. Top 100 Whale Wallet Movements — April 2026'),
    {
      target: { value: 'Test Dataset' },
    },
  );
  fireEvent.change(
    screen.getByPlaceholderText(
      'Describe what your data contains, how it was collected, and why buyers would want it...',
    ),
    {
      target: { value: 'A useful dataset description' },
    },
  );
  fireEvent.change(screen.getByPlaceholderText('G... (56-character Stellar public key)'), {
    target: { value: validWallet },
  });
}

describe('SellPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['short addresses', 'G123'],
    ['56-character addresses with the wrong prefix', `E${'A'.repeat(55)}`],
    ['addresses longer than 56 characters', `${validWallet}A`],
    ['addresses with invalid characters', `G${'a'.repeat(55)}`],
  ])('shows wallet validation error for %s', (_label, wallet) => {
    renderSellPage();
    fireEvent.change(screen.getByPlaceholderText('G... (56-character Stellar public key)'), {
      target: { value: wallet },
    });

    expect(screen.getByText(walletError)).toBeTruthy();
    const submitButton = screen.getByRole('button', { name: 'Publish to Marketplace' });
    expect(submitButton).toHaveProperty('disabled', true);
  });

  it('only advertises JSON uploads', () => {
    const { container } = renderSellPage();

    expect(screen.getByText('Upload JSON file')).toBeTruthy();
    expect(screen.getByText('JSON only, max 10MB')).toBeTruthy();
    expect(getFileInput(container).accept).toBe('.json,application/json');
  });

  it('shows JSON validation error for malformed dataset payload', () => {
    renderSellPage();
    fillRequiredFields();
    fireEvent.change(screen.getByPlaceholderText(/Paste your JSON data here/i), {
      target: { value: '{invalid-json' },
    });

    expect(
      screen.getByText('Invalid JSON — please check your data format'),
    ).toBeTruthy();
    const submitButton = screen.getByRole('button', { name: 'Publish to Marketplace' });
    expect(submitButton).toHaveProperty('disabled', true);
  });

  it('submits, shows loading state, then success state', async () => {
    type CreatedDataset = Awaited<ReturnType<typeof api.createDataset>>;
    let resolveRequest: ((value: CreatedDataset) => void) | undefined;
    vi.mocked(api.createDataset).mockReturnValueOnce(
      new Promise<CreatedDataset>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    renderSellPage();
    fillRequiredFields();
    fireEvent.change(screen.getByPlaceholderText(/Paste your JSON data here/i), {
      target: { value: '{"rows":[1,2,3]}' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Publish to Marketplace' }));

    expect(screen.getByRole('button', { name: 'Publishing Listing...' })).toBeTruthy();
    expect(api.createDataset).toHaveBeenCalledWith({
      name: 'Test Dataset',
      description: 'A useful dataset description',
      type: 'whale-wallets',
      pricePerQuery: 0.05,
      sellerWallet: validWallet,
      data: { rows: [1, 2, 3] },
    });

    resolveRequest?.({
      id: 'ds-1',
      name: 'Test Dataset',
      description: 'A useful dataset description',
      type: 'whale-wallets',
      pricePerQuery: 0.05,
      sellerWallet: validWallet,
      queriesServed: 0,
      totalEarned: 0,
      createdAt: new Date().toISOString(),
    });

    await waitFor(() => {
      expect(screen.getByText('Listing Live!')).toBeTruthy();
    });
  });

  it('shows API error when submission fails', async () => {
    vi.mocked(api.createDataset).mockRejectedValueOnce(new Error('Create failed'));

    renderSellPage();
    fillRequiredFields();
    fireEvent.change(screen.getByPlaceholderText(/Paste your JSON data here/i), {
      target: { value: '{"rows":[1]}' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Publish to Marketplace' }));

    await waitFor(() => {
      expect(screen.getByText('Create failed')).toBeTruthy();
    });
  });
});
