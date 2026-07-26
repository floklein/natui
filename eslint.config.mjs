import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config for the whole workspace. The native hosts (Swift/C#) and every
 * build output are excluded; everything else that ships JavaScript or
 * TypeScript is linted.
 *
 * Type-aware rules run only on the packages that have a tsconfig covering
 * their sources, so a single `pnpm lint` stays fast enough to be a pre-commit
 * habit rather than a CI-only chore.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.source/**',
      '**/.natui/**',
      'docs/next-env.d.ts',
      'packages/create-natui-app/template/**',
      // Scratch fixtures the dev-server integration tests mkdtemp under the
      // package root; present only after a killed run.
      'packages/*/natui-dev-*/**',
      'hosts/**',
      'screenshots/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---------------------------------------------------------------------
  // Shared rules
  // ---------------------------------------------------------------------
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // The whole point of adding a linter here: unused imports/locals were
      // invisible because tsconfig has noUnusedLocals off.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-unused-private-class-members': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': ['error', 'properties'],
      'no-console': 'off',
      // Empty catch blocks are a real pattern here (best-effort cleanup), but
      // they must be written `catch { /* reason */ }` so the intent is stated.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },

  // ---------------------------------------------------------------------
  // Type-aware rules for the published package
  // ---------------------------------------------------------------------
  {
    files: [
      'packages/natui/src/**/*.ts',
      'packages/natui/src/**/*.tsx',
      'packages/natui-dev/src/**/*.ts',
    ],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [],
          defaultProject: 'packages/natui/tsconfig.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Deliberately off. Several variables here are declared in one scope and
      // assigned from a callback (`phase` in inproc.ts, `startupCloseError` in
      // run.ts); TypeScript narrows those to their initial literal type, so the
      // rule reports live guards as "always falsy". Enabling it would invite
      // someone to delete real protection.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  // ---------------------------------------------------------------------
  // Tests: looser, they legitimately poke at internals
  // ---------------------------------------------------------------------
  {
    files: ['**/test/**', '**/*.test.*'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // ---------------------------------------------------------------------
  // Plain-JS tooling and example probes
  // ---------------------------------------------------------------------
  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  // ---------------------------------------------------------------------
  // Docs site (React / Next.js)
  // ---------------------------------------------------------------------
  {
    files: ['docs/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
