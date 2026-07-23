import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('/three/')) return 'vendor-three'
          if (id.includes('/lightweight-charts/')) return 'vendor-charts'
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/react-router/') ||
            id.includes('/react-router-dom/') ||
            id.includes('/scheduler/') ||
            id.includes('/swr/') ||
            id.includes('/use-sync-external-store/')
          ) {
            return 'vendor-react'
          }
          return 'vendor'
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // FlashFeed chart-service (Flask) uses :5050 locally and in Compose.
      '/api/sentchart': 'http://localhost:5050',
      '/api': 'http://localhost:3001',
    },
  },
})
