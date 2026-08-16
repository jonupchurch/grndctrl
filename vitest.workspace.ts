import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: 'core',
      root: './packages/core',
      globals: true,
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'mcp',
      root: './packages/mcp',
      globals: true,
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      // The privacy audits (T169-T171). They live at the repo root rather than
      // in a package because they audit the *product*, not a layer of it: the
      // real data directory, the shipped dependency tree, a captured session.
      name: 'audits',
      root: './scripts',
      globals: true,
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'launcher',
      root: './packages/launcher',
      globals: true,
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'cli',
      root: './packages/cli',
      globals: true,
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'desktop',
      root: './packages/desktop',
      globals: true,
      environment: 'node',
      include: ['test/**/*.test.ts'],
      // Playwright owns test/e2e — it drives a real Electron build and must not
      // be picked up by the unit runner.
      exclude: ['test/e2e/**'],
    },
  },
])
