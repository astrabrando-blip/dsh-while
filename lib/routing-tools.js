/** Registered only in the persisted Muse root's agent scope. */
export function registerRoutingTools(ctx, agent, handleWork) {
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  const disposers = [agent.ctx.tools.register({
    name: 'muse_set_goal',
    description: 'Save a Muse concern only, with NO autonomous Session goal or background work. References the exact latest human message beginning 请设为 Muse 目标：. No rewritten title. For other wording use the explicit Muse goal UI.',
    parameters: { type: 'object', additionalProperties: false, properties: { message_id: { type: 'string' } }, required: ['message_id'] }, output,
    async execute(args, exec) { if (exec.agent !== agent) throw new Error('Muse root scope required'); return handleWork.setGoal(agent, args) }
  }), agent.ctx.tools.register({
    name: 'muse_work_context',
    description: 'Read this Muse root’s independent tasks and authoritative sourceStates for recent persisted human inputs before deciding semantic association or claiming a reference is current. Matching displayed text to its own snapshot is not proof of current validity. Ordinary messages remain in the main chat. New topics and independent new tasks must not be forwarded to existing work. For ambiguity ask a short clarification.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
    async execute(_args, exec) {
      if (exec.agent !== agent || !ctx.muse.ownsRoot(agent.session.id)) throw new Error('Muse root scope required')
      await handleWork.flush()
      await handleWork.reconcile(agent)
      const tasks = (await ctx.muse.taskList()).filter(task => task.rootSessionId === agent.session.id)
      const inputs = [...ctx.muse.inbox.entries()].map(([, item]) => item).filter(item => item.rootSessionId === agent.session.id).slice(-8)
      const sourceStates = await Promise.all(inputs.map(item => ctx.muse.sourceState({ rootSessionId: agent.session.id, messageId: item.messageId })))
      return { sourceStates, routingRevision: 'muse-source-admission-v7-20261003', tasks: tasks.map(task => ({ task_id: task.id, childId: task.childId, status: task.status, ...(task.runtimeState ? { runtimeState: task.runtimeState } : {}), ...(task.question ? { pendingQuestion: { question_id: task.question.id, status: task.question.status, questions: task.question.questions, ...(task.question.error ? { error: task.question.error } : {}) } } : {}), anchor: task.anchor, version: task.version, request: task.requestText || '', topic: ctx.muse.topicFor(agent.session.id, task.anchor, task.version), latestResult: task.results.at(-1)?.text || '' })) }
    }
  }), agent.ctx.tools.register({
    name: 'muse_ask_work_question',
    description: 'Ask the exact unresolved owned work question through the parent native human carrier; captures the original human answer and resumes the SAME child only after durable validation. Do not provide or rewrite answers. Cancellation is not approval; uncertain receipt is never automatically resent.',
    parameters: { type: 'object', additionalProperties: false, properties: { task_id: { type: 'string' }, question_id: { type: 'string' } }, required: ['task_id', 'question_id'] }, output,
    async execute(args, exec) { if (exec.agent !== agent) throw new Error('Muse root scope required'); return handleWork.askQuestion(agent, args, exec.signal) }
  }), agent.ctx.tools.register({
    name: 'muse_start_work',
    description: 'Start a separate independent work ONLY after main-chat semantic interpretation confirms an explicit human request for NEW background work. Same-topic different-goal requests need a new work, not a supplement. Ambiguity stays in main chat. The exact persisted human input becomes its own source anchor; no rewrite and no inferred adoption. The host deterministically rejects stale or invalid persisted source references BEFORE intent assessment. Never infer current validity from snapshot text; consult authoritative sourceStates. The host independently checks the literal human request and latest input without source suggestions or tools. It may return started:false for discussion, supplement, stop/goal control or ambiguity; never bypass that decision. Return is launch status, not completion.',
    parameters: { type: 'object', additionalProperties: false, properties: { message_id: { type: 'string' }, reason: { type: 'string' } }, required: ['message_id', 'reason'] }, output,
    async execute(args, exec) { if (exec.agent !== agent) throw new Error('Muse root scope required'); return handleWork.start(agent, args, exec.signal) }
  }), agent.ctx.tools.register({
    name: 'muse_associate_message',
    description: 'After MAIN CHAT semantic interpretation, associate an exact user message with one existing task. Use supplement only when clearly modifying that same work; pronoun references require unambiguous context. Use stop only for a clear user stop instruction targeting that task. New topics, independent new tasks and ambiguity stay in main chat. Never invent or rewrite the input; host forwards persisted original text. Receipt means delivery/stop request, not completion.',
    parameters: { type: 'object', additionalProperties: false, properties: { message_id: { type: 'string' }, task_id: { type: 'string' }, action: { type: 'string', enum: ['supplement', 'stop'] }, reason: { type: 'string' } }, required: ['message_id', 'task_id', 'action', 'reason'] }, output,
    async execute(args, exec) {
      if (exec.agent !== agent) throw new Error('Muse root scope required')
      return handleWork.route(agent, args, exec.signal)
    }
  })]
  return () => disposers.forEach(dispose => dispose())
}
