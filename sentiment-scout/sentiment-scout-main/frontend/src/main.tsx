import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

// API base — production points the built bundle at the backend's public URL via
// the VITE_API_BASE build-time env var. When unset (local dev) it stays empty and
// requests keep hitting the relative `/api` path, which the Vite proxy forwards to
// localhost:5050. All ~27 call sites use `fetch('/api/...')`, so we rewrite once
// here instead of threading a base through every component.
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')
if (API_BASE) {
  const _fetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api')) {
      return _fetch(API_BASE + input, init)
    }
    if (input instanceof Request && input.url.startsWith('/api')) {
      return _fetch(new Request(API_BASE + input.url, input), init)
    }
    return _fetch(input, init)
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)