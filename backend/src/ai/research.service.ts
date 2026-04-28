import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicResearchModel } from './anthropic.config';

export interface ResearchInput {
  userQuery: string;
  budget: number;
  riskTolerance: 'low' | 'medium' | 'high';
  yieldData: Record<string, unknown>;
  whaleData: Record<string, unknown>;
  riskData: Record<string, unknown>;
  sentimentData: Record<string, unknown>;
  datasetCosts: Record<string, number>;
}

export interface ResearchReport {
  topOpportunity: {
    protocol: string;
    vault: string;
    chain: string;
    apy: number;
    riskLevel: string;
    whaleConfidence: string;
    sentimentScore: string;
  };
  reasoning: string;
  alternatives: string[];
  warnings: string[];
  rawAnalysis: string;
}

/**
 * Safely parse JSON from Claude response, handling markdown fences and prose.
 * Returns null if parsing fails after all attempts.
 */
function tryParseJson(raw: string): ResearchReport | null {
  // Attempt #1: Remove markdown fences and parse
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    return JSON.parse(cleaned) as ResearchReport;
  } catch {
    // Attempt #2: Extract first valid-looking JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as ResearchReport;
      } catch {
        // Both attempts failed
        return null;
      }
    }

    // No JSON object found
    return null;
  }
}

export async function synthesizeResearch(input: ResearchInput): Promise<ResearchReport> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `You are the Hazina Research Agent — an autonomous DeFi yield researcher. You have just purchased data from four specialised on-chain data sellers using micro-payments on Stellar. Synthesise all four datasets into a single, actionable research report for the user.

USER QUERY: "${input.userQuery}"
BUDGET: $${input.budget} USDC
RISK TOLERANCE: ${input.riskTolerance}

---
DATASET 1 — YIELD DATA (purchased for ${input.datasetCosts['yieldData'] ?? 'unknown'} USDC):
${JSON.stringify(input.yieldData, null, 2)}

---
DATASET 2 — WHALE WALLET MOVEMENTS (purchased for ${input.datasetCosts['whaleData'] ?? 'unknown'} USDC):
${JSON.stringify(input.whaleData, null, 2)}

---
DATASET 3 — RISK SCORES (purchased for ${input.datasetCosts['riskData'] ?? 'unknown'} USDC):
${JSON.stringify(input.riskData, null, 2)}

---
DATASET 4 — MARKET SENTIMENT (purchased for ${input.datasetCosts['sentimentData'] ?? 'unknown'} USDC):
${JSON.stringify(input.sentimentData, null, 2)}

---
INSTRUCTIONS:
1. Identify the single best USDC yield opportunity that matches the user's risk tolerance and budget.
2. Cross-reference: does whale activity confirm confidence? Does sentiment support? Does risk score match tolerance?
3. Flag any red flags or warnings.
4. Suggest 2 alternatives if the top pick doesn't suit.

Respond ONLY with valid JSON in this exact shape (no markdown fences):
{
  "topOpportunity": {
    "protocol": "Protocol name",
    "vault": "Vault or pool name",
    "chain": "Chain name",
    "apy": 7.2,
    "riskLevel": "Low | Medium | High",
    "whaleConfidence": "High | Medium | Low | Neutral",
    "sentimentScore": "Bullish | Neutral | Bearish"
  },
  "reasoning": "2-3 sentence explanation of why this is the best pick, citing specific data from the datasets",
  "alternatives": ["Alternative 1: brief description", "Alternative 2: brief description"],
  "warnings": ["Warning if any — empty array if none"],
  "rawAnalysis": "Concise paragraph synthesising all four data sources"
}`;

  // First attempt
  const response = await client.messages.create({
    model: getAnthropicResearchModel(),
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  // Try to parse the initial response
  let parsed = tryParseJson(raw);
  if (parsed !== null) {
    return parsed;
  }

  // Retry with stricter prompt
  console.warn('[synthesizeResearch] Initial parse failed, retrying with stricter prompt');

  const stricterPrompt = `${prompt}

CRITICAL: Return ONLY valid JSON. Do not include explanations, markdown, code fences, or any extra text. Just the JSON object.`;

  const retryResponse = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: stricterPrompt }],
  });

  const retryRaw = retryResponse.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  parsed = tryParseJson(retryRaw);
  if (parsed !== null) {
    return parsed;
  }

  // Both attempts failed
  throw new Error(
    `Failed to parse Claude JSON response after retry. Raw output: ${raw.slice(0, 500)}`
  );
}

/**
 * Parses risk tolerance from a natural-language query.
 * e.g. "medium risk" → 'medium', "low risk" → 'low', default → 'medium'
 */
export function parseRiskTolerance(query: string): 'low' | 'medium' | 'high' {
  const q = query.toLowerCase();
  if (q.includes('low risk') || q.includes('safe') || q.includes('conservative')) return 'low';
  if (q.includes('high risk') || q.includes('aggressive') || q.includes('degen')) return 'high';
  return 'medium';
}

/**
 * Parses a budget in USDC from a natural-language query.
 * e.g. "$500", "500 USDC", "500 budget" → 500
 */
export function parseBudget(query: string): number {
  const match = query.match(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(usdc|usd|budget)?/i);
  if (match) {
    const parsed = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return 500; // default
}
