import { captureDiscoveryContext, validateContextPacket, contextReferences, validateNoChange, latestDiscoveryPause, latestContextIncomplete, rejectionRecord, validateImInsight } from './discovery-context.js'
import { evaluateCalculation, candidateQuality } from './discovery-quality.js'
import { randomUUID, createHash } from 'node:crypto'
import { validateCandidate, equivalent } from './candidates.js'
import { createDiscoveryRunner, inspectDiscoveryRun } from './discovery-runner.js'

const owners = new WeakMap()
const terminalStates = new Set(['completed', 'no_change', 'failed', 'blocked'])
const runStates = new Set(['admitted', 'starting', 'running', 'projecting', 'unknown', ...terminalStates])
const iso = time => new Date(time).toISOString()
const dayOf = time => iso(time).slice(0, 10)
const tomorrow = time => Date.parse(dayOf(time)) + 86_400_000
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const rootPolicy = now => ({ revision: 0, consumedRevision: 0, lastInputAt: null, lastInputId: null, seenInputIds: [], nextDue: now, retryAt: null, failures: 0, suspended: false, lastSuccess: null, lastFailure: null, activeRunId: null, sourceHash: null })

/** One in-process owner, one durable admission journal. No distributed lock or transaction claim. */
export function recallFocus(sources,runs,root){const count=id=>Object.values(runs).filter(r=>r.rootSessionId===root&&r.focusAnchorId===id).length;return [...sources].sort((a,b)=>count(a.anchorId)-count(b.anchorId))[0].anchorId}
export function createPersistentHeartbeat(ctx, options = {}) {
  const contextEnabled = options.contextEnabled !== false
  const automaticDiscoveryEnabled = options.automaticDiscoveryEnabled === true
  const ownerKey = ctx.root || ctx
  if (owners.has(ownerKey)) throw new Error('Muse heartbeat already has one Host owner')
  const clock = options.clock || { now: Date.now, setTimeout, clearTimeout }
  const policy = { quietMs: 12 * 60_000, intervalMs: 30 * 60_000, retryMs: 30 * 60_000, maxFailures: 3, dailyLimit: 4, ...options.policy }
  const runner = options.runner || createDiscoveryRunner(ctx)
  let state, dead = false, fault = null, timer = null, tail = Promise.resolve(), disposing
  const operations = new Set(), observed = new Set(), blockedFrontiers = new Set()
  const enqueue = operation => {
    const result = tail.then(operation)
    tail = result.catch(error => { ctx.logger?.warn(`Muse heartbeat operation: ${error.message || String(error)}`) })
    return result
  }
  const clear = () => { if (timer !== null) clock.clearTimeout(timer); timer = null }
  const ownedRoots = () => Object.entries(state.roots).filter(([id]) => ctx.muse.ownsRoot(id))
  async function commit(next) {
    // The backend must confirm before memory, model start or result projection advances.
    if (fault) throw new Error(`Heartbeat journal unavailable until restart: ${fault}`)
    try { state = await ctx.muse.heartbeatControlPut(structuredClone(next)) }
    catch (error) { fault = error.message || String(error); clear(); throw error }
    return state
  }
  async function mutate(fn) { const next = structuredClone(state); fn(next); return commit(next) }
  function arm() {
    clear()
    if (!automaticDiscoveryEnabled || dead || fault || !state || ownedRoots().some(([, root]) => root.activeRunId && ['admitted', 'starting', 'running', 'unknown'].includes(state.runs[root.activeRunId]?.status))) return
    const dues = ownedRoots().filter(([id]) => !blockedFrontiers.has(id)).map(([, root]) => root).filter(root => !root.suspended && (!root.activeRunId || state.runs[root.activeRunId]?.status === 'projecting')).map(root => root.nextDue).filter(Number.isFinite)
    if (!dues.length) return
    timer = clock.setTimeout(() => { void tick().catch(() => {}) }, Math.max(1, Math.min(...dues) - clock.now()))
  }
  async function notifyDiscovery(run) {
    if(run.mode!=='explicit-once'||run.maxSteps!==6||!terminalStates.has(run.status)||run.notified||!ctx.muse.imController?.discoveryResult)return
    try {
      const receipt=await ctx.muse.imController.discoveryResult(run.rootSessionId,{runId:run.id,status:run.status})
      if(receipt.published)await mutate(next=>{next.runs[run.id].notified=true})
    } catch(error) {ctx.logger?.warn(`Discovery notification pending: ${error.message}`)}
  }
  async function mirror(run) {
    await notifyDiscovery(run)
    try { await ctx.muse.heartbeatJobPut({ id: run.id, rootSessionId: run.rootSessionId, workerId: run.workerId, status: terminalStates.has(run.status) ? ['completed', 'no_change'].includes(run.status) ? 'completed' : run.status === 'blocked' ? 'blocked' : 'failed' : run.status === 'unknown' ? 'unknown' : 'generating', createdAt: run.createdAt, evidence: { journalVersion: 1, stage: run.status, ...(run.terminal ? { terminal: run.terminal } : {}), ...(run.publication ? { publication: run.publication } : {}), ...(run.contextRevision === 1 ? { contextRevision: 1, contextSummary: { capturedAt: run.contextPacket.capturedAt, ...run.contextPacket.availability }, rejections: run.rejections || [], ...(run.result?.outcome === 'no_change' ? { outcomeDetails: { reason: run.result.reason, basis: run.result.basis } } : {}) } : {}) }, ...(run.error ? { error: run.error } : {}) }) }
    catch (error) { ctx.logger?.warn(`Muse heartbeat diagnostic mirror: ${error.message}`) }
  }
  async function failure(id, stage, error, unknown = false) {
    await mutate(next => {
      const run = next.runs[id], root = next.roots[run.rootSessionId]
      run.status = unknown ? 'unknown' : 'failed'; run.failureStage = stage; run.error = String(error); run.endedAt = iso(clock.now())
      if(run.mode==='explicit-once'){if(!unknown){root.activeRunId=null;root.nextDue=run.previousNextDue}return}
      root.lastFailure = { runId: id, stage, time: run.endedAt, error: run.error, unknown }
      if (unknown) { root.nextDue = null; return }
      root.activeRunId = null; root.failures += 1; root.suspended = root.failures >= policy.maxFailures
      root.retryAt = clock.now() + Math.min(120 * 60_000, policy.retryMs * 2 ** (root.failures - 1))
      root.nextDue = root.suspended ? null : root.retryAt
    })
    await mirror(state.runs[id]); arm()
  }
  async function resolve(id, status, publication) {
    await mutate(next => {
      const run = next.runs[id], root = next.roots[run.rootSessionId]
      run.status = status; run.endedAt = iso(clock.now()); if (publication) run.publication = publication
      if(run.mode==='explicit-once'){root.activeRunId=null;root.nextDue=run.previousNextDue;return}
      root.activeRunId = null; root.consumedRevision = Math.max(root.consumedRevision, run.revision)
      root.failures = 0; root.suspended = false; root.retryAt = null; root.lastSuccess = { runId: id, time: run.endedAt, outcome: status, ...(run.contextRevision === 1 && run.result?.outcome === 'no_change' ? { reason: run.result.reason, basis: run.result.basis } : {}) }
      root.nextDue = Math.max(clock.now() + policy.intervalMs, (root.lastInputAt ?? 0) + policy.quietMs)
    })
    await mirror(state.runs[id]); arm()
  }
  async function project(id) {
    const run = structuredClone(state.runs[id])
    if (run.status !== 'projecting') return
    let publication
    try {
      if (run.contextRevision === 1 && run.result.outcome === 'no_change') { const check = await ctx.muse.discoveryContextCheck(run); if (!check.current) publication = { published: false, stale: true, reason: check.reason } }
      if (!publication && run.result.outcome === 'no_change') { await resolve(id, 'no_change'); return }
      if (!publication) publication = await ctx.muse.publishDiscoveryCandidate(run)
    }
    catch (error) {
      await mutate(next => {
        const current = next.runs[id], root = next.roots[current.rootSessionId]
        current.failureStage = 'projection'; current.error = error.message || String(error); current.projectionFailures = (current.projectionFailures || 0) + 1
        if(current.mode==='explicit-once'){root.nextDue=null;return}
        root.lastFailure = { runId: id, stage: 'projection', time: iso(clock.now()), error: current.error, unknown: false }
        root.suspended = current.projectionFailures >= policy.maxFailures
        root.retryAt = clock.now() + Math.min(120 * 60_000, policy.retryMs * 2 ** (current.projectionFailures - 1))
        root.nextDue = root.suspended ? null : root.retryAt
      })
      await mirror(state.runs[id]); arm(); return
    }
    if (publication.stale) {
      await mutate(next => {
        const current = next.runs[id], root = next.roots[current.rootSessionId]
        current.status = 'blocked'; current.failureStage = 'projection'; current.error = 'Source intent/version changed; original result retained without publication'; current.endedAt = iso(clock.now()); current.publication = publication
        if (run.contextRevision === 1) current.rejections = [...(current.rejections || []), rejectionRecord('stale_context', clock.now)].slice(-6)
        root.activeRunId = null; root.nextDue = current.mode==='explicit-once'?current.previousNextDue:Math.max(clock.now() + policy.intervalMs, (root.lastInputAt ?? 0) + policy.quietMs)
        if(current.mode!=='explicit-once')root.lastFailure = { runId: id, stage: 'projection', time: current.endedAt, error: current.error, unknown: false }
      })
      await mirror(state.runs[id]); arm(); return
    }
    await resolve(id, 'completed', publication)
  }
  async function result(id, value) {
    const run = state.runs[id]
    if (!run || !['starting', 'running'].includes(run.status)) throw new Error('Run is not accepting a result')
    const hash = digest(value)
    if (run.result) {
      if (run.resultHash !== hash) throw new Error('Only one structured result per discovery run')
      return { recorded: true, duplicate: true, runId: id }
    }
    try {
      const allowed = run.contextRevision === 1 ? ['outcome','candidate','reason','basis','basisRefs'] : ['outcome','candidate']
      if (!value || !['candidate','no_change'].includes(value.outcome) || Object.keys(value).some(key => !allowed.includes(key)) || (value.outcome === 'no_change' && value.candidate)) throw new Error('Invalid structured discovery result')
      if (run.contextRevision === 1 && (run.resultAttempts || 0) >= 6) throw new Error('Bounded result allowance exhausted')
      if (value.outcome === 'candidate') {
        const candidateKeys = ['opportunity','pluginOptions','anchorId','version','title','newInformation','suggested','sourceRefs','calculations', ...(run.contextRevision === 1 ? ['contextRefs'] : []),...(run.contextPacket?.inputTransport==='persistent-im'?['hypothesis','adoptionBoundary']:[])]
        if (!value.candidate || Object.keys(value.candidate).some(key => !candidateKeys.includes(key)) || ['reason','basis','basisRefs'].some(key => key in value)) throw new Error('Invalid discovery candidate')
        validateCandidate(value.candidate, run.sources.find(source => source.anchorId === value.candidate.anchorId), [])
        if (run.contextRevision === 1) {
          if (latestDiscoveryPause(run.contextPacket)) { const error=Error('Latest human pause prevents recommendation');error.code='stale_context';throw error }
          contextReferences(value.candidate.contextRefs, run.contextPacket)
          validateImInsight(value.candidate,run.contextPacket)
          if (run.contextPacket.priorRecommendations.some(prior => equivalent(prior.title, value.candidate.title) || (prior.newInformation && equivalent(prior.newInformation,value.candidate.newInformation)))) { const error=Error('Already recommended direction');error.code='duplicate_direction';throw error }
        }
        if (run.qualityRevision === 1) candidateQuality(value.candidate, run)
      } else if (run.contextRevision === 1) validateNoChange(value, run.contextPacket)
    } catch (error) {
      if (run.contextRevision === 1) {
        const code = error.code || (/Unverified numeric derivation/.test(error.message) ? 'unsupported_numeric_prose' : /calculation|numeric result/i.test(error.message) ? 'invalid_calculation' : 'invalid_shape')
        await mutate(next => { const current=next.runs[id];current.resultAttempts=(current.resultAttempts || 0)+1;current.rejections=[...(current.rejections || []),rejectionRecord(code,clock.now)].slice(-6) })
        await mirror(state.runs[id])
      }
      throw error
    }
    await mutate(next => { next.runs[id].result = structuredClone(value); next.runs[id].resultHash = hash; next.runs[id].resultAt = iso(clock.now()); if (run.contextRevision === 1) next.runs[id].resultAttempts = (next.runs[id].resultAttempts || 0) + 1 })
    return { recorded: true, published: false, runId: id }
  }
  async function terminal(id, outcome) {
    if (!state.runs[id] || terminalStates.has(state.runs[id].status) || ['unknown', 'projecting'].includes(state.runs[id].status)) return
    if (outcome.state === 'running') return
    if (outcome.state === 'unknown') { await failure(id, 'recovery', outcome.error, true); return }
    await mutate(next => { next.runs[id].terminal = outcome.terminal })
    if (outcome.state === 'failed') { await failure(id, 'execution', JSON.stringify(outcome.terminal.reason)); return }
    if (state.runs[id].legacy) {
      await mutate(next => {
        const run = next.runs[id], root = next.roots[run.rootSessionId]
        run.status = 'completed'; run.endedAt = iso(clock.now()); run.publication = { legacy: true, recoveredTerminalOnly: true }
        root.activeRunId = null; root.nextDue = Math.max(clock.now(), (root.lastInputAt ?? 0) + policy.quietMs)
      })
      await mirror(state.runs[id]); arm(); return
    }
    if (!state.runs[id].result) { await failure(id, 'output', 'Completed worker has no durable structured result'); return }
    await mutate(next => { next.runs[id].status = 'projecting' })
    await project(id)
  }
  async function launch(run) {
    try {
      await runner.start(run, {
        onStarting: () => enqueue(async () => { if (dead) throw new Error('Owner disposed before create'); if (run.contextRevision === 1) { const check=await ctx.muse.discoveryContextCheck(run); if (!check.current) { await mutate(next => { next.runs[run.id].rejections=[rejectionRecord('stale_context',clock.now)] }); throw new Error('Captured context changed before worker creation') } } return mutate(next => { next.runs[run.id].status = 'starting' }) }),
        onStep: () => enqueue(async()=>{const current=state.runs[run.id];if(dead||!current||current.mode!=='explicit-once'||current.status!=='running')throw Error('Explicit discovery model step allowance exhausted');if(current.result&&!current.finalizationStep){await mutate(next=>{next.runs[run.id].finalizationStep=true});return current.stepCount}if(current.result||current.stepCount>=current.maxSteps)throw Error('Explicit discovery model step allowance exhausted');await mutate(next=>{next.runs[run.id].stepCount++});return state.runs[run.id].stepCount}),
        onStarted: () => enqueue(() => mutate(next => { next.runs[run.id].status = 'running' })),
        onCalculation: input => enqueue(async () => {
          const current = state.runs[run.id]
          if (!current || !['starting', 'running'].includes(current.status) || (current.calculationAttempts || 0) >= 6) throw new Error('Calculation run unavailable or bounded allowance exhausted')
          await mutate(next => { next.runs[run.id].calculationAttempts = (next.runs[run.id].calculationAttempts || 0) + 1 })
          const receipt = evaluateCalculation(current, input)
          await mutate(next => { (next.runs[run.id].calculations ||= {})[receipt.receiptId] = receipt })
          return structuredClone(receipt)
        }),
        onResult: value => enqueue(() => result(run.id, value)),
        onTerminal: outcome => enqueue(() => terminal(run.id, outcome))
      })
      await enqueue(() => mirror(state.runs[run.id]))
    } catch (error) {
      await enqueue(async () => {
        if (state.runs[run.id]?.status === 'admitted') await failure(run.id, 'start', error.message)
        else {
          const observed = await inspectDiscoveryRun(ctx, state.runs[run.id])
          if (observed.state === 'failed' || observed.state === 'completed') await terminal(run.id, observed)
          else await failure(run.id, 'start', error.message, true)
        }
      })
    } finally { arm() }
  }
  const track = promise => { operations.add(promise); void promise.finally(() => operations.delete(promise)).catch(() => {}); return promise }
  async function sourcesChanged(rootId, messageId = null) {
    if (!ctx.muse.ownsRoot(rootId)) throw new Error('Exact Muse root required')
    const sources = (await ctx.muse.candidateContext(rootId)).slice(-12), hash = digest(sources)
    blockedFrontiers.delete(rootId)
    const current = state.roots[rootId]
    if (current && current.sourceHash === hash && (!messageId || current.seenInputIds?.includes(messageId))) return
    await mutate(next => {
      const root = next.roots[rootId] ||= rootPolicy(clock.now())
      const changed = root.sourceHash !== hash
      root.sourceHash = hash
      if (changed || (messageId && !root.seenInputIds?.includes(messageId))) {
        root.revision += 1; root.lastInputAt = clock.now(); if (messageId) root.lastInputId = messageId
        if (messageId) root.seenInputIds = [...(root.seenInputIds || []), messageId]
        root.failures = 0; root.suspended = false; root.retryAt = null
        if (root.activeRunId && next.runs[root.activeRunId]?.status === 'unknown') return
        if (root.activeRunId && next.runs[root.activeRunId]?.status === 'projecting') {
          next.runs[root.activeRunId].projectionFailures = 0
          root.nextDue = clock.now()
        } else root.nextDue = Math.max(clock.now() + policy.quietMs, root.lastSuccess ? Date.parse(root.lastSuccess.time) + policy.intervalMs : 0)
      }
    })
    arm()
  }
  async function recover(run) {
    if (run.status === 'projecting') {
      const root = state.roots[run.rootSessionId]
      if (run.mode==='explicit-once'||(!root.suspended && root.nextDue <= clock.now())) await project(run.id)
      return
    }
    if (run.status === 'unknown' || terminalStates.has(run.status)) return
    const outcome = await inspectDiscoveryRun(ctx, run)
    if (outcome.state !== 'running') { await terminal(run.id, outcome); return }
    // Observe an already live, exact known worker; never recreate or resume it.
    const agent = ctx.agents.get?.(run.workerId)
    if (!agent?.whenIdle || observed.has(run.id)) return
    observed.add(run.id)
    void agent.whenIdle().then(async () => { await ready; if (!dead) return enqueue(async () => terminal(run.id, await inspectDiscoveryRun(ctx, state.runs[run.id]))) }).catch(error => ctx.logger?.warn(`Muse recovery observation: ${error.message}`))
  }
  async function initialize() {
    const saved = await ctx.muse.heartbeatControlGet()
    if (saved !== null && (saved.version !== 1 || !saved.roots || !saved.runs || !saved.budget)) throw new Error('Unknown heartbeat journal schema; no automatic migration')
    state = saved ?? { version: 1, roots: {}, runs: {}, budget: { day: dayOf(clock.now()), used: 0, limit: policy.dailyLimit } }
    if (!Number.isInteger(state.budget.used) || state.budget.used < 0 || !Number.isInteger(state.budget.limit) || state.budget.limit <= 0 || typeof state.budget.day !== 'string') throw new Error('Invalid heartbeat budget; no automatic reset')
    for (const [id, root] of Object.entries(state.roots)) {
      if (!Number.isInteger(root.revision) || !Number.isInteger(root.consumedRevision) || root.revision < 0 || root.consumedRevision > root.revision || (root.nextDue !== null && !Number.isFinite(root.nextDue))) throw new Error('Invalid heartbeat root policy; no automatic reset')
      if (root.activeRunId && (state.runs[root.activeRunId]?.rootSessionId !== id || state.runs[root.activeRunId]?.id !== root.activeRunId)) throw new Error('Missing or mismatched active run journal; no automatic replacement')
    }
    for (const [id, run] of Object.entries(state.runs)) {
      if (run.id !== id || !runStates.has(run.status) || !state.roots[run.rootSessionId] || typeof run.workerId !== 'string' || !/^[a-f\d-]{36}$/i.test(run.workerId) || !Number.isInteger(run.revision) || run.revision < 0 || !Array.isArray(run.sources) || !Number.isFinite(Date.parse(run.createdAt))) throw new Error('Invalid run journal; no automatic replacement')
      if (run.contextRevision !== undefined) { if (run.contextRevision !== 1) throw new Error('Unknown context revision'); validateContextPacket(run.contextPacket, run.rootSessionId) }
      if (run.status === 'projecting' && !['candidate', 'no_change'].includes(run.result?.outcome)) throw new Error('Projection lacks durable structured result; no automatic rerun')
    }
    if(state.oneOffRequests!==undefined&&(!state.oneOffRequests||Array.isArray(state.oneOffRequests)||typeof state.oneOffRequests!=='object'))throw Error('Invalid explicit request ledger; no reset')
    for(const [id,request] of Object.entries(state.oneOffRequests||{})){
      const run=state.runs[request.runId]
      if(request.requestId!==id||!validRequestId(id)||typeof request.rootSessionId!=='string'||request.limit!==1||![0,1].includes(request.used)||(request.used===1&&(!run||run.mode!=='explicit-once'||run.requestId!==id||run.rootSessionId!==request.rootSessionId||![3,6].includes(run.maxSteps)||request.createdAt!==run.createdAt||digest(request.sourceFrontier)!==digest(run.contextPacket?.imFrontier)||!Number.isInteger(run.stepCount)||run.stepCount<0||run.stepCount>run.maxSteps||(run.previousNextDue!==null&&!Number.isFinite(run.previousNextDue))))||(request.used===0&&(request.status!=='blocked'||request.runId)))throw Error('Invalid explicit request binding; no replay')
    }
    for(const run of Object.values(state.runs))if(run.mode==='explicit-once'&&state.oneOffRequests?.[run.requestId]?.runId!==run.id)throw Error('Explicit run lacks durable request identity; no replay')
    const next = structuredClone(state)
    next.automaticDiscoveryPaused = !automaticDiscoveryEnabled
    next.manualSyntheticOnly = !automaticDiscoveryEnabled
    for (const id of await ctx.muse.heartbeatRootIds()) next.roots[id] ||= rootPolicy(clock.now())
    for (const legacy of await ctx.muse.heartbeatJobList()) {
      if (legacy.status !== 'generating' || next.runs[legacy.id] || !ctx.muse.ownsRoot(legacy.rootSessionId)) continue
      const root = next.roots[legacy.rootSessionId] ||= rootPolicy(clock.now())
      next.runs[legacy.id] = { id: legacy.id, workerId: legacy.workerId, rootSessionId: legacy.rootSessionId, createdAt: legacy.createdAt, revision: root.revision, sources: [], status: 'running', legacy: true }
      if (root.activeRunId && root.activeRunId !== legacy.id) throw new Error('Multiple legacy/owned active discovery runs; reconcile explicitly')
      root.activeRunId = legacy.id
    }
    await commit(next)
    for (const id of Object.keys(state.roots)) if (ctx.muse.ownsRoot(id)) {
      try { await sourcesChanged(id) }
      catch (error) {
        // An unconfirmed persistent IM frontier blocks only this discovery root.
        // Keep its durable policy/work/budget intact and never fall back to native
        // history or infer a handoff. Other errors must still fail startup.
        if (error.code !== 'MUSE_IM_FRONTIER_UNAVAILABLE') throw error
        blockedFrontiers.add(id)
        ctx.logger?.warn('Muse discovery source blocked: persistent IM handoff/frontier unavailable; journal retained')
      }
    }
    for (const run of Object.values(state.runs)) if (ctx.muse.ownsRoot(run.rootSessionId) && !blockedFrontiers.has(run.rootSessionId) && !terminalStates.has(run.status)) await recover(run)
    arm()
  }
  const ready = initialize().catch(error => { fault = error.message; clear(); throw error })
  async function tick(requestedRoot = null, manualSynthetic = false) {
    await ready
    if (!automaticDiscoveryEnabled && !manualSynthetic) return { generating: false, reason: 'automatic-paused' }
    let admissionReason = null
    const run = await enqueue(async () => {
      clear()
      if (dead || fault) return null
      if (ownedRoots().some(([, root]) => root.activeRunId && ['admitted', 'starting', 'running', 'unknown'].includes(state.runs[root.activeRunId]?.status))) return null
      const entry = Object.entries(state.roots).filter(([id, root]) => (!requestedRoot || id === requestedRoot) && ctx.muse.ownsRoot(id) && !blockedFrontiers.has(id) && !root.suspended && Number.isFinite(root.nextDue) && root.nextDue <= clock.now() && (!root.activeRunId || state.runs[root.activeRunId]?.status === 'projecting')).sort((a, b) => a[1].nextDue - b[1].nextDue)[0]
      if (!entry) return null
      const [rootId, root] = entry
      if (root.activeRunId) { await project(root.activeRunId); return null }
      const allSources = (await ctx.muse.candidateContext(rootId)).slice(-12)
      if (digest(allSources) !== root.sourceHash) { await sourcesChanged(rootId); return null }
      const sources = manualSynthetic ? allSources.filter(source => source.origin === '目标' && /^合成/.test(source.sourceText)) : allSources
      if (!sources.length) { await mutate(next => { next.roots[rootId].nextDue = clock.now() + policy.intervalMs }); return null }
      if (state.budget.day !== dayOf(clock.now())) await mutate(next => { next.budget = { day: dayOf(clock.now()), used: 0, limit: policy.dailyLimit } })
      if (state.budget.used >= state.budget.limit) { await mutate(next => { next.roots[rootId].nextDue = tomorrow(clock.now()) }); return null }
      let contextPacket
      if (contextEnabled) {
        try {
          contextPacket = await captureDiscoveryContext(ctx, rootId, id => ctx.muse.discoveryContextSnapshot(id), clock.now)
          validateContextPacket(contextPacket, rootId)
          if (latestContextIncomplete(contextPacket)) { admissionReason = 'latest_input_truncated'; contextPacket = null }
          else if (latestDiscoveryPause(contextPacket)) { admissionReason = 'user_paused'; contextPacket = null }
        } catch { admissionReason = 'context_unavailable' }
        if (!contextPacket) { await mutate(next => { next.roots[rootId].lastContextAdmission={ reason: admissionReason, time: iso(clock.now()) }; next.roots[rootId].nextDue=clock.now()+policy.intervalMs }); return null }
      }
      const run = { id: randomUUID(), workerId: randomUUID(), rootSessionId: rootId, createdAt: iso(clock.now()), status: 'admitted', revision: root.revision, sources, ...(contextPacket ? { contextRevision: 1, contextPacket } : {}), qualityRevision: 1, focusAnchorId: recallFocus(sources,state.runs,rootId), ...(manualSynthetic ? { synthetic: true } : {}) }
      await mutate(next => { next.runs[run.id] = run; next.roots[rootId].activeRunId = run.id; next.budget.used += 1 })
      return run
    })
    if (run) track(launch(run))
    arm()
    return run ? { generating: true, runId: run.id, workerId: run.workerId } : { generating: false, ...(admissionReason ? { reason: admissionReason } : {}) }
  }
  function validRequestId(id){return typeof id==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id)}
  const receipt=request=>{const run=state.runs[request.runId];return {requestId:request.requestId,rootSessionId:request.rootSessionId,accepted:request.used===1,duplicate:false,charged:request.used,limit:1,status:run?.status||request.status,reason:request.reason||null,...(run?{runId:run.id,workerId:run.workerId,modelSteps:run.stepCount,maxModelSteps:run.maxSteps,...(run.publication?{publication:structuredClone(run.publication)}:{}),...(run.result?.outcome==='no_change'?{outcomeDetails:{reason:run.result.reason,basis:run.result.basis}}:{}),...(run.error?{error:run.error}:{})}: {})}}
  const validateOnce=input=>{if(!input||Object.keys(input).some(k=>!['rootSessionId','requestId'].includes(k))||!validRequestId(input.requestId)||!ctx.muse.ownsRoot(input.rootSessionId))throw Error('Exact owned root and stable explicit requestId required')}
  async function readOnce(input){await ready;if(!input||Object.keys(input).some(k=>!['rootSessionId','requestId'].includes(k))||!ctx.muse.ownsRoot(input.rootSessionId)||(input.requestId!==undefined&&!validRequestId(input.requestId)))throw Error('Exact owned request lookup required');await tail;if(fault)throw Error('Discovery journal unavailable until restart');const request=input.requestId?state.oneOffRequests?.[input.requestId]:Object.values(state.oneOffRequests||{}).findLast(r=>r.rootSessionId===input.rootSessionId);if(!request)return {requestId:input.requestId,rootSessionId:input.rootSessionId,status:'absent',accepted:false};if(request.rootSessionId!==input.rootSessionId)throw Error('Explicit request belongs to another root');await enqueue(()=>notifyDiscovery(state.runs[request.runId]||{}));return receipt(request)}
  async function requestOnce(input){
    await ready;validateOnce(input)
    const admitted=await enqueue(async()=>{
      if(dead||fault)throw Error('Discovery owner unavailable');validateOnce(input)
      const prior=state.oneOffRequests?.[input.requestId]
      if(prior){if(prior.rootSessionId!==input.rootSessionId)throw Error('Explicit request belongs to another root');return {request:prior,duplicate:true}}
      const block=async reason=>{const request={...input,createdAt:iso(clock.now()),limit:1,used:0,status:'blocked',reason};await mutate(next=>{(next.oneOffRequests||={})[input.requestId]=request});return {request}}
      if(!ctx.muse.imController?.enabled(input.rootSessionId))return block('im-conversation-not-ready')
      if(ownedRoots().some(([,root])=>root.activeRunId&&!terminalStates.has(state.runs[root.activeRunId]?.status)))return block('existing-discovery-unresolved')
      const sources=(await ctx.muse.candidateContext(input.rootSessionId)).slice(-12)
      if(!sources.length)return block('no-authorized-source')
      let packet
      try{packet=await captureDiscoveryContext(ctx,input.rootSessionId,id=>ctx.muse.discoveryContextSnapshot(id),clock.now);validateContextPacket(packet,input.rootSessionId)}catch{return block('context-unavailable')}
      if(packet.inputTransport!=='persistent-im')return block('persistent-im-not-ready')
      if(latestContextIncomplete(packet))return block('latest-input-truncated')
      if(latestDiscoveryPause(packet))return block('user-paused')
      const root=state.roots[input.rootSessionId]
      if(!root)return block('root-policy-unavailable')
      const run={id:randomUUID(),workerId:randomUUID(),rootSessionId:input.rootSessionId,requestId:input.requestId,mode:'explicit-once',createdAt:iso(clock.now()),status:'admitted',revision:root.revision,previousNextDue:root.nextDue,sources,contextRevision:1,contextPacket:packet,qualityRevision:1,focusAnchorId:recallFocus(sources,state.runs,input.rootSessionId),maxSteps:6,stepCount:0}
      const request={...input,createdAt:run.createdAt,limit:1,used:1,runId:run.id,status:'admitted',sourceFrontier:packet.imFrontier}
      validateOnce(input)
      await mutate(next=>{(next.oneOffRequests||={})[input.requestId]=request;next.runs[run.id]=run;next.roots[input.rootSessionId].activeRunId=run.id;next.roots[input.rootSessionId].nextDue=null})
      return {request,run}
    })
    if(admitted.run)track(launch(admitted.run))
    return {...receipt(admitted.request),duplicate:!!admitted.duplicate}
  }
  const api = {
    ready, tick, arm, requestOnce, readOnce,
    async retryNotifications(root) { await ready; if(dead)return;return enqueue(async()=>{for(const run of Object.values(state.runs))if(run.rootSessionId===root)await notifyDiscovery(run)}) },
    snapshot: () => structuredClone({ ...state, unavailable: fault, blockedFrontiers: [...blockedFrontiers] }),
    async noteUser(root, id) { await ready; if (!dead) return enqueue(() => sourcesChanged(root, id)) },
    async refreshSources(root) { await ready; if (!dead) return enqueue(() => sourcesChanged(root)) },
    async request(root, { synthetic = false } = {}) {
      await ready
      if (!automaticDiscoveryEnabled && synthetic !== true) return { generating: false, heartbeatRevision: 'muse-controlled-heartbeat-v2-manual-only', reason: 'automatic-paused', automaticDiscovery: { paused: true, manualSyntheticOnly: true } }
      await enqueue(async () => {
        if (dead) throw new Error('Heartbeat owner disposed')
        if (!ctx.muse.ownsRoot(root)) throw new Error('Exact Muse root required')
        if (!state.roots[root]) await sourcesChanged(root)
        const sources = await ctx.muse.candidateContext(root)
        if (synthetic && !sources.some(source => source.origin === '目标' && /^合成/.test(source.sourceText))) throw new Error('Controlled heartbeat requires an authorized synthetic goal')
        const current = state.roots[root]
        // Manual checks respect active unknown, failure backoff and budget; no secret reset.
        if (!current.activeRunId && !current.suspended && !current.lastFailure) await mutate(next => { next.roots[root].nextDue = Math.max(clock.now(), (current.lastInputAt ?? 0) + policy.quietMs, current.lastSuccess ? Date.parse(current.lastSuccess.time) + policy.intervalMs : 0) })
      })
      const admitted = await tick(root, synthetic === true)
      const active = state.runs[state.roots[root].activeRunId]
      return { ...admitted, ...(active && ['admitted', 'starting', 'running'].includes(active.status) ? { generating: true, runId: active.id, workerId: active.workerId } : {}), heartbeatRevision: 'muse-controlled-heartbeat-v2-manual-only', automaticDiscovery: { paused: !automaticDiscoveryEnabled, manualSyntheticOnly: !automaticDiscoveryEnabled }, reason: fault ? 'storage-unavailable' : active?.status || (state.roots[root].suspended ? 'suspended' : 'scheduled-or-budget-limited'), root: structuredClone(state.roots[root]), externalResearch: { status: 'not_configured' } }
    },
    async flush() { await ready; await Promise.allSettled([...operations]); await tail },
    dispose() {
      return disposing ||= (async () => {
        dead = true; clear(); await ready.catch(() => {}); await tail
        await runner.dispose(); await Promise.allSettled([...operations]); await tail
        if (owners.get(ownerKey) === api) owners.delete(ownerKey)
      })()
    }
  }
  owners.set(ownerKey, api)
  return api
}
