import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { SWRConfig } from 'swr'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SWRConfig
      value={{
        dedupingInterval: 15_000,
        focusThrottleInterval: 60_000,
        keepPreviousData: true,
        revalidateOnFocus: false,
        refreshWhenHidden: false,
        refreshWhenOffline: false,
        errorRetryCount: 2,
        errorRetryInterval: 5_000,
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </SWRConfig>
  </React.StrictMode>
)
