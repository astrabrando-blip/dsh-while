/** In-memory scheduling guard stays functional even when domain writes fail. */
export function createHeartbeatSchedule({ run, clock = { now: Date.now, setTimeout, clearTimeout }, quietMs = 12 * 60_000, intervalMs = 30 * 60_000, retryBaseMs = 30 * 60_000, maxFailures = 3, onFailure = () => {} }) {
  const state = { userAt:null, heartbeatAt:null, nextAttemptAt:0, failures:0, revision:0, consumed:0, suspended:false, inFlight:false, dead:false, timer:null }
  const clear = () => { if (state.timer !== null) clock.clearTimeout(state.timer); state.timer = null }
  function arm() {
    clear()
    if (state.dead || state.inFlight || state.suspended || state.userAt === null || state.revision <= state.consumed) return
    const due = Math.max(state.userAt + quietMs, state.heartbeatAt === null ? 0 : state.heartbeatAt + intervalMs, state.nextAttemptAt)
    state.timer = clock.setTimeout(() => void tick(), Math.max(1, due - clock.now()))
  }
  async function tick() {
    clear()
    if (state.dead || state.inFlight || state.suspended || state.userAt === null || state.revision <= state.consumed) return
    const due = Math.max(state.userAt + quietMs, state.heartbeatAt === null ? 0 : state.heartbeatAt + intervalMs, state.nextAttemptAt)
    if (clock.now() < due) { arm(); return }
    const revision = state.revision
    state.inFlight = true
    try {
      await run()
      if (state.dead) return
      state.heartbeatAt = clock.now(); state.consumed = revision
      state.failures = 0; state.nextAttemptAt = 0; state.suspended = false
    } catch (error) {
      if (state.dead) return
      state.failures += 1
      state.nextAttemptAt = clock.now() + Math.min(2 * 60 * 60_000, retryBaseMs * 2 ** (state.failures - 1))
      state.suspended = state.failures >= maxFailures
      try { onFailure(error, { failures:state.failures, nextAttemptAt:state.nextAttemptAt, suspended:state.suspended }) } catch { /* reporting must never defeat backoff */ }
    } finally { state.inFlight = false; arm() }
  }
  return { arm, tick, snapshot:() => ({ ...state }), user() { if (state.dead) return; state.userAt = clock.now(); state.revision += 1; state.failures = 0; state.suspended = false; arm() }, dispose() { state.dead = true; clear() } }
}
