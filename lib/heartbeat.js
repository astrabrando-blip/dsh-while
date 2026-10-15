import { randomUUID, createHash } from 'node:crypto'
import { museMessage } from './work.js'
/** Separate plugin-owned Session: no parent followup, no root maintenance run. */
export function createHeartbeatRunner(ctx) {
  const live = new Map(), pending = new Map(), finishing = new Set()
  let closed = false
  async function rootDigest(root) {
    if (!ctx.sessionQuery) return null
    const observation = await ctx.sessionQuery.observeSession(root, { projectionMode:'none' })
    try { return { events: observation.events.length, lastSeq: observation.events.at(-1)?.seq ?? null, lastTurnReason:observation.events.filter(event => event.type === 'turn/end').at(-1)?.data?.reason || null, sha256:createHash('sha256').update(JSON.stringify(observation.events)).digest('hex') } }
    finally { observation[Symbol.dispose]() }
  }
  async function generate(rootSessionId, { synthetic = false } = {}) {
    if (closed || !ctx.muse.ownsRoot(rootSessionId)) throw new Error('Muse heartbeat root unavailable')
    if (live.has(rootSessionId)) return { generating: true, workerId: live.get(rootSessionId).job.workerId }
    const sources = await ctx.muse.candidateContext(rootSessionId)
    if (!sources.length) return { generating: false, reason: 'no-human-anchor' }
    const syntheticSource = synthetic && sources.find(source => source.origin === '目标' && /^合成/.test(source.sourceText))
    if (synthetic && !syntheticSource) throw new Error('Controlled heartbeat requires an authorized synthetic goal')
    const job = { id: randomUUID(), rootSessionId, workerId: randomUUID(), status: 'generating', createdAt: new Date().toISOString(), evidence:{ rootBefore:await rootDigest(rootSessionId), synthetic }  }
    const slot = { job, handle: null }; live.set(rootSessionId, slot)
    try {
      await ctx.muse.heartbeatJobPut(job)
      const rootAgent = ctx.agents.get?.(rootSessionId)
      const selected = rootAgent?.session.requestHeader()?.config
      const agentOptions = rootAgent ? { ...rootAgent.options, ...(selected ? { provider:selected.provider, model:selected.model, ...(selected.reasoningEffort ? { reasoningEffort:selected.reasoningEffort } : {}) } : {}) } : {}
      if (!agentOptions.model) throw new Error('Muse current model selection unavailable; candidate not generated')
      const handle = await ctx.agents.create({ sessionId: job.workerId, meta: { cwd: rootAgent.session.header.cwd }, agentOptions, setup(workerCtx) {
        workerCtx.tools.restrict({ allow: [] }) // mask global execution tools; scoped publisher stays visible
        workerCtx.tools.register({ name: 'muse_publish_candidate', description: 'Persist one specific new candidate in the authorized Muse Feed. This does not send a chat message or execute work. Existing equivalent insight is rejected as duplicate.', parameters: { type: 'object', additionalProperties: false, properties: { anchorId:{type:'string'}, version:{type:'integer'}, title:{type:'string'}, newInformation:{type:'string'}, suggested:{type:'string'} }, required:['anchorId','version','title','newInformation','suggested'] }, output: { schema:{type:'object',additionalProperties:true}, render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}] }, async execute(input, exec) {
          if (exec.agent.session.id !== job.workerId || !live.has(rootSessionId)) throw new Error('Muse candidate worker scope required')
          const result = await ctx.muse.publishCandidate(rootSessionId, input)
          job.evidence.publishResult = result
          return result
        } })
        workerCtx.systemPrompt.section({ name:'muse:quiet-candidate', order:1000, text:'你只在独立候选会话工作，不属于Muse主聊天。仅依据给定用户来源推理，不使用文件/网络/外部服务，不调用send_message、不派子任务、不执行建议。没有具体新价值直接结束。候选必须用muse_publish_candidate提交；不要通过聊天正文发布。提交后结束，不再调用工具。提醒是否发给用户是另一项行为，此处不发提醒。' })
        workerCtx.on('agent/status', ({ status }) => { if (status === 'idle' && slot.handle) { const done = finish(slot); finishing.add(done); void done.finally(() => finishing.delete(done)).catch(error => ctx.logger?.warn(`Muse candidate close: ${error.message}`)) } })
      } })
      slot.handle = handle
      const exact = syntheticSource && { anchorId: syntheticSource.anchorId, version: syntheticSource.version, title:'先核对准备时间能否按议题分摊', newInformation:'即使两方案会议时长成比例，若准备工作不能跨议题复用，按单个问题比较的成本也不必相同。', suggested:'先确认两方案的准备时间是否按场次计，能否跨议题复用；把未知的分摊条件列出来，再判断它是否会改变单位成本。' }
      const input = exact ? `这是一次已授权合成路径验收。仅调用muse_publish_candidate一次，逐字使用以下JSON（包括重复轮也提交同一JSON，让宿主检查重复），之后结束：\n${JSON.stringify(exact)}` : `为以下用户目标/历史关切寻找最多一个具体新灵感。必须准确选择当前anchorId与version，newInformation说明新增推理，不得把假设当作已知事实；suggested给具体可核对条件。不值得发布则结束。\n${JSON.stringify(sources)}`
      handle.agent.followup(museMessage(input))
      return { generating:true, workerId:job.workerId }
    } catch (error) {
      live.delete(rootSessionId)
      try { await ctx.muse.heartbeatJobPut({ ...job, status:'failed', error:error.message || String(error) }) } catch { /* scheduling backoff is independent of unavailable storage */ }
      finally { if(slot.handle) await slot.handle.dispose() }
      throw error
    }
  }
  async function finish(slot) {
    if (!live.has(slot.job.rootSessionId)) return
    live.delete(slot.job.rootSessionId)
    try { const worker = await rootDigest(slot.job.workerId); await ctx.muse.heartbeatJobPut({ ...slot.job, status: worker && worker.lastTurnReason?.kind !== 'completed' ? 'failed' : 'completed', evidence:{ ...slot.job.evidence, workerTerminal:worker, rootAfter:await rootDigest(slot.job.rootSessionId) } }) }
    catch (error) { await ctx.muse.heartbeatJobPut({ ...slot.job,status:'failed',error:error.message || String(error) }) }
    finally { await slot.handle.dispose() }
  }
  function run(root, options) {
    if (pending.has(root)) return pending.get(root)
    const operation = generate(root, options).finally(() => pending.delete(root))
    pending.set(root, operation)
    return operation
  }

  return { run, async dispose() { closed=true; await Promise.allSettled([...pending.values()]); await Promise.allSettled([...finishing]); for (const slot of [...live.values()]) { live.delete(slot.job.rootSessionId); await slot.handle?.dispose(); await ctx.muse.heartbeatJobPut({ ...slot.job,status:'failed',error:'候选生成因插件关闭而结束；未宣称发布' }) } } }
}
