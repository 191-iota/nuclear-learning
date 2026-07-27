// Model price + capability map. Used for request shaping (does it take `reasoning_effort`?)
// and for per-record cost pricing (each scan can run on a different model now).
export interface ModelInfo {
  id: string;
  label: string;
  in: number; // $ per 1M input tokens
  cachedIn: number; // $ per 1M cached input tokens (the stable prompt prefix re-read)
  out: number; // $ per 1M output tokens
  effort: boolean; // reasoning model: takes the reasoning_effort parameter
}

// OpenAI reasoning models. Prices in $/1M tokens, pinned here (the Usage tab prices
// every record from this table), verified 2026-07-26 against
// developers.openai.com/api/docs/pricing. All take reasoning_effort, are
// vision-capable, and support strict json_schema structured output. The GPT-5.6
// family (Sol/Terra/Luna, 2026-07-09) additionally bills prompt-cache WRITES at
// 1.25x input; the usage line cannot see write tokens, so first-time prefixes are
// undercounted by up to a quarter of their input price. Terra is the default first
// entry: it costs exactly what GPT-5.4 bills today and modelInfo() falls back to
// MODELS[0] for unknown ids.
export const MODELS: ModelInfo[] = [
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', in: 2.5, cachedIn: 0.25, out: 15, effort: true },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', in: 1, cachedIn: 0.1, out: 6, effort: true },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', in: 5, cachedIn: 0.5, out: 30, effort: true },
  { id: 'gpt-5.4', label: 'GPT-5.4', in: 2.5, cachedIn: 0.25, out: 15, effort: true },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', in: 0.75, cachedIn: 0.075, out: 4.5, effort: true },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', in: 0.2, cachedIn: 0.02, out: 1.25, effort: true },
];

// 'max' is a GPT-5.6 level; the 5.4 family tops out at xhigh and rejects it.
export const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}
