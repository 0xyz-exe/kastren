import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/**/*.test.ts', 'services/**/*.test.ts', 'apps/**/*.test.ts'], testTimeout: 10_000, hookTimeout: 10_000 } });
