import js from '@eslint/js'
import globals from 'globals'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Copia para Deno/Supabase; el lint de Node cubre API y utilidades Node.
  globalIgnores(['scripts/arca/afip-emit.dashboard.js']),
  {
    files: ['src/**/*.js', 'scripts/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
])
