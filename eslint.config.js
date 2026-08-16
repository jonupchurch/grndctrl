// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * The two rules that matter here are the boundary rules (T009, T010). They are
 * not style — they are how two constitution gates stay enforceable:
 *
 *   XVIII — the correlation engine must be testable with no Electron, no
 *           network, and no display. That holds only while `core` cannot import
 *           anything from Electron or a UI framework.
 *   XII   — the API and MCP server are thin adapters. That holds only while an
 *           adapter cannot reach past the operation registry into providers,
 *           stores, correlation, or drift.
 *
 * Both are cheap to state now and expensive to retrofit: added after the fact,
 * they document a boundary that has already been crossed.
 */

const CORE_FORBIDDEN = [
  { name: 'electron', message: 'core must not import electron (constitution XVIII).' },
  { name: 'react', message: 'core must not import react (constitution XVIII).' },
  { name: 'react-dom', message: 'core must not import react-dom (constitution XVIII).' },
  {
    name: '@tanstack/react-query',
    message: 'core must not import UI libraries (constitution XVIII).',
  },
]

const BELOW_THE_REGISTRY = [
  {
    group: ['**/providers/**', '**/store/**', '**/correlation/**', '**/drift/**'],
    message:
      'Adapters may import the operation registry and nothing below it (constitution XII). ' +
      'If this needs new behaviour, add an operation to the registry — not logic to the adapter.',
  },
  {
    group: ['@grndctrl/core/providers', '@grndctrl/core/store'],
    message: 'Adapters reach core through its registry export only (constitution XII).',
  },
]

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'resources/**', '.specify/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },

  // T009 — core is framework-free. Enforced, not requested.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: CORE_FORBIDDEN }],
    },
  },

  // T010 — adapters stay above the registry line.
  {
    files: [
      'packages/core/src/adapters/**/*.ts',
      'packages/mcp/src/**/*.ts',
      'packages/desktop/src/main/ipc.ts',
      'packages/desktop/src/preload/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: BELOW_THE_REGISTRY }],
    },
  },

  // The renderer is untrusted: it renders provider-supplied strings and must
  // never hold anything worth stealing. No Node, no direct provider access.
  {
    files: ['packages/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'The renderer reaches main through the preload bridge.' },
            { name: 'better-sqlite3', message: 'The renderer never opens a database.' },
            {
              name: '@grndctrl/core',
              // Types only. `import type` is erased before the bundler sees it,
              // so no core code can reach a sandboxed process -- which is what
              // this rule is actually protecting. Banning the types too bought
              // nothing and cost correctness: the renderer kept a hand-written
              // copy of the domain shapes, and it drifted. It read `aheadBy`,
              // `behindBy` and `repoKey`, none of which exist in core, and typed
              // `unpushedCommitCount` as non-null when null is how core says
              // "never pushed". All four typechecked. All four were wrong.
              allowTypeImports: true,
              message: 'The renderer is an IPC client: import type only, never values.',
            },
          ],
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'child_process', 'os', 'crypto'],
              message: 'The renderer has no Node access (contextIsolation, sandbox).',
            },
          ],
        },
      ],
    },
  },

  // Node entry points: `bin/` scripts are plain JS run by node, so the Node
  // globals are real rather than assumed.
  {
    files: ['**/bin/*.js', '**/scripts/**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      // `fetch` is a global from Node 18 on, and the engines field requires 22.
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
      },
    },
  },

  // `.cjs` under `scripts/` is CommonJS on purpose, not by accident.
  // `egress-recorder.cjs` is loaded through `--require`, which predates the
  // module loader and is the only way to be in a process before it starts
  // making requests — so `require` there is the mechanism rather than a habit.
  {
    files: ['**/scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Tests may reach anywhere — they exist to inspect the internals the rules
  // above protect, including asserting that the boundaries hold.
  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
