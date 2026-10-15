import { randomUUID } from 'node:crypto'

export const QUESTION_MARKER = '[Muse工作问题]'
const activeQuestions = new Set(['pending', 'asking', 'answered', 'dispatching', 'uncertain', 'blocked'])
export async function updateWork(ctx, id, update) {
  if (ctx.muse.taskUpdate) return ctx.muse.taskUpdate(id, update)
  // Only isolated adapters lack the installed domain's atomic per-record update.
  const current = (await ctx.muse.taskList()).find(task => task.id === id)
  if (!current) throw new Error('Muse work not found')
  const next = update(current); await ctx.muse.taskPut(next); return next
}
export function questionReport(text) {
  const index = text.indexOf(QUESTION_MARKER)
  if (index < 0) return null
  if (text.indexOf(QUESTION_MARKER, index + QUESTION_MARKER.length) >= 0) return null
  const payload = text.slice(index + QUESTION_MARKER.length).trimStart()
  if (payload[0] !== '{') return null
  let depth = 0, quoted = false, escaped = false, end = -1
  for (let i = 0; i < payload.length; i++) {
    const char = payload[i]
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
    if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) { end = i + 1; break }
  }
  if (end < 0 || /[{}\[\]]/.test(payload.slice(end))) return null
  let value
  try { value = JSON.parse(payload.slice(0, end)) } catch { return null }
  if (value.museWorkQuestion !== 1 || typeof value.questionId !== 'string' || !value.questionId.trim() || value.questionId.length > 120 || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > 6) return null
  const ids = new Set()
  const questions = value.questions.map(question => {
    if (typeof question.id !== 'string' || !question.id || ids.has(question.id) || typeof question.question !== 'string' || !question.question.trim() || question.question.length > 2000) throw new Error('Invalid work question')
    ids.add(question.id)
    if (question.detail !== undefined && (typeof question.detail !== 'string' || question.detail.length > 12000)) throw new Error('Invalid question detail')
    if (question.options !== undefined && (!Array.isArray(question.options) || question.options.length > 12 || question.options.some(option => typeof option.label !== 'string' || !option.label || (option.description !== undefined && typeof option.description !== 'string')))) throw new Error('Invalid question options')
    return { id: question.id, question: question.question, ...(question.detail !== undefined ? { detail: question.detail } : {}), ...(question.options ? { options: question.options.map(option => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })) } : {}), ...(question.multiSelect === true ? { multiSelect: true } : {}) }
  })
  return { id: value.questionId, questions }
}
export function createWorkQuestions(ctx) {
  const claims = new Set()
  const read = async id => (await ctx.muse.taskList()).find(task => task.id === id)
  const sourceCurrent = async task => {
    if (!ctx.muse.candidateContext) return true // isolated work adapters without source-domain integration
    const sources = await ctx.muse.candidateContext(task.rootSessionId)
    if (task.source && ctx.muse.sourceCheck) {
      try { return (await ctx.muse.sourceCheck(task.rootSessionId, task.source.quoteId)).signature === task.source.signature } catch { return false }
    }
    const source = sources.find(item => item.anchorId === task.anchor)
    // Message-only independent work has a stable original request, not a mutable goal.
    return task.anchor === `message:${task.id}` || source?.version === task.version
  }
  async function ingest(task, message, text) {
    if (!ctx.muse.ownsRoot(task.rootSessionId) || !['agent-message', 'subagent-settled'].includes(message.source?.kind) || message.source.senderSessionId !== task.childId) return false
    let report
    try { report = questionReport(text) } catch { report = null }
    if (report && !['stopping', 'stopped', 'failed'].includes(task.status)) {
      await updateWork(ctx, task.id, current => {
        if (current.question?.id === report.id || (current.question && activeQuestions.has(current.question.status))) return current
        const { error: previousError, ...rest } = current
        return { ...rest, status: 'awaiting_user', ...(current.question ? { questionHistory: [...(current.questionHistory || []), current.question] } : {}), question: { ...report, sourceMessageId: String(message.id), senderSessionId: task.childId, status: 'pending', createdAt: new Date().toISOString() } }
      })
      return true
    }
    if ((text.includes(QUESTION_MARKER) && !report) || /human interaction is unavailable while the calling agent is owned by another live agent|DELEGATED_CALLER/.test(text)) {
      await updateWork(ctx, task.id, current => ({ ...current, status: current.question && activeQuestions.has(current.question.status) ? 'awaiting_user' : 'blocked', error: '子工作需要父主聊承接问题；尚未取得完整结构化问题，不宣称完成。' }))
      return true
    }
    return false
  }
  async function recover(agent) {
    if (!ctx.muse.ownsRoot(agent.session.id) || !ctx.sessionQuery) return
    const tasks = (await ctx.muse.taskList()).filter(task => task.rootSessionId === agent.session.id && task.status === 'blocked' && !task.question && task.childId && task.results?.some(result => result.text?.includes(QUESTION_MARKER)))
    if (!tasks.length) return
    const observation = await ctx.sessionQuery.observeSession(agent.session.id, { projectionMode: 'none' })
    try {
      const own = observation.events.slice(observation.inheritedEventCount || 0)
      for (const task of tasks) {
        const reports = own.filter(event => event.type === 'user/message' && task.receipts.includes(String(event.data?.id)) && ['agent-message', 'subagent-settled'].includes(event.data?.source?.kind) && event.data.source.senderSessionId === task.childId).map(event => ({ message: event.data, text: (event.data.content || []).map(block => block.text || '').join('') })).filter(item => task.results.some(result => result.source === item.message.source.kind && result.text === item.text))
        const parsed = reports.map(item => { try { return { ...item, report: questionReport(item.text) } } catch { return { ...item, report: null } } }).filter(item => item.report)
        if (!parsed.length || new Set(parsed.map(item => JSON.stringify(item.report))).size !== 1) continue
        const child = await ctx.sessionQuery.observeSession(task.childId, { projectionMode: 'none' })
        let owned = false
        try { owned = child.header?.parentSession === agent.session.id && child.header?.origin === 'subagent' } finally { child[Symbol.dispose]() }
        if (owned) await ingest(task, parsed[0].message, parsed[0].text)
      }
    } finally { observation[Symbol.dispose]() }
  }
  async function ask(agent, input, signal) {
    const key = `${agent.session.id}:${input.task_id}:${input.question_id}`
    let task = await read(input.task_id)
    if (!ctx.muse.ownsRoot(agent.session.id) || task?.rootSessionId !== agent.session.id || task.question?.id !== input.question_id) throw new Error('Exact owned Muse work question required: use task_id (not childId) and registered pendingQuestion.question_id from muse_work_context; never substitute generic ask or reuse an unbridged answer')
    if (claims.has(key)) return { waiting: true, questionId: input.question_id }
    if (task.question.status === 'accepted') return { accepted: true, duplicate: true, childId: task.childId, messageId: task.question.receiptId }
    if (task.question.status !== 'pending') return { accepted: false, status: task.question.status, reason: '问题已取消、回答或处于未确认窗口；不自动重问或重发。' }
    claims.add(key)
    try {
      if (!await sourceCurrent(task)) {
        await updateWork(ctx, task.id, current => ({ ...current, status: 'blocked', question: { ...current.question, status: 'blocked', error: '来源版本已变化，未请求回答或继续旧工作。' } }))
        return { accepted: false, status: 'blocked' }
      }
      signal.throwIfAborted()
      await updateWork(ctx, task.id, current => ({ ...current, question: { ...current.question, status: 'asking' } }))
      let answer
      try { answer = await ctx.userQuestions.ask({ agent, questions: task.question.questions, signal }) }
      catch (error) {
        const status = signal.aborted || ['ASK_CANCELLED', 'ASK_ABORTED'].includes(error.code) ? 'cancelled' : 'blocked'
        await updateWork(ctx, task.id, current => ({ ...current, status: ['stopping', 'stopped'].includes(current.status) ? current.status : status === 'cancelled' ? 'awaiting_user' : 'blocked', question: { ...current.question, status, error: error.message || String(error) } }))
        return { accepted: false, status, reason: '问题未取得回答；未批准、未投递或继续子工作。' }
      }
      const ids = new Set(task.question.questions.map(question => question.id))
      const invalid = !Array.isArray(answer?.answers) || answer.answers.length !== ids.size || new Set(answer.answers.map(item => item?.id)).size !== ids.size || answer.answers.some(item => {
        const question = task.question.questions.find(question => question.id === item?.id)
        return !question || !Array.isArray(item.selected) || new Set(item.selected).size !== item.selected.length || item.selected.some(value => typeof value !== 'string' || !question.options?.some(option => option.label === value)) || (!question.multiSelect && item.selected.length > 1) || (item.custom !== undefined && typeof item.custom !== 'string') || (!item.selected.length && !item.custom?.trim())
      })
      if (invalid) {
        await updateWork(ctx, task.id, current => ({ ...current, status: 'blocked', question: { ...current.question, status: 'blocked', error: '原生回答与原问题不匹配；未投递。' } }))
        return { accepted: false, status: 'blocked' }
      }
      const answerId = randomUUID()
      task = await updateWork(ctx, task.id, current => ({ ...current, question: { ...current.question, status: 'answered', answerId, answer, answeredAt: new Date().toISOString() } }))
      if (signal.aborted || task.status !== 'awaiting_user' || !await sourceCurrent(task)) {
        await updateWork(ctx, task.id, current => ({ ...current, status: ['stopping', 'stopped'].includes(current.status) ? current.status : 'blocked', question: { ...current.question, status: 'blocked', error: '回答期间工作已停止或来源版本改变，原答案已保存但未投递。' } }))
        return { accepted: false, status: 'blocked', answerId }
      }
      await updateWork(ctx, task.id, current => ({ ...current, status: 'resuming', question: { ...current.question, status: 'dispatching' } }))
      let messageId
      try {
        messageId = await ctx.subagents.sendMessage(agent, task.childId, [{ type: 'text', text: JSON.stringify({ museWorkAnswer: 1, taskId: task.id, questionId: task.question.id, answerId, anchor: task.anchor, version: task.version, answer, instruction: '继续原已授权工作，吸收原始答案。答案不是敏感工具审批，不扩大执行权限；重复answerId不重复执行。' }) }], { signal })
        if (typeof messageId !== 'string' || !messageId) throw new Error('Native child acceptance lacks messageId')
        await updateWork(ctx, task.id, current => ({ ...current, status: current.status === 'resuming' ? 'running' : current.status, ...(current.status === 'settled' ? {} : { runtimeState: 'running' }), question: { ...current.question, status: 'accepted', receiptId: messageId } }))
      } catch (error) {
        await updateWork(ctx, task.id, current => ({ ...current, status: 'uncertain', question: { ...current.question, status: 'uncertain', error: error.message || String(error) } }))
        return { accepted: false, status: 'uncertain', answerId, reason: '接收未确认；保留原答案，不自动重发。' }
      }
      return { accepted: true, childId: task.childId, questionId: task.question.id, answerId, messageId }
    } finally { claims.delete(key) }
  }
  return { ingest, ask, recover }
}
