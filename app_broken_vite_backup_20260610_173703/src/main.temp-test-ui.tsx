import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

const API_BASE = 'http://localhost:3001/api'

function App() {
  const [articles, setArticles] = useState<any[]>([])
  const [screener, setScreener] = useState<any[]>([])
  const [social, setSocial] = useState<any[]>([])

  useEffect(() => {
    async function loadData() {
      const articlesRes = await fetch(`${API_BASE}/articles`)
      const screenerRes = await fetch(`${API_BASE}/screener`)
      const socialRes = await fetch(`${API_BASE}/social`)

      const articlesData = await articlesRes.json()
      const screenerData = await screenerRes.json()
      const socialData = await socialRes.json()

      setArticles(articlesData.articles || [])
      setScreener(screenerData || [])
      setSocial(socialData || [])
    }

    loadData()
  }, [])

  return (
    <div style={{ fontFamily: 'Arial, sans-serif', padding: '24px' }}>
      <h1>FeedFlash Dashboard</h1>
      <p>Backend connected to MongoDB at http://localhost:3001</p>

      <h2>News</h2>
      {articles.map((article) => (
        <div key={article.id} style={{ border: '1px solid #ddd', padding: '12px', marginBottom: '8px' }}>
          <strong>{article.ticker || 'Macro'} — {article.title}</strong>
          <div>{article.source} | {article.sentiment} | confidence: {article.ml_confidence}</div>
        </div>
      ))}

      <h2>Screener</h2>
      {screener.map((row) => (
        <div key={row.ticker} style={{ border: '1px solid #ddd', padding: '12px', marginBottom: '8px' }}>
          <strong>{row.ticker} — {row.company}</strong>
          <div>Price: ${row.price} | Signal score: {row.signal_score}</div>
        </div>
      ))}

      <h2>Social</h2>
      {social.map((post) => (
        <div key={post._id} style={{ border: '1px solid #ddd', padding: '12px', marginBottom: '8px' }}>
          <strong>{post.platform} — {post.ticker}</strong>
          <div>{post.text}</div>
        </div>
      ))}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
