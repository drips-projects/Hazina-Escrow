import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: mockCreate,
    },
  })),
}));

import {
  parseBudget,
  parseRiskTolerance,
  synthesizeResearch,
} from './research.service';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { parseBudget, parseRiskTolerance, synthesizeResearch, type ResearchReport } from './research.service';
import Anthropic from '@anthropic-ai/sdk';

// Mock Anthropic
vi.mock('@anthropic-ai/sdk');

describe('parseRiskTolerance', () => {
  it('returns low for low-risk synonyms', () => {
    expect(parseRiskTolerance('Need a safe and conservative strategy')).toBe('low');
    expect(parseRiskTolerance('Show me LOW RISK vaults')).toBe('low');
  });

  it('returns high for aggressive/degen language', () => {
    expect(parseRiskTolerance('I want aggressive yield plays')).toBe('high');
    expect(parseRiskTolerance('Give me degen opportunities')).toBe('high');
  });

  it('defaults to medium when no clear risk signal exists', () => {
    expect(parseRiskTolerance('Find balanced opportunities for me')).toBe('medium');
  });
});

describe('parseBudget', () => {
  it('parses comma-separated budget values', () => {
    expect(parseBudget('Best low risk USDC yield with $1,250 budget')).toBe(1250);
  });

  it('parses decimal values and rounds to nearest whole USDC', () => {
    expect(parseBudget('Allocate 99.6 USDC to this strategy')).toBe(100);
  });

  it('falls back to default when no budget is found', () => {
    expect(parseBudget('Find safe stablecoin pools')).toBe(500);
  });
});

describe('synthesizeResearch', () => {
  const originalAnthropicModel = process.env.ANTHROPIC_MODEL;
  const originalAnthropicResearchModel = process.env.ANTHROPIC_RESEARCH_MODEL;

  beforeEach(() => {
    mockCreate.mockReset();
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_RESEARCH_MODEL;
  });

  afterEach(() => {
    if (originalAnthropicModel === undefined) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = originalAnthropicModel;
    }

    if (originalAnthropicResearchModel === undefined) {
      delete process.env.ANTHROPIC_RESEARCH_MODEL;
    } else {
      process.env.ANTHROPIC_RESEARCH_MODEL = originalAnthropicResearchModel;
    }
  });

  it('uses ANTHROPIC_RESEARCH_MODEL when configured', async () => {
    process.env.ANTHROPIC_RESEARCH_MODEL = 'claude-custom-research-model';
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            topOpportunity: {
              protocol: 'Aave',
              vault: 'USDC Core',
              chain: 'Ethereum',
              apy: 7.2,
              riskLevel: 'Low',
              whaleConfidence: 'High',
              sentimentScore: 'Bullish',
            },
            reasoning: 'Best fit.',
            alternatives: ['Alt 1', 'Alt 2'],
            warnings: [],
            rawAnalysis: 'Synthesis.',
          }),
        },
      ],
    });

    const result = await synthesizeResearch({
      userQuery: 'Find a safe USDC vault',
      budget: 500,
      riskTolerance: 'low',
      yieldData: {},
      whaleData: {},
      riskData: {},
      sentimentData: {},
      datasetCosts: {},
    });

    expect(result.topOpportunity.protocol).toBe('Aave');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-custom-research-model' }),
    );
  });

  it('falls back to ANTHROPIC_MODEL when research override is unset', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-shared-model';
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            topOpportunity: {
              protocol: 'Compound',
              vault: 'USDC Vault',
              chain: 'Base',
              apy: 6.1,
              riskLevel: 'Medium',
              whaleConfidence: 'Neutral',
              sentimentScore: 'Neutral',
            },
            reasoning: 'Shared fallback.',
            alternatives: [],
            warnings: [],
            rawAnalysis: 'Fallback.',
          }),
        },
      ],
    });

    await synthesizeResearch({
      userQuery: 'Find a balanced USDC vault',
      budget: 500,
      riskTolerance: 'medium',
      yieldData: {},
      whaleData: {},
      riskData: {},
      sentimentData: {},
      datasetCosts: {},
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-shared-model' }),
    );
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockValidReport: ResearchReport = {
    topOpportunity: {
      protocol: 'Aave',
      vault: 'USDC Lending Pool',
      chain: 'Ethereum',
      apy: 7.2,
      riskLevel: 'Low',
      whaleConfidence: 'High',
      sentimentScore: 'Bullish',
    },
    reasoning: 'Strong fundamentals with whale support',
    alternatives: ['Alternative 1', 'Alternative 2'],
    warnings: [],
    rawAnalysis: 'Comprehensive analysis',
  };

  const mockResearchInput = {
    userQuery: 'Find best yield',
    budget: 1000,
    riskTolerance: 'medium' as const,
    yieldData: { test: 'data' },
    whaleData: { test: 'data' },
    riskData: { test: 'data' },
    sentimentData: { test: 'data' },
    datasetCosts: { yieldData: 10, whaleData: 10, riskData: 10, sentimentData: 10 },
  };

  it('parses valid JSON from Claude on first attempt', async () => {
    const mockCreateMessage = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify(mockValidReport),
        },
      ],
    });

    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: {
            create: mockCreateMessage,
          },
        } as any)
    );

    const result = await synthesizeResearch(mockResearchInput);
    expect(result).toEqual(mockValidReport);
    expect(mockCreateMessage).toHaveBeenCalledOnce();
  });

  it('handles JSON wrapped in markdown fences', async () => {
    const wrappedResponse = `\`\`\`json\n${JSON.stringify(mockValidReport)}\n\`\`\``;

    const mockCreateMessage = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: wrappedResponse,
        },
      ],
    });

    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: {
            create: mockCreateMessage,
          },
        } as any)
    );

    const result = await synthesizeResearch(mockResearchInput);
    expect(result).toEqual(mockValidReport);
    expect(mockCreateMessage).toHaveBeenCalledOnce();
  });

  it('handles JSON embedded in prose', async () => {
    const proseResponse = `Here is your analysis:\n\n${JSON.stringify(mockValidReport)}\n\nI hope this helps!`;

    const mockCreateMessage = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: proseResponse,
        },
      ],
    });

    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: {
            create: mockCreateMessage,
          },
        } as any)
    );

    const result = await synthesizeResearch(mockResearchInput);
    expect(result).toEqual(mockValidReport);
    expect(mockCreateMessage).toHaveBeenCalledOnce();
  });

  it('retries with stricter prompt on parse failure', async () => {
    const invalidResponse = 'This is completely invalid JSON {broken';
    const mockCreateMessage = vi.fn();

    // First call fails, second call succeeds
    mockCreateMessage
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: invalidResponse,
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockValidReport),
          },
        ],
      });

    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: {
            create: mockCreateMessage,
          },
        } as any)
    );

    const result = await synthesizeResearch(mockResearchInput);
    expect(result).toEqual(mockValidReport);
    expect(mockCreateMessage).toHaveBeenCalledTimes(2);
  });

  it('throws helpful error when both parsing attempts fail', async () => {
    const invalidResponse = 'Completely invalid JSON that cannot be parsed {broken';
    const mockCreateMessage = vi.fn();

    // Both calls return unparseable content
    mockCreateMessage
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: invalidResponse,
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: invalidResponse,
          },
        ],
      });

    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: {
            create: mockCreateMessage,
          },
        } as any)
    );

    await expect(synthesizeResearch(mockResearchInput)).rejects.toThrow(
      /Failed to parse Claude JSON response after retry/
    );
    expect(mockCreateMessage).toHaveBeenCalledTimes(2);
  });

  it('includes raw output in error message (first 500 chars)', async () => {
    const longInvalid = 'x'.repeat(1000) + ' invalid json';
    const mockCreateMessage = vi.fn();

    mockCreateMessage
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: longInvalid,
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: longInvalid,
          },
        ],
      });

    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: {
            create: mockCreateMessage,
          },
        } as any)
    );

    try {
      await synthesizeResearch(mockResearchInput);
      expect.fail('Should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('Failed to parse Claude JSON response after retry');
      expect(message).toContain(longInvalid.slice(0, 500));
      expect(message.length).toBeLessThan(longInvalid.length); // Ensure it's truncated
    }
  });
});
