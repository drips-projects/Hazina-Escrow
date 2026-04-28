import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicModel } from '../ai/anthropic.config';
import { getAllCircuitBreakerStats } from './circuit-breaker';

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  service: string;
  checks: {
    anthropic: {
      status: 'ok' | 'error' | 'unavailable';
      message?: string;
      responseTime?: number;
    };
  };
  circuitBreakers: ReturnType<typeof getAllCircuitBreakerStats>;
}

export async function checkHealth(): Promise<HealthStatus> {
  const timestamp = new Date().toISOString();
  const checks = {
    anthropic: await checkAnthropicService(),
  };

  const hasError = Object.values(checks).some(
    check => check.status === 'error' || check.status === 'unavailable',
  );

  const status: HealthStatus['status'] = hasError ? 'degraded' : 'healthy';

  return {
    status,
    timestamp,
    service: 'Hazina Escrow API',
    checks,
    circuitBreakers: getAllCircuitBreakerStats(),
  };
}

async function checkAnthropicService(): Promise<{
  status: 'ok' | 'error' | 'unavailable';
  message?: string;
  responseTime?: number;
}> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      status: 'unavailable',
      message: 'ANTHROPIC_API_KEY not configured',
    };
  }

  const startTime = Date.now();
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Make a lightweight API call to verify connectivity
    // Using Messages API with minimal tokens to check service availability
    await client.messages.countTokens({
      model: getAnthropicModel(),
      messages: [{ role: 'user', content: 'health check' }],
    });

    const responseTime = Date.now() - startTime;
    return {
      status: 'ok',
      responseTime,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      status: 'error',
      message,
      responseTime,
    };
  }
}
