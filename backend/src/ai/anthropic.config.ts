export const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-haiku-20241022';

function normalizeModel(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getAnthropicModel(): string {
  return normalizeModel(process.env.ANTHROPIC_MODEL) ?? DEFAULT_ANTHROPIC_MODEL;
}

export function getAnthropicResearchModel(): string {
  return normalizeModel(process.env.ANTHROPIC_RESEARCH_MODEL) ?? getAnthropicModel();
}
