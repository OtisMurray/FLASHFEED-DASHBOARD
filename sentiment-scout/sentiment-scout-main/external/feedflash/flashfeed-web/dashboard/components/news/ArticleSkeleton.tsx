export function ArticleSkeleton() {
  return (
    <div className="bg-surface border border-slate-700/50 rounded-lg px-3 py-3 animate-pulse">
      <div className="flex items-center gap-2 mb-2">
        <div className="h-4 w-16 bg-slate-700 rounded" />
        <div className="h-4 w-12 bg-slate-700 rounded" />
        <div className="ml-auto h-4 w-10 bg-slate-700 rounded" />
      </div>
      <div className="h-4 w-full bg-slate-700 rounded mb-1" />
      <div className="h-4 w-3/4 bg-slate-700 rounded mb-2" />
      <div className="h-3 w-1/2 bg-slate-700/50 rounded" />
    </div>
  )
}
