/**
 * Pure admission ledger for a future Muse host route.
 *
 * It deliberately does not wake an Agent or touch Inbox: those effects need a
 * runtime capability that can atomically release already-staged entries. This
 * module makes the client-visible burst policy deterministic and testable.
 */
export const DEFAULT_BURST_POLICY = Object.freeze({ quietMs: 750, maxMs: 2000 })

export function normalizePolicy(policy = DEFAULT_BURST_POLICY) {
  const quietMs = Number.isFinite(policy.quietMs) && policy.quietMs >= 0 ? Math.floor(policy.quietMs) : DEFAULT_BURST_POLICY.quietMs
  const maxMs = Number.isFinite(policy.maxMs) && policy.maxMs >= quietMs ? Math.floor(policy.maxMs) : DEFAULT_BURST_POLICY.maxMs
  return { quietMs, maxMs }
}

export function emptyBurst(receipts = new Map()) {
  return { openedAt: null, latestAt: null, entries: [], receipts }
}

/**
 * Admit one independently identified, pure-text entry. Retrying an accepted
 * id is idempotent; it cannot duplicate an item in the eventual host batch.
 */
export function admitBurst(state, entry, now) {
  if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.text !== 'string' || !entry.text.trim()) throw new TypeError('Muse burst entry requires non-empty id and text')
  if (!Number.isFinite(now)) throw new TypeError('Muse burst admission requires a timestamp')
  const received = state.receipts.get(entry.id)
  if (received !== undefined) {
    // A request id names exactly one text payload. Reusing it with different
    // content is a caller error, not a retry that can be silently accepted.
    if (received.text !== entry.text) return { state, accepted: false, duplicate: false, conflict: true, acknowledgement: { requestId: entry.id, state: 'conflict' } }
    return { state, accepted: false, duplicate: true, conflict: false, acknowledgement: { requestId: entry.id, state: 'already-staged-in-memory' } }
  }
  const openedAt = state.openedAt ?? now
  const next = {
    openedAt,
    latestAt: now,
    entries: [...state.entries, { id: entry.id, text: entry.text, source: entry.source ?? 'user', at: now }],
    receipts: new Map([...state.receipts, [entry.id, { text: entry.text, at: now }]]),
  }
  // This is deliberately only an in-memory acknowledgement. The future host
  // route must replace it with a durable receipt keyed by the same request id.
  return { state: next, accepted: true, duplicate: false, conflict: false, acknowledgement: { requestId: entry.id, state: 'staged-in-memory' } }
}

/** Return the absolute time at which a stable batch may be released once. */
export function flushAt(state, policy = DEFAULT_BURST_POLICY) {
  if (state.openedAt === null || state.latestAt === null || state.entries.length === 0) return null
  const { quietMs, maxMs } = normalizePolicy(policy)
  return Math.min(state.latestAt + quietMs, state.openedAt + maxMs)
}

export function isFlushDue(state, now, policy = DEFAULT_BURST_POLICY) {
  const due = flushAt(state, policy)
  return due !== null && now >= due
}

/** A flush consumes the staged ledger exactly once; callers retain the batch. */
export function takeBurst(state, now, policy = DEFAULT_BURST_POLICY) {
  if (!isFlushDue(state, now, policy)) return { state, batch: null }
  // Keep request identities after a flush: a late retry must not form a new
  // batch. A real host retains this fact durably, not in this process-local map.
  return { state: emptyBurst(state.receipts), batch: state.entries }
}
