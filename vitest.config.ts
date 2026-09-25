import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Mirrors tsconfig "paths" — vitest does not read tsconfig paths on its own.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Imaging suites render full proofs; give slow CI runners headroom.
    testTimeout: 20_000,
  },
});
