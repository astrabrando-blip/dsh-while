/** Public installed scoped policy. Never reduces an unrelated Session's tools. */
export function installMuseToolBoundary(ctx, agent) {
  const tools = agent.ctx.tools
  const stopGuard = tools.guard(exec => {
    if (exec.agent !== agent) return
    if (exec.name === 'create_goal' || (exec.name === 'update_goal' && !['complete', 'pause'].includes(exec.arguments?.action))) return 'Muse goals use muse_set_goal or the goal UI; native autonomous goal creation/activation is unavailable in this Muse root.'
    if (exec.name === 'ask_user_question') {
      const tasks = ctx.muse.tasks?.entries ? [...ctx.muse.tasks.entries()].map(([, task]) => task) : []
      if (tasks.some(task => task.rootSessionId === agent.session.id && ['blocked', 'awaiting_user', 'resuming'].includes(task.status))) return 'Owned work questions require muse_work_context and muse_ask_work_question; generic ask cannot deliver answers to the child.'
    }
  })
  // The guard remains authoritative for late registrations or scoped overrides.
  const exposed = tools.schemas?.(agent) || []
  const stopMask = exposed.some(tool => tool.name === 'create_goal') ? tools.restrict({ deny: ['create_goal'] }) : () => {}
  return () => { stopMask(); stopGuard() }
}
