// The models the app offers, and what a request to one has to look like. They all run
// on this machine through Ollama, so nothing here is a price: what used to be a rate
// card is now the shipped list behind the model boxes in Presets and the chat's own
// picker, plus the one flag that changes a request.
//
// `effort` says the id takes `reasoning_effort`, which Ollama reads as how long the
// model thinks before it answers. Every Gemma 4 build takes it, and the app sends it on
// every request, 'none' included: leaving it out is not "no thinking" but the model's
// own default, which is to think (api.ts).
//
// Pull anything else and type its id into Presets; the list is a set of suggestions,
// not a gate. `ollama list` is the authority on what this machine can actually answer.
export interface ModelInfo {
  id: string;
  label: string;
  effort: boolean;
}

// E4B is the default first entry and what modelInfo() falls back to for an unknown id:
// it reads handwriting well, answers a page in seconds, and leaves enough of 16 GB for
// the rest of the machine. 12B is the one to switch to for a hard page when you can
// wait; the QAT build of E4B trades a little quality for a smaller footprint.
export const MODELS: ModelInfo[] = [
  { id: 'gemma4:e4b', label: 'Gemma 4 E4B', effort: true },
  { id: 'gemma4:12b', label: 'Gemma 4 12B', effort: true },
  { id: 'gemma4:e4b-it-qat', label: 'Gemma 4 E4B (QAT)', effort: true },
];

// What Ollama accepts. 'none' is the one that turns thinking off outright; the rest all
// turn it on, and on a page of handwriting they cost about five times the wall clock.
export const EFFORTS = ['none', 'low', 'medium', 'high'];

export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}
