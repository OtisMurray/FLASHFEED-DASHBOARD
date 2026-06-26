/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public base URL of the Sentiment Scout backend (e.g. https://api.example.com).
   *  Unset in local dev — requests then use the relative `/api` Vite proxy. */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
