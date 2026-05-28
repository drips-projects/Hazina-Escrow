import { useEffect, useState, useRef, useCallback } from 'react';
import type {
  ServerEvent,
  TransactionUpdateEvent,
  PaymentReceivedEvent,
  PaymentForwardedEvent,
  DatasetQueryEvent,
} from '../lib/websocket.types';

interface UseTransactionWebSocketOptions {
  datasetIds?: string[];
  transactionIds?: string[];
  apiToken?: string;
  enabled?: boolean;
}

interface WebSocketState {
  connected: boolean;
  error: string | null;
}

interface WebSocketCallbacks {
  onTransactionUpdate?: (event: TransactionUpdateEvent) => void;
  onPaymentReceived?: (event: PaymentReceivedEvent) => void;
  onPaymentForwarded?: (event: PaymentForwardedEvent) => void;
  onDatasetQueried?: (event: DatasetQueryEvent) => void;
  onError?: (error: string) => void;
}

/**
 * React hook for real-time transaction updates via WebSocket
 * @example
 * ```tsx
 * const { connected } = useTransactionWebSocket({
 *   datasetIds: ['dataset-1'],
 * }, {
 *   onTransactionUpdate: (event) => {
 *     console.log('Transaction updated:', event);
 *   },
 *   onPaymentReceived: (event) => {
 *     console.log('Payment received:', event);
 *   },
 * });
 * ```
 */
export function useTransactionWebSocket(
  options: UseTransactionWebSocketOptions,
  callbacks: WebSocketCallbacks,
): WebSocketState & {
  subscribe: (ids: { datasetIds?: string[]; transactionIds?: string[] }) => void;
} {
  const [state, setState] = useState<WebSocketState>({
    connected: false,
    error: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const reconnectAttemptsRef = useRef(0);
  const pendingSubscriptionsRef = useRef<Array<{ datasetIds?: string[]; transactionIds?: string[] }>>([]);
  // Store callbacks in ref to avoid dependency issues
  const callbacksRef = useRef(callbacks);
  const maxReconnectAttempts = 5;
  const baseReconnectDelay = 1000; // 1 second

  /**
   * Calculate backoff delay for reconnection
   */
  const getReconnectDelay = useCallback((): number => {
    return baseReconnectDelay * Math.pow(2, Math.min(reconnectAttemptsRef.current, 3));
  }, []);

  // Update callbacks ref when callbacks change (without triggering reconnects)
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  /**
   * Connect to WebSocket server
   */
  const connect = useCallback((): void => {
    if (options.enabled === false) return;

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = process.env.REACT_APP_WEBSOCKET_URL || `${protocol}://${window.location.host}`;
      const wsUrl = `${host}/ws`;

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('[WebSocket] Connected');
        setState({ connected: true, error: null });
        reconnectAttemptsRef.current = 0;

        // Subscribe to datasets/transactions
        const subscribeMsg = {
          type: 'subscribe',
          ...(options.datasetIds && { datasetIds: options.datasetIds }),
          ...(options.transactionIds && { transactionIds: options.transactionIds }),
          ...(options.apiToken && { token: options.apiToken }),
        };
        ws.send(JSON.stringify(subscribeMsg));

        // Flush any subscriptions that were requested while CONNECTING
        pendingSubscriptionsRef.current.forEach((ids: { datasetIds?: string[]; transactionIds?: string[] }) => {
          const msg = {
            type: 'subscribe',
            ...ids,
            ...(options.apiToken && { token: options.apiToken }),
          };
          ws.send(JSON.stringify(msg));
        });
        pendingSubscriptionsRef.current = [];
      };

      ws.onmessage = event => {
        try {
          const message = JSON.parse(event.data) as ServerEvent;

          // Route to appropriate callback
          switch (message.type) {
            case 'transaction:update':
              callbacksRef.current?.onTransactionUpdate?.(message as TransactionUpdateEvent);
              break;
            case 'payment:received':
              callbacksRef.current?.onPaymentReceived?.(message as PaymentReceivedEvent);
              break;
            case 'payment:forwarded':
              callbacksRef.current?.onPaymentForwarded?.(message as PaymentForwardedEvent);
              break;
            case 'dataset:queried':
              callbacksRef.current?.onDatasetQueried?.(message as DatasetQueryEvent);
              break;
          }
        } catch (error) {
          console.error('[WebSocket] Failed to parse message:', error);
        }
      };

      ws.onerror = error => {
        console.error('[WebSocket] Error:', error);
        const errorMsg = error instanceof Event ? 'WebSocket error' : String(error);
        setState(prev => ({ ...prev, error: errorMsg, connected: false }));
        callbacksRef.current?.onError?.(errorMsg);
      };

      ws.onclose = () => {
        console.log('[WebSocket] Disconnected');
        setState(prev => ({ ...prev, connected: false }));

        // Attempt to reconnect with exponential backoff
        if (reconnectAttemptsRef.current < maxReconnectAttempts && options.enabled !== false) {
          reconnectAttemptsRef.current += 1;
          const delay = getReconnectDelay();
          console.log(
            `[WebSocket] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`,
          );

          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        }
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('[WebSocket] Connection failed:', error);
      const errorMsg = error instanceof Error ? error.message : 'Connection failed';
      setState({ connected: false, error: errorMsg });
      callbacksRef.current?.onError?.(errorMsg);
    }
  }, [options, getReconnectDelay]);

  /**
   * Disconnect from WebSocket server
   */
  const disconnect = useCallback((): void => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close(1000, 'Client disconnect');
    }

    wsRef.current = null;
    reconnectAttemptsRef.current = 0;
  }, []);

  /**
   * Subscribe to additional datasets or transactions
   */
  const subscribe = useCallback(
    (ids: { datasetIds?: string[]; transactionIds?: string[] }): void => {
      if (!wsRef.current) {
        console.warn('[WebSocket] Not connected, cannot subscribe');
        return;
      }

      if (wsRef.current.readyState === WebSocket.CONNECTING) {
        pendingSubscriptionsRef.current.push(ids);
        return;
      }

      if (wsRef.current.readyState !== WebSocket.OPEN) {
        console.warn('[WebSocket] Not connected, cannot subscribe');
        return;
      }

      const msg = {
        type: 'subscribe',
        ...ids,
        ...(options.apiToken && { token: options.apiToken }),
      };

      wsRef.current.send(JSON.stringify(msg));
    },
    [options.apiToken],
  );

  /**
   * Send ping message to keep connection alive
   */
  const _sendPing = useCallback((): void => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    wsRef.current.send(JSON.stringify({ type: 'ping' }));
  }, []);

  // Connect on mount
  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    connected: state.connected,
    error: state.error,
    subscribe,
  };
}
