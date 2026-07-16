import { useMemo, useState, useEffect } from 'react'

export const DEFAULT_TRANSLATION_LANGUAGE = 'en'
export const TRANSLATION_STORAGE_KEY = 'flashfeed.translationLanguage'

export const SUPPORTED_TRANSLATION_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ja', label: 'Japanese' },
] as const

export type TranslationLanguage = typeof SUPPORTED_TRANSLATION_LANGUAGES[number]['code']

export function isSupportedTranslationLanguage(value: string): value is TranslationLanguage {
  return SUPPORTED_TRANSLATION_LANGUAGES.some(language => language.code === value)
}

export function getLanguageLabel(language: string) {
  const match = SUPPORTED_TRANSLATION_LANGUAGES.find(item => item.code === language)
  if (match) return match.label
  if (language === 'en') return 'English'
  return language.toUpperCase()
}

export function useTargetLanguage() {
  const [language, setLanguage] = useState(DEFAULT_TRANSLATION_LANGUAGE)

  useEffect(() => {
    const stored = window.localStorage.getItem(TRANSLATION_STORAGE_KEY) || DEFAULT_TRANSLATION_LANGUAGE
    setLanguage(isSupportedTranslationLanguage(stored) ? stored : DEFAULT_TRANSLATION_LANGUAGE)
  }, [])

  return language
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
