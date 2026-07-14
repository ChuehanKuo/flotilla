import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { projects: ['kernel', 'cli', 'tui', 'observatory'] } });
