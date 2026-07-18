export function timeAgo(iso: string) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (seconds < 90) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${String(days)}d ago`
  const months = Math.round(days / 30)
  return `${String(months)}mo ago`
}
