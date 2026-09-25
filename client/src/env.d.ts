/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_INFO__: { product: string; version: string; commit: string | null; tree: string | null; dirty: boolean | null; builtAt: string; node: string };

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
