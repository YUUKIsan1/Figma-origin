import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['node_modules/**', '.wrangler/**', 'dist/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        fetch: 'readonly',
        location: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
);
