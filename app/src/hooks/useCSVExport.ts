export function downloadCSV(data: Record<string, unknown>[], filename: string) {
  if (!data.length) return

  const headers = Object.keys(data[0])
  const csv = [
    headers.join(','),
    ...data.map(row =>
      headers.map(header => {
        const value = row[header]
        const stringValue = String(value ?? '')
        return stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')
          ? `"${stringValue.replace(/"/g, '""')}"`
          : stringValue
      }).join(',')
    )
  ].join('\n')

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  link.setAttribute('href', url)
  link.setAttribute('download', `${filename}_${new Date().toISOString().split('T')[0]}.csv`)
  link.style.visibility = 'hidden'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}