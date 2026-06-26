import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:           '#0F172A',
        surface:      '#1E293B',
        'card-hover': '#334155',
        border:       '#334155',
        accent:       '#0EA5E9',
        bull:         '#10B981',
        bear:         '#EF4444',
        neutral:      '#94A3B8',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
