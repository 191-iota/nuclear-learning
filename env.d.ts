/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where Ollama answers. Optional: api.ts falls back to http://127.0.0.1:11434/v1. */
  readonly VITE_OLLAMA_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
