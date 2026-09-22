import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  define: {
    __ORBITRA_MICROSOFT_CLIENT_ID__: JSON.stringify(process.env.ORBITRA_MICROSOFT_CLIENT_ID ?? ''),
  },
})
