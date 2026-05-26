import { EventEmitter } from 'events';
import {
  TransactionUpdateEvent,
  PaymentReceivedEvent,
  PaymentForwardedEvent,
  DatasetQueryEvent,
  TransactionStatus,
} from './ws.types';

/**
 * Global event emitter for transaction updates
 * Used to broadcast real-time updates to connected WebSocket clients
 */
class TransactionEventEmitter extends EventEmitter {
  /**
   * Emit a transaction status update
   */
  emitTransactionUpdate(event: TransactionUpdateEvent): void {
    this.emit('transaction:update', event);
  }

  /**
   * Emit a payment received event
   */
  emitPaymentReceived(event: PaymentReceivedEvent): void {
    this.emit('payment:received', event);
  }

  /**
   * Emit a payment forwarded event
   */
  emitPaymentForwarded(event: PaymentForwardedEvent): void {
    this.emit('payment:forwarded', event);
  }

  /**
   * Emit a dataset queried event
   */
  emitDatasetQueried(event: DatasetQueryEvent): void {
    this.emit('dataset:queried', event);
  }

  /**
   * Helper to create and emit a transaction status update
   */
  updateTransactionStatus(
    transactionId: string,
    datasetId: string,
    status: TransactionStatus,
    metadata?: Partial<TransactionUpdateEvent['data']>
  ): void {
    const event: TransactionUpdateEvent = {
      type: 'transaction:update',
      data: {
        transactionId,
        datasetId,
        status,
        amount: metadata?.amount || '0',
        buyerQuery: metadata?.buyerQuery,
        aiSummary: metadata?.aiSummary,
        deliveryStatus: metadata?.deliveryStatus,
        timestamp: new Date().toISOString(),
        error: metadata?.error,
      },
    };
    this.emitTransactionUpdate(event);
  }

  /**
   * Helper to create and emit a payment received event
   */
  receivePayment(
    transactionId: string,
    datasetId: string,
    amount: string
  ): void {
    const event: PaymentReceivedEvent = {
      type: 'payment:received',
      data: {
        transactionId,
        datasetId,
        amount,
        timestamp: new Date().toISOString(),
      },
    };
    this.emitPaymentReceived(event);
  }

  /**
   * Helper to create and emit a payment forwarded event
   */
  forwardPayment(
    transactionId: string,
    datasetId: string,
    sellerAmount: string,
    platformAmount: string
  ): void {
    const event: PaymentForwardedEvent = {
      type: 'payment:forwarded',
      data: {
        transactionId,
        datasetId,
        sellerAmount,
        platformAmount,
        timestamp: new Date().toISOString(),
      },
    };
    this.emitPaymentForwarded(event);
  }

  /**
   * Helper to create and emit a dataset queried event
   */
  queryDataset(
    transactionId: string,
    datasetId: string,
    queryCount: number
  ): void {
    const event: DatasetQueryEvent = {
      type: 'dataset:queried',
      data: {
        transactionId,
        datasetId,
        queryCount,
        timestamp: new Date().toISOString(),
      },
    };
    this.emitDatasetQueried(event);
  }
}

// Export singleton instance
export const transactionEventEmitter = new TransactionEventEmitter();
