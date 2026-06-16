export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:      'var(--bg)',
        surface: 'var(--surface)',
        border:  'var(--border)',
        accent:  'var(--accent)',
        neutral: 'var(--neutral)',
        bull:    'var(--bull)',
        bear:    'var(--bear)',
      },
    },
  },
  plugins: [],
}