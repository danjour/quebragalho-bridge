import n from 'eslint-plugin-n';

// Inline copy of the `recommended` preset from `@eslint/js` v10
// (https://unpkg.com/@eslint/js@10.0.1/src/configs/eslint-recommended.js).
// It is inlined here because `@eslint/js` is not a direct dependency of this
// project; if it is ever added as a devDependency, this block can be replaced
// with `import js from '@eslint/js'` + `js.configs.recommended`.
const jsRecommended = {
  name: 'eslint/recommended (inlined from @eslint/js v10)',
  rules: {
    'constructor-super': 'error',
    'for-direction': 'error',
    'getter-return': 'error',
    'no-async-promise-executor': 'error',
    'no-case-declarations': 'error',
    'no-class-assign': 'error',
    'no-compare-neg-zero': 'error',
    'no-cond-assign': 'error',
    'no-const-assign': 'error',
    'no-constant-binary-expression': 'error',
    'no-constant-condition': 'error',
    'no-control-regex': 'error',
    'no-debugger': 'error',
    'no-delete-var': 'error',
    'no-dupe-args': 'error',
    'no-dupe-class-members': 'error',
    'no-dupe-else-if': 'error',
    'no-dupe-keys': 'error',
    'no-duplicate-case': 'error',
    'no-empty': 'error',
    'no-empty-character-class': 'error',
    'no-empty-pattern': 'error',
    'no-empty-static-block': 'error',
    'no-ex-assign': 'error',
    'no-extra-boolean-cast': 'error',
    'no-fallthrough': 'error',
    'no-func-assign': 'error',
    'no-global-assign': 'error',
    'no-import-assign': 'error',
    'no-invalid-regexp': 'error',
    'no-irregular-whitespace': 'error',
    'no-loss-of-precision': 'error',
    'no-misleading-character-class': 'error',
    'no-new-native-nonconstructor': 'error',
    'no-nonoctal-decimal-escape': 'error',
    'no-obj-calls': 'error',
    'no-octal': 'error',
    'no-prototype-builtins': 'error',
    'no-redeclare': 'error',
    'no-regex-spaces': 'error',
    'no-self-assign': 'error',
    'no-setter-return': 'error',
    'no-shadow-restricted-names': 'error',
    'no-sparse-arrays': 'error',
    'no-this-before-super': 'error',
    'no-unassigned-vars': 'error',
    'no-undef': 'error',
    'no-unexpected-multiline': 'error',
    'no-unreachable': 'error',
    'no-unsafe-finally': 'error',
    'no-unsafe-negation': 'error',
    'no-unsafe-optional-chaining': 'error',
    'no-unused-labels': 'error',
    'no-unused-private-class-members': 'error',
    'no-unused-vars': 'error',
    'no-useless-assignment': 'error',
    'no-useless-backreference': 'error',
    'no-useless-catch': 'error',
    'no-useless-escape': 'error',
    'no-with': 'error',
    'preserve-caught-error': 'error',
    'require-yield': 'error',
    'use-isnan': 'error',
    'valid-typeof': 'error',
  },
};

export default [
  {
    ignores: ['node_modules/', 'cobertura/', 'tmp/'],
  },
  jsRecommended,
  {
    ...n.configs['flat/recommended-module'],
    settings: {
      node: {
        // Target Node.js 18 (matches "engines.node" in package.json).
        version: '>=18.0.0',
      },
    },
    rules: {
      // `fetch` funciona sem flag desde o Node 18 e `node:test` existe desde a
      // linha 18.x; o plugin só reconhece estabilidade a partir de versões
      // mais novas, então estas duas features são ignoradas aqui.
      'n/no-unsupported-features/node-builtins': [
        'error',
        { ignores: ['fetch', 'test'] },
      ],
      // `catch {}` intencional em fixtures/testes (falha esperada e ignorada).
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // `process.exit()` é deliberado nesses pontos: o shutdown do bridge força
    // saída quando o encerramento gracioso estoura o prazo, e os scripts de
    // suporte são CLIs de linha de comando.
    files: ['index.mjs', 'scripts/**'],
    rules: {
      'n/no-process-exit': 'off',
    },
  },
];
