/** Only a persisted quote identity can bind execution; visible text is context. */
export function requestQuote(text) {
  const marker = '\n\n[Muse 来源快照]'
  const parts = String(text).split(marker)
  if (parts.length === 1) return String(text).includes('[Muse 来源快照]') ? { status: 'invalid_source', reason: 'Malformed source envelope' } : { status: 'none' }
  if (parts.length !== 2) return { status: 'invalid_source', reason: 'Ambiguous source envelope' }
  const body = parts[1]
  const block = /\[灵感引用\]([\s\S]*?)\[\/灵感引用\]/.exec(body)
  const ids = [...body.matchAll(/^引用快照：\s*([^\r\n]+)$/gm)]
  if (ids.length !== 1 || !block || !block[1].includes(ids[0][0]) || !body.includes('[灵感引用]') || !body.includes('[/灵感引用]') || body.split('[灵感引用]').length !== 2 || body.split('[/灵感引用]').length !== 2 || !ids[0][1].trim()) return { status: 'invalid_source', reason: 'Source envelope requires one persisted quote identity' }
  return { status: 'quote', quoteId: ids[0][1].trim() }
}
