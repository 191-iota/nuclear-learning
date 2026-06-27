// Model price + capability map. Used for request shaping (does it take `effort`?)
// and for per-record cost pricing (each scan can run on a different model now).
export interface ModelInfo {
  id: string;
  label: string;
  in: number; // $ per 1M input tokens
  out: number; // $ per 1M output tokens
  effort: boolean; // supports the effort parameter + adaptive thinking
}

export const MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', in: 5, out: 25, effort: true },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', in: 3, out: 15, effort: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', in: 1, out: 5, effort: false },
];

export const EFFORTS = ['low', 'medium', 'high', 'max'];

export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}
