import { defineConfig } from 'vitest/config';

/**
 * Vitest config for pure-logic unit tests. Component / template tests
 * still go through Karma via `ng test`; this is for the standalone
 * helpers (markdown rendering, mermaid validation hints, route-param
 * normalization, etc.) that don't need the Angular TestBed.
 *
 * Test files: src/**\/*.spec.ts (the .spec.ts extension distinguishes
 * them from Karma's .test.ts convention so the two runners don't fight
 * over the same files).
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'jsdom',
    globals: false,
  },
});
