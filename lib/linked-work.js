import {createSessionHost} from './session-host.js'
import { randomUUID } from 'node:crypto'
import {isAbsolute} from 'node:path'
const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('')
const owners = new WeakMap()
const hostContext = event => ['runtime-context','skill-catalog'].includes(event.data?.source?.kind)
const terminal = new Set(['completed', 'failed', 'rejected'])
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)

/** Exact user-selected ordinary target; never fork/reparent, title-resolve or cancel. */
export function createLinkedWork(ctx) {
  const fallbackHost = createSessionHost(ctx)
  const host = () => ctx.muse.sessionHost || fallbackHost
  const ownerKey = ctx.root || ctx
  if (owners.has(ownerKey)) throw new Error('Linked work already has a Host owner')
  owners.set(ownerKey, true)
  let tail = Promise.resolve(), dead = false, fault = null
  const targets = new Set()
  const enqueue = fn => { const result = tail.then(() => { if (dead) throw new Error('Linked work disposed'); return fn() }); tail = result.catch(error => ctx.logger?.warn(`Muse linked work: ${error.message}`)); return result }
  const root = id => { if (!ctx.muse.ownsRoot(id)) throw new Error('Exact Muse root required') }
  const read = async id => (await ctx.muse.linkedAll()).find(work => work.id === id)
  async function save(work) {
    if (fault) throw new Error(`Linked journal unavailable until reload: ${fault}`)
    try { await ctx.muse.linkedPut(work) }
    catch (error) { fault = error.message; throw error }
    return work
  }
  const observation = id => host().observe(id)
  function ordinary(id, header) {
    if (ctx.muse.ownsRoot(id)) throw new Error('Muse roots are not ordinary linked targets')
    if (host().isOwnedChild(id, header)) throw new Error('Owned child requires its original parent delivery path')
  }
  async function history(input) {
    root(input.rootSessionId)
    const value = await observation(input.sessionId)
    ordinary(input.sessionId, value.header)
    const before = input.beforeSeq ?? Infinity
    const limit = Math.max(1, Math.min(40, input.limit || 20))
    const messages = value.events.filter(e => e.seq < before &&
      (e.type === 'assistant/message' || (e.type === 'user/message' && !hostContext(e))))
      .map(e => ({seq:e.seq, role:e.type === 'user/message' ? 'user' : 'assistant', text:textOf(e.type === 'user/message' ? e.data : e.data.message)}))
      .filter(m => m.text)
    const page = messages.slice(-limit).map(m => ({...m,text:m.text.slice(0,12000),truncated:m.text.length>12000}))
    return {session_id:input.sessionId,cwd:value.header.cwd,messages:page,next_before_seq:messages.length>page.length?page[0].seq:null, historical_context_only:true}
  }
  async function metadata(input) {
    root(input.rootSessionId)
    return (await host().list()).filter(item => !ctx.muse.ownsRoot(item.sessionId) && item.origin !== 'subagent')
  }
  async function context(input) {
    const all = await metadata(input)
    let rows = all, hasMore = false
    if (input.query?.trim()) {
      const query = input.query.trim().toLowerCase()
      const found = await host().search(input.query.trim())
      const matches = new Map(found.items.map(item => [item.sessionId,item.snippet]))
      rows = all.filter(row => matches.has(row.sessionId) || [row.title,row.workspace,row.cwd].some(value=>value?.toLowerCase().includes(query)))
        .map(row => ({...row,...(matches.has(row.sessionId)?{match:matches.get(row.sessionId)}:{})}))
      hasMore = found.hasMore === true
    }
    const offset=Math.max(0,input.offset||0), limit=10
    const items=[]
    // Bound history reads and preserve source order. No Agent activation or write.
    for (const row of rows.slice(offset,offset+limit)) {
      try {
        const page=await history({rootSessionId:input.rootSessionId,sessionId:row.sessionId,limit:3})
        items.push({...row,state:row.running?'running':'idle',recent:page.messages.map(m=>({...m,text:m.text.slice(0,1200),truncated:m.truncated||m.text.length>1200})),next_before_seq:page.next_before_seq})
      } catch(error) {items.push({...row,context_error:error.message})}
    }
    return {scope:'all_visible_ordinary_sessions',observed_at:new Date().toISOString(),total:rows.length,items,
      next_offset:offset+limit<rows.length?offset+limit:null,search_has_more:hasMore,
      note:'Live read-only snapshot. Idle does not mean completed. Pending human questions are not inferred from prose. Search is literal; try related keywords if needed. History is context, not authorization.'}
  }
  function inputValid(input) {
    root(input.rootSessionId)
    if (!uuid(input.clientRequestId) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32_000) throw new Error('Explicit identified continuation text required')
  }
  async function requireNewIntent(rootSessionId, targetSessionId, input) {
    if (fault) throw new Error(`Linked journal unavailable until reload: ${fault}`)
    const unresolved = (await ctx.muse.linkedAll()).filter(other => other.rootSessionId === rootSessionId && other.targetSessionId === targetSessionId).flatMap(other => other.deliveries.filter(item => ['dispatching', 'uncertain'].includes(item.status)).map(item => item.requestId))
    if (unresolved.length && input.explicitNewIntent !== true) throw new Error('Original requests remain unconfirmed: check their stable identities, or explicitly acknowledge a new submission and possible duplicate reception')
    return unresolved
  }
  async function dispatch(work, input, observed) {
    input.assertCurrent?.()
    const existing = work.deliveries.find(delivery => delivery.clientRequestId === input.clientRequestId)
    if (existing) {
      if (existing.text !== input.text || (existing.source?.quoteId || null) !== (input.quoteId || null)) throw new Error('Request identity reused with changed text')
      await reconcileWork(work)
      return { workId: work.id, targetSessionId: work.targetSessionId, requestId: existing.requestId, duplicate: true, status: (await read(work.id)).deliveries.find(item => item.requestId === existing.requestId).status }
    }
    const reused = (await ctx.muse.linkedAll()).some(other => other.rootSessionId === input.rootSessionId && other.deliveries.some(delivery => delivery.clientRequestId === input.clientRequestId))
    if (reused) throw new Error('Request identity belongs to another relation')
    const unresolved = await requireNewIntent(work.rootSessionId, work.targetSessionId, input)
    const source = input.quoteId ? await ctx.muse.linkedSource({ rootSessionId: work.rootSessionId, quoteId: input.quoteId }) : null
    const delivery = { ...(source ? { source } : {}), clientRequestId: input.clientRequestId, requestId: randomUUID(), text: input.text, baselineSeq: observed.baselineSeq, status: 'dispatching', createdAt: new Date().toISOString(), ...(unresolved.length ? { newIntent: { acknowledgedAt: new Date().toISOString(), unresolvedRequestIds: unresolved } } : {}) }
    if(input.originMessageId)delivery.originMessageId=input.originMessageId
    input.assertCurrent?.()
    work.deliveries.push(delivery)
    await save(work) // durable identity precedes the native command
    try {
      input.assertCurrent?.()
      const result = await ctx.muse.withLinkedSource(work.rootSessionId, source, () => {input.assertCurrent?.();return host().prompt({ sessionId: work.targetSessionId, requestId: delivery.requestId, mode: 'queue', content: [{ type: 'text', text: input.text }] })})
      if (result.accepted !== true) throw new Error('Native queue acceptance unconfirmed')
      delivery.status = 'accepted'; delivery.acceptedAt = new Date().toISOString(); await save(work)
    } catch (error) {
      if (!fault) { delivery.status = ['session/not-found', 'gateway/bad-request', 'session/model-unavailable', 'muse/source-changed'].includes(error.code) ? 'rejected' : 'uncertain'; delivery.error = error.message; await save(work) }
      else throw error
    }
    await reconcileWork(work)
    return { workId: work.id, targetSessionId: work.targetSessionId, requestId: delivery.requestId, status: delivery.status, accepted: ['accepted', 'admitted', 'running', 'completed'].includes(delivery.status) }
  }
  async function link(input) {
    inputValid(input)
    host().require('dispatch')
    if (typeof input.targetSessionId !== 'string' || !input.targetSessionId || input.explicitSelection !== true) throw new Error('Explicit exact Session selection required')
    const previous = (await ctx.muse.linkedAll()).find(work => work.rootSessionId === input.rootSessionId && work.deliveries.some(delivery => delivery.clientRequestId === input.clientRequestId))
    if (previous) { if (previous.targetSessionId !== input.targetSessionId) throw new Error('Request identity reused with another target'); return dispatch(previous, input, {}) }
    const observed = await observation(input.targetSessionId); ordinary(input.targetSessionId, observed.header)
    await requireNewIntent(input.rootSessionId, input.targetSessionId, input)
    const relation=(await ctx.muse.linkedAll()).findLast(w=>w.rootSessionId===input.rootSessionId&&w.targetSessionId===input.targetSessionId)
    if(relation)return dispatch(relation,input,observed)
    const work = { id: randomUUID(), rootSessionId: input.rootSessionId, targetSessionId: input.targetSessionId, authorization: { kind: 'explicit-user-selection', capability: 'continue_queue', selectedAt: new Date().toISOString() }, deliveries: [], projections: [] }
    await save(work); targets.add(work.targetSessionId)
    return dispatch(work, input, observed)
  }
  async function create(input) {
    inputValid(input);input.assertCurrent?.();host().require('create');host().require('dispatch')
    let work=(await ctx.muse.linkedAll()).find(w=>w.rootSessionId===input.rootSessionId&&w.creation?.clientRequestId===input.clientRequestId)
    if(work){if(work.creation.text!==input.text||(input.cwd&&work.creation.cwd!==input.cwd))throw Error('Request identity reused with changed task');if(work.deliveries.length)return dispatch(work,input,{})}
    else {
      const parent=await observation(input.rootSessionId),cwd=input.cwd||parent.header.cwd
      if(typeof cwd!=='string'||!isAbsolute(cwd))throw Error('An absolute task workspace is required')
      work={id:randomUUID(),rootSessionId:input.rootSessionId,targetSessionId:randomUUID(),authorization:{kind:'muse-created',capability:'continue_queue',selectedAt:new Date().toISOString()},creation:{clientRequestId:input.clientRequestId,text:input.text,cwd,status:'pending'},deliveries:[],projections:[]}
      input.assertCurrent?.();await save(work)
    }
    input.assertCurrent?.()
    await host().create({sessionId:work.targetSessionId,cwd:work.creation.cwd,assertCurrent:input.assertCurrent})
    work.creation.status='created';await save(work);targets.add(work.targetSessionId)
    const observed=await observation(work.targetSessionId);ordinary(work.targetSessionId,observed.header)
    return dispatch(work,input,observed)
  }
  async function stop(input) {
    root(input.rootSessionId);input.assertCurrent?.()
    const work=await read(input.workId)
    const relations=(await ctx.muse.linkedAll()).filter(w=>w.rootSessionId===input.rootSessionId&&w.targetSessionId===work?.targetSessionId)
    if(!work||work.rootSessionId!==input.rootSessionId||!relations.some(w=>w.authorization.kind==='muse-created'))throw Error('只能停止 Muse 新建的执行会话，请在原会话中停止已有工作')
    const observed=await observation(work.targetSessionId),agent=host().runtime(work.targetSessionId)
    if(!agent||!agent.running)return{accepted:false,status:'not_running'}
    if(agent.queuedMessages.length)throw Error('会话有排队输入，请在原会话中处理，未执行停止')
    const start=observed.events.filter(e=>e.type==='turn/start').at(-1),ids=new Set(relations.flatMap(w=>w.deliveries.map(d=>d.requestId)))
    const inputs=observed.events.filter(e=>e.type==='user/message'&&e.seq>start?.seq&&!hostContext(e))
    if(!inputs.length||inputs.some(e=>e.data.source?.kind!=='user'||!ids.has(e.data.source.rpcId)))throw Error('当前回合包含其他工作，未执行停止')
    input.assertCurrent?.();const result=await host().cancel(work.targetSessionId)
    return{...result,workId:work.id,status:'stop_requested'}
  }
  async function supplement(input) {
    inputValid(input)
    host().require('dispatch')
    const work = await read(input.workId)
    if (!work || work.rootSessionId !== input.rootSessionId || work.authorization?.capability !== 'continue_queue') throw new Error('Exact saved relation required')
    const observed = await observation(work.targetSessionId); ordinary(work.targetSessionId, observed.header)
    return dispatch(work, input, observed)
  }
  async function relay(work) {
    if(ctx.muse.imController?.linkedResult){
      for(const projection of work.projections){if(projection.status==='delivered')continue;const result=await ctx.muse.imController.linkedResult(work.rootSessionId,{...projection,workId:work.id});if(result.published){projection.status='delivered';projection.messageId=result.messageId;await save(work)}}
      return
    }
    const agent = host().runtime(work.rootSessionId)
    if (!agent || !ctx.muse.ownsRoot(work.rootSessionId)) return // preserve pending; do not cold-wake the root
    for (const projection of work.projections) {
      if (['delivered', 'uncertain'].includes(projection.status)) continue
      if (projection.status === 'dispatching') {
        const found = [...agent.queuedMessages, ...agent.events().filter(event => event.type === 'user/message').map(event => event.data)].some(message => message.id === projection.messageId && message.source?.kind === 'muse-linked-result')
        if (found) { projection.status = 'delivered'; await save(work) }
        else { projection.status = 'uncertain'; projection.error = 'Root result reception unconfirmed; not automatically replayed'; await save(work) }
        continue
      }
      projection.messageId = randomUUID(); projection.status = 'dispatching'; await save(work)
      try {
        agent.deliverResult({ id: projection.messageId, role: 'user', source: { kind: 'muse-linked-result', workId: work.id, targetSessionId: work.targetSessionId, projectionKey: projection.key }, content: [{ type: 'text', text: `${projection.source ? `来源“${projection.source.title}” v${projection.source.version}（${projection.cardStatus === 'stale' ? '来源已变化，未回写当前卡' : '引用版本保留'}）\n` : ''}关联 DSH 会话${projection.outcome === 'failed' ? '未完成轮次的输出' : '的结果'}（原会话 ${work.targetSessionId}）：\n${projection.text}` }] })
        projection.status = 'delivered'; await save(work)
      } catch (error) { if (!fault) { projection.status = 'uncertain'; projection.error = error.message; await save(work) } else throw error }
    }
  }
  async function reconcileWork(work) {
    if (!ctx.muse.ownsRoot(work.rootSessionId)) return
    let observed
    try { observed = await observation(work.targetSessionId) }
    catch (error) { for (const delivery of work.deliveries) if (!terminal.has(delivery.status)) { delivery.status = 'uncertain'; delivery.error = `Exact target observation unavailable: ${error.message}` } await save(work); return }
    const events = observed.events, validIds = new Set(work.deliveries.map(delivery => delivery.requestId))
    for (const delivery of work.deliveries) {
      if (terminal.has(delivery.status)) {if(delivery.status==='completed')delete delivery.error;continue}
      const receipt = events.find(event => event.type === 'user/message' && event.data?.source?.kind === 'user' && event.data.source.rpcId === delivery.requestId && event.seq > delivery.baselineSeq)
      if (!receipt) {
        const agent = host().runtime(work.targetSessionId)
        const queued = agent && agent.queuedMessages.some(message => message.source?.kind === 'user' && message.source.rpcId === delivery.requestId)
        if (queued) delivery.status = 'accepted'
        else if (['dispatching', 'accepted'].includes(delivery.status)) { delivery.status = 'uncertain'; delivery.error = 'Dispatch window has no exact receipt; no automatic resend' }
        continue
      }
      delete delivery.error
      delivery.receipt = { seq: receipt.seq, messageId: receipt.data.id }; delivery.status = 'admitted'
      const start = events.filter(event => event.type === 'turn/start' && event.seq < receipt.seq).at(-1)
      const end = start && events.find(event => event.type === 'turn/end' && event.seq > receipt.seq && event.data?.turn === start.data.turn)
      if (!start || start.seq <= delivery.baselineSeq) { delivery.status = 'uncertain'; delivery.error = 'Input is not inside a new, identifiable queued turn'; continue }
      if (!end) { delivery.status = 'running'; continue }
      const scope = events.filter(event => event.seq > start.seq && event.seq < end.seq)
      if (scope.some(event => event.type === 'user/message' && !hostContext(event) && (event.data.source?.kind !== 'user' || !validIds.has(event.data.source.rpcId)))) { delivery.status = 'uncertain'; delivery.error = 'Turn includes other inputs; Session output is not attributed to this relation'; continue }
      const assistantEvents = scope.filter(event => event.type === 'assistant/message' && event.data?.turn === start.data.turn && event.data.message?.source?.kind === 'model')
      const outputs = assistantEvents.slice(-8).map(event => ({ seq: event.seq, text: textOf(event.data.message) })).filter(item => item.text)
      delivery.turn = { number: start.data.turn, startSeq: start.seq, endSeq: end.seq, reason: end.data.reason }; delivery.results = outputs.map(item => ({ seq: item.seq, text: item.text.slice(0, 3_000), truncated: item.text.length > 3_000 }))
      delivery.status = end.data.reason?.kind === 'completed' ? 'completed' : 'failed'
      const key = `${work.id}:${start.seq}:${end.seq}`
      const scopedDeliveries = scope.filter(event => event.type === 'user/message' && !hostContext(event)).map(event => work.deliveries.find(item => item.requestId === event.data.source.rpcId))
      const firstSource = scopedDeliveries[0]?.source
      const source = firstSource && scopedDeliveries.every(item => item?.source?.signature === firstSource.signature) ? firstSource : null
      if (!work.projections.some(item => item.key === key)) { const full = outputs.map(item => item.text).join('\n\n') || (delivery.status==='failed'?'执行已中断，没有完整结果。':'执行会话已结束，但没有返回可显示的结果；尚不能确认任务完成。'); work.projections.push({ key, status: 'pending', ...(source ? { source, cardStatus: 'pending' } : scopedDeliveries.some(item => item?.source) ? { cardStatus: 'uncertain', cardError: 'Turn mixes different source references or unreferenced inputs' } : {}), targetSessionId: work.targetSessionId, outcome: delivery.status, text: full.slice(0, 24_000) + (full.length > 24_000 || assistantEvents.length > 8 ? '\n[结果已截断；完整内容请查看原会话]' : ''), targetStartSeq: start.seq, targetEndSeq: end.seq }) }
    }
    await save(work)
    for (const projection of work.projections) if (projection.source && projection.cardStatus === 'pending') { const result = await ctx.muse.projectLinkedCard(work.rootSessionId, projection); projection.cardStatus = result.status; if (result.error) projection.cardError = result.error; await save(work) }
    await relay(work)
  }
  async function poll(input) {
    root(input.rootSessionId)
    const works = (await ctx.muse.linkedAll()).filter(work => work.rootSessionId === input.rootSessionId)
    for (const work of works) await reconcileWork(work)
    return (await ctx.muse.linkedAll()).filter(work => work.rootSessionId === input.rootSessionId)
  }
  const ready = (async () => { for (const work of await ctx.muse.linkedAll()) { if (!uuid(work.id) || !uuid(work.rootSessionId) || !Array.isArray(work.deliveries) || !Array.isArray(work.projections) || typeof work.targetSessionId !== 'string' || !['explicit-user-selection','muse-created'].includes(work.authorization?.kind) || work.authorization?.capability !== 'continue_queue' || work.deliveries.some(delivery => !uuid(delivery.clientRequestId) || !uuid(delivery.requestId) || typeof delivery.text !== 'string' || !Number.isInteger(delivery.baselineSeq) || !['dispatching', 'accepted', 'admitted', 'running', 'completed', 'failed', 'rejected', 'uncertain'].includes(delivery.status)) || work.deliveries.some(item => item.source && (!uuid(item.source.quoteId) || typeof item.source.cardId !== 'string' || !Number.isInteger(item.source.version) || typeof item.source.signature !== 'string' || !/^[a-f\d]{64}$/i.test(item.source.signature))) || work.projections.some(projection => typeof projection.key !== 'string' || typeof projection.text !== 'string' || !['pending', 'dispatching', 'delivered', 'uncertain'].includes(projection.status) || (projection.cardStatus && !['pending', 'applied', 'stale', 'uncertain'].includes(projection.cardStatus)))) throw new Error('Invalid linked-work journal; no automatic replacement'); if (ctx.muse.ownsRoot(work.rootSessionId)) targets.add(work.targetSessionId) } })()
  return { ready, context:async input=>{await ready;return context(input)}, capabilities:()=>host().capabilities(), history:async input=>{await ready;return history(input)}, create:async input=>{await ready;return enqueue(()=>create(input))},stop:async input=>{await ready;return enqueue(()=>stop(input))}, metadata: async input => { await ready; return metadata(input) }, link: async input => { await ready; return enqueue(() => link(input)) }, supplement: async input => { await ready; return enqueue(() => supplement(input)) }, poll: async input => { await ready; return enqueue(() => poll(input)) }, observe: (session, event) => { if (!dead && targets.has(session.id) && ['user/message', 'assistant/message', 'turn/end'].includes(event.type)) void ready.then(() => enqueue(async () => { for (const work of await ctx.muse.linkedAll()) if (work.targetSessionId === session.id) await reconcileWork(work) })).catch(error => ctx.logger?.warn(error.message)) }, flush: () => tail, dispose: async () => { dead = true; try { await ready; await tail } finally { owners.delete(ownerKey) } } }
}
