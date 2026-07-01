// Model price + capability map. Used for request shaping (does it take `reasoning_effort`?)
// and for per-record cost pricing (each scan can run on a different model now).
export interface ModelInfo {
  id: string;
  label: string;
  in: number; // $ per 1M input tokens
  out: number; // $ per 1M output tokens
  effort: boolean; // reasoning model: takes the reasoning_effort parameter
}

// OpenAI GPT-5 family. Prices in $/1M tokens (editable in Presets). All are reasoning models
// (they take reasoning_effort), vision-capable, and support strict json_schema structured output.
export const MODELS: ModelInfo[] = [
  { id: 'gpt-5', label: 'GPT-5', in: 1.25, out: 10, effort: true },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', in: 0.25, out: 2, effort: true },
  { id: 'gpt-5-nano', label: 'GPT-5 nano', in: 0.05, out: 0.4, effort: true },
];

export const EFFORTS = ['minimal', 'low', 'medium', 'high'];

export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}
