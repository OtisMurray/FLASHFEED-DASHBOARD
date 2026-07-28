// Shared table-sort comparator for the screener tables.
//
// Extracted from EntryScreenerPage and ExitScreenerPage, which had grown
// byte-identical copies of it, before PositionsPage could become a third. The
// one rule worth stating out loud is NULLS ALWAYS LAST, in both directions: a
// row with no correlation, no P&L or no stop distance is missing data, not a
// row worth zero, and flipping the sort direction must not float it to the top
// as though it were the best result.

export type SortDirection = 'asc' | 'desc'

export function compareRows<T>(a: T, b: T, key: string, direction: SortDirection): number {
  const av = (a as Record<string, unknown>)[key]
  const bv = (b as Record<string, unknown>)[key]
  if (av == null && bv == null) return 0
  if (av == null) return 1                       // nulls last regardless of direction
  if (bv == null) return -1
  if (typeof av === 'string' && typeof bv === 'string') {
    return direction === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
  }
  return direction === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av)
}

/** Non-mutating sort by one column, nulls last. */
export function sortRows<T>(rows: readonly T[], key: string, direction: SortDirection): T[] {
  return [...rows].sort((a, b) => compareRows(a, b, key, direction))
}
