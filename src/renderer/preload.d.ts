/**
 * Ambient declaration for the context bridge.
 *
 * `src/main/preload.ts` is the single sanctioned exception to "the renderer
 * never imports from main/" (see `import/no-restricted-paths` in .eslintrc.js):
 * the preload script is the shared boundary, so its *type* is shared too.
 *
 * Do not reach for `window.assistant` directly in components — go through
 * `src/renderer/lib/ipc.ts`, which unwraps replies and handles the case where
 * the bridge is missing (tests, SSR render checks).
 */
import type { AssistantBridge } from '../main/preload';

declare global {
  // eslint-disable-next-line no-unused-vars
  interface Window {
    /** Undefined when the app is rendered outside Electron (jest, SSR check). */
    assistant?: AssistantBridge;
  }
}

export {};
