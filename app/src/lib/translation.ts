import { useMemo, useState, useEffect } from 'react'

export const DEFAULT_TRANSLATION_LANGUAGE = 'en'

export function getLanguageLabel(language: string) {
  if (language === 'en') return 'English'
  return language.toUpperCase()
}

export function useTargetLanguage() {
  return DEFAULT_TRANSLATION_LANGUAGE
}

export function canTranslateText(text: string | undefined | null) {
  const cleaned = String(text || '').trim()
  return Boolean(cleaned)
}

export function useTranslatedText(text: string | undefined | null, targetLanguage: string) {
  const [translated, setTranslated] = useState('')
  const [source, setSource] = useState('')
  const cleanedText = useMemo(() => String(text || '').trim(), [text])

  useEffect(() => {
    let cancelled = false

    if (!canTranslateText(cleanedText)) {
      setTranslated('')
      setSource('')
      return
    }

    const run = async () => {
      try {
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: cleanedText, target_language: targetLanguage }),
        })
        const data = await res.json()
        if (!cancelled) {
          setTranslated(data.translated_text || '')
          setSource(data.provider || '')
        }
      } catch {
        if (!cancelled) {
          setTranslated('')
          setSource('')
        }
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [cleanedText, targetLanguage])

  return { translated, source }
}
