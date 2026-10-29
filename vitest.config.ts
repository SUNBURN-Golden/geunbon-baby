import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    // Forks write transformed modules to /tmp even with both caches disabled.
    // Keep the registry's memory-only review tests reproducible on a read-only FS.
    projects: [
      { extends: true, test: { name: 'source-registry', include: ['tests/source-registry-*.test.ts'], pool: 'threads' } },
      { extends: true, test: { name: 'existing', include: ['tests/**/*.test.ts'], exclude: ['tests/source-registry-*.test.ts'], pool: 'forks' } },
    ],
  },
});
