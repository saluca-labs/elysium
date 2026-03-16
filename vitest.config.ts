import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Allow TypeScript source files to be resolved when imported with .js extensions
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  test: {
    globals: false,
  },
})
