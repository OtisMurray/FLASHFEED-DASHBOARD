import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // flashfeed chart-service (Flask). Dev :5055; compose targets chart-service:5050.
      '/api/sentchart': 'http://localhost:5055',
      '/api': 'http://localhost:3001',
    },
  },
})
