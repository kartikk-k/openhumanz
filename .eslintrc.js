const fs = require('fs');
const path = require('path');

/**
 * Layering, from ARCHITECTURE.md:
 *
 *   shared/            imports nothing from main/ or renderer/
 *     ^
 *   main/infra/        wraps external deps
 *     ^
 *   main/modules/<name>/ self-contained; MUST NOT import each other
 *     ^
 *   main/services/     coordinates across modules
 *     ^
 *   main/main.ts       electron shell
 *
 *   renderer/          depends only on shared/
 *
 * These are lint errors, not conventions.
 */

/**
 * One zone per module directory, generated from the filesystem: every module
 * is forbidden from importing every *other* module. Doing it this way means
 * adding a module never requires editing this file, which is the same promise
 * the module contract makes.
 */
function crossModuleZones() {
  const modulesDir = path.join(__dirname, 'src', 'main', 'modules');
  let names = [];
  try {
    names = fs
      .readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  return names
    .map((name) => ({
      target: `./src/main/modules/${name}`,
      from: names
        .filter((other) => other !== name)
        .map((other) => `./src/main/modules/${other}`),
      message:
        'Modules must not import each other. Go through the event bus (ctx.events) or a service in src/main/services/.',
    }))
    .filter((zone) => zone.from.length > 0);
}

module.exports = {
  // `erb` brings the base rules; `prettier` (config) turns off any stylistic
  // rules that would fight Prettier; `plugin:prettier/recommended` runs Prettier
  // AS an ESLint rule (with the Tailwind class-sort plugin picked up from the
  // Prettier config), so `eslint --fix` — and the ESLint "Format Document" /
  // fixAll-on-save — apply Prettier formatting and sort Tailwind classes.
  extends: ['erb', 'plugin:prettier/recommended'],
  /**
   * Pinned explicitly. `eslint-config-erb` carries its own nested
   * `@typescript-eslint/parser@6`, which emits the pre-v8 AST for mapped types
   * (`typeParameter` rather than `key`). Paired with the project's
   * `@typescript-eslint/eslint-plugin@8` that makes `no-unused-vars` *crash* on
   * any file containing a mapped type. Declaring the parser here resolves it
   * from the project root instead, so both halves are v8.
   */
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  rules: {
    // A temporary hack related to IDE not resolving correct package.json
    'import/no-extraneous-dependencies': 'off',
    'react/react-in-jsx-scope': 'off',
    'react/jsx-filename-extension': 'off',
    // Requiring an explicit type on every <button> is noise; default is fine.
    'react/button-has-type': 'off',
    'import/extensions': 'off',
    'import/no-unresolved': 'off',
    'import/no-import-module-exports': 'off',
    // Named exports are fine for util/constant modules
    'import/prefer-default-export': 'off',
    'no-shadow': 'off',
    '@typescript-eslint/no-shadow': 'error',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': 'error',

    /*
     * Airbnb rules that assume an ES5 transpile target or plain JS. We ship on
     * Electron's Node and TypeScript, so these cost readability and buy nothing.
     */
    // for..of over a Map/Set is the right tool; the ban exists to avoid a
    // regenerator-runtime polyfill we do not have.
    'no-restricted-syntax': [
      'error',
      {
        selector: 'ForInStatement',
        message:
          'for..in iterates the prototype chain. Use Object.keys/entries.',
      },
      { selector: 'LabeledStatement', message: 'Labels obscure control flow.' },
      { selector: 'WithStatement', message: '`with` is forbidden.' },
    ],
    'no-continue': 'off',
    // TypeScript already resolves identifiers, and `no-undef` does not know
    // about ambient namespaces like `NodeJS`.
    'no-undef': 'off',
    // `void promise` is how we mark a deliberately un-awaited call.
    'no-void': ['error', { allowAsStatement: true }],
    // The TS-aware version understands that type positions are hoisted.
    'no-use-before-define': 'off',
    '@typescript-eslint/no-use-before-define': [
      'error',
      { functions: false, typedefs: false, ignoreTypeReferences: true },
    ],
    // SQLite columns are snake_case; the mapping layer has to name them.
    camelcase: 'off',
    // `_migrations` is a real table name.
    'no-underscore-dangle': 'off',
    'prefer-destructuring': [
      'error',
      { VariableDeclarator: { object: false, array: false } },
    ],

    'import/no-restricted-paths': [
      'error',
      {
        basePath: __dirname,
        zones: [
          /* ---- shared/ is the floor ---- */
          {
            target: './src/shared',
            from: ['./src/main', './src/renderer', './src/shim'],
            message:
              'shared/ is the floor of the dependency graph: types and zod schemas only, imported by everyone, importing no one.',
          },

          /* ---- renderer/ never reaches into main/ ---- */
          {
            target: './src/renderer',
            from: './src/main',
            except: ['./preload.ts'],
            message:
              'The renderer talks to main over the IPC contract in src/shared/ipc.ts and the preload bridge. It never imports main code.',
          },
          /* ---- and main/ never reaches into renderer/ ---- */
          {
            target: './src/main',
            from: './src/renderer',
            message:
              'Main must not import renderer code. Send data over IPC instead.',
          },

          /* ---- infra/ is below everything in main/ ---- */
          {
            target: './src/main/infra',
            from: ['./src/main/modules', './src/main/services'],
            message:
              'infra/ wraps external dependencies and must not know about modules or services.',
          },

          /* ---- modules/ sit below services/ and the shell ---- */
          {
            target: './src/main/modules',
            from: ['./src/main/services', './src/main/main.ts'],
            message:
              'Modules must not import services or the electron shell. A module receives everything it may use through ctx.',
          },

          /* ---- modules must not import each other ---- */
          ...crossModuleZones(),

          /* ---- the shim is standalone ---- */
          {
            target: './src/shim',
            from: ['./src/main', './src/renderer'],
            message:
              'The shim is spawned as its own process and bundled separately. It may only use src/shared/ and node builtins.',
          },
        ],
      },
    ],
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  settings: {
    'import/resolver': {
      // See https://github.com/benmosher/eslint-plugin-import/issues/1396#issuecomment-575727774 for line below
      node: {
        extensions: ['.js', '.jsx', '.ts', '.tsx'],
        moduleDirectory: ['node_modules', 'src/'],
      },
      typescript: {},
    },
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx'],
    },
  },
};
