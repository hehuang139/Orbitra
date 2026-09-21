import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createAccountApi } from './server/account-api.mjs'

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'advance-account-api',
      configureServer(server) {
        const api = createAccountApi()
        server.httpServer?.once('close', api.close)
        server.middlewares.use((request, response, next) => {
          if (request.url?.startsWith('/api/')) void api(request, response, next)
          else next()
        })
      },
      configurePreviewServer(server) {
        const api = createAccountApi()
        server.httpServer?.once('close', api.close)
        server.middlewares.use((request, response, next) => {
          if (request.url?.startsWith('/api/')) void api(request, response, next)
          else next()
        })
      },
    },
  ],
  server: { headers, port: 5173 },
  preview: { headers, port: 4173 },
})
