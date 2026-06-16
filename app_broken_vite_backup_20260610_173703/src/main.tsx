import React from 'react'
import { createRoot } from 'react-dom/client'

import { AppShell } from '../../frontend/shared/AppShell'
import { NewsPage } from '../../frontend/news/NewsPage'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppShell>
      <NewsPage />
    </AppShell>
  </React.StrictMode>
)
