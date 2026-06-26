import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path  from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    proxy: {
      // Sentiment Scout's Flask backend (dashboard.py) is the single source of truth.
      '/api': { target: 'http://localhost:5050', changeOrigin: true },
    },
  },
})