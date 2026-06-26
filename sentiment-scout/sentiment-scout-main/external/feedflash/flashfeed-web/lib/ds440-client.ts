const DS440_URL = process.env.DS440_URL ?? 'https://dashboard-seven-mauve-17.vercel.app'

export async function fetchDs440(path: string, timeout = 8000): Promise<any> {
  const res = await fetch(`${DS440_URL}${path}`, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'Accept': 'application/json' },
  })
  if (!res.ok) throw new Error(`DS440 returned ${res.status}`)
  return res.json()
}
