import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QueryModal from './QueryModal';
import { I18nProvider } from '../../i18n';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  api: {
    initiateQuery: vi.fn(),
    demoQuery: vi.fn(),
    verifyPayment: vi.fn(),
  },
}));

const dataset = {
  id: 'ds-query-1',
  name: 'Whale Wallet Dataset',
  description: 'Wallet and transfer intelligence',
  type: 'whale-wallets',
  pricePerQuery: 0.05,
  sellerWallet: `G${'A'.repeat(55)}`,
  queriesServed: 12,
  totalEarned: 3.5,
  createdAt: new Date().toISOString(),
};

function renderModal(overrides?: {
  onClose?: () => void;
  onSuccess?: (updated: Partial<typeof dataset> & { id: string }) => void;
}) {
  const onClose = overrides?.onClose ?? vi.fn();
  const onSuccess = overrides?.onSuccess ?? vi.fn();

  render(
    <I18nProvider initialLocale="en">
      <QueryModal dataset={dataset} onClose={onClose} onSuccess={onSuccess} />
    </I18nProvider>,
  );

  return { onClose, onSuccess };
}

describe('QueryModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.initiateQuery).mockResolvedValue({
      payment: {
        paymentAddress: `G${'B'.repeat(55)}`,
        amount: dataset.pricePerQuery,
        memo: 'haz-memo-1',
      },
    } as never);
  });

  it('runs the happy-path payment flow in demo mode', async () => {
    const onSuccess = vi.fn();
    vi.mocked(api.demoQuery).mockResolvedValueOnce({
      success: true,
      demo: true,
      data: { rows: [1, 2] },
      ai: {
        summary: 'Summary text',
        answer: 'Answer text',
      },
      transaction: {
        hash: 'demo-hash',
        amount: 0.05,
        sellerReceived: 0.0475,
        platformFee: 0.0025,
      },
    });

    renderModal({ onSuccess });
    fireEvent.click(screen.getByRole('button', { name: 'Proceed to Payment' }));

    await waitFor(() => {
      expect(api.initiateQuery).toHaveBeenCalledWith('ds-query-1');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Get AI Analysis' }));

    await waitFor(() => {
      expect(screen.getByText('Payment Verified')).toBeTruthy();
    });

    expect(api.demoQuery).toHaveBeenCalledWith('ds-query-1', '');
    expect(onSuccess).toHaveBeenCalledWith({
      id: 'ds-query-1',
      queriesServed: 13,
      totalEarned: 3.5475,
    });
  });

  it('revokes the Object URL after downloading JSON', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true });

    vi.mocked(api.demoQuery).mockResolvedValueOnce({
      success: true,
      demo: true,
      data: { rows: [1, 2] },
      ai: {
        summary: 'Summary text',
        answer: 'Answer text',
      },
      transaction: {
        hash: 'demo-hash',
        amount: 0.05,
        sellerReceived: 0.0475,
        platformFee: 0.0025,
      },
    });

    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Proceed to Payment' }));

    await waitFor(() => {
      expect(api.initiateQuery).toHaveBeenCalledWith('ds-query-1');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Get AI Analysis' }));

    await waitFor(() => {
      expect(screen.getByText('Payment Verified')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Download JSON' }));

    await waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('shows error state for failed verification and allows retry', async () => {
    vi.mocked(api.verifyPayment).mockRejectedValueOnce(new Error('Verification failed'));

    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Proceed to Payment' }));

    await waitFor(() => {
      expect(api.initiateQuery).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByLabelText(/Demo mode/i));

    const verifyButton = screen.getByRole('button', { name: 'Verify & Get Data' });
    expect(verifyButton).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByPlaceholderText('Paste your Stellar transaction hash...'), {
      target: { value: 'tx-hash-123' },
    });
    expect(verifyButton).toHaveProperty('disabled', false);

    fireEvent.click(verifyButton);

    await waitFor(() => {
      expect(screen.getByText('Verification failed')).toBeTruthy();
      expect(screen.getByText('Verification Failed')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(screen.getByText('Transaction Hash')).toBeTruthy();
  });
});
