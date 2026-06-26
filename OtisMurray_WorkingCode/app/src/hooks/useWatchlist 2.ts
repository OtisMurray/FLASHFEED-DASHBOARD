const WATCHLIST_KEY = 'flashfeed:watchlist'

export function useWatchlist() {
  const get = (): string[] => {
    try {
      const raw = localStorage.getItem(WATCHLIST_KEY)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  }

  const save = (tickers: string[]) => {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(tickers))
  }

  const add = (ticker: string) => {
    const list = get()
    const upper = ticker.toUpperCase().trim()
    if (!list.includes(upper)) {
      save([...list, upper])
    }
  }

  const remove = (ticker: string) => {
    const list = get().filter(t => t !== ticker.toUpperCase().trim())
    save(list)
  }

  const toggle = (ticker: string) => {
    const list = get()
    const upper = ticker.toUpperCase().trim()
    if (list.includes(upper)) {
      remove(upper)
    } else {
      add(upper)
    }
  }

  const isWatched = (ticker: string) => get().includes(ticker.toUpperCase().trim())

  return { get, save, add, remove, toggle, isWatched }
}