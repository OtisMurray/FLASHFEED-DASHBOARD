import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@/components',
        replacement: fileURLToPath(new URL('../frontend', import.meta.url)),
      },
      {
        find: '@',
        replacement: fileURLToPath(new URL('..', import.meta.url)),
      },
      {
        find: 'next/link',
        replacement: fileURLToPath(new URL('./src/next-link.tsx', import.meta.url)),
      },
      {
        find: 'next/navigation',
        replacement: fileURLToPath(new URL('./src/next-navigation.ts', import.meta.url)),
      },
      {
        find: 'swr',
        replacement: fileURLToPath(new URL('./node_modules/swr/dist/index/index.mjs', import.meta.url)),
      },
      {
        find: 'clsx',
        replacement: fileURLToPath(new URL('./node_modules/clsx/dist/clsx.mjs', import.meta.url)),
      },
    ],
  },
  server: {
    fs: {
      allow: ['..'],
    },
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
