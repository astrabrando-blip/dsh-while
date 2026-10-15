import {basename} from 'node:path'

// The only DSH command/query boundary for Muse's ordinary-session coordination.
// Keep native permissions and durable Session ownership entirely in the host.
export function createSessionHost(ctx, {workspaceRegistry} = {}) {
  const has = (service, method) => typeof service?.[method] === 'function'
  const capabilities = () => ({
    list: has(ctx.sessionController, 'list'),
    search: has(ctx.sessionController, 'search'),
    history: has(ctx.sessionQuery, 'observeSession'),
    workspaceNames: has(workspaceRegistry, 'list'),
    create: has(ctx.sessionController, 'create') && has(workspaceRegistry, 'create'),
    dispatch: has(ctx.sessionController, 'prompt'),
    stop: has(ctx.sessionController, 'cancel'),
  })
  function requireCapability(name) {
    if (!capabilities()[name]) {
      const error = new Error(`当前 DSH 未提供会话能力：${name}；其他 Muse 功能可继续使用`)
      error.code = 'muse/capability-unavailable'
      throw error
    }
  }
  return {
    capabilities,
    isOwnedChild(id, header) {
      const agent=ctx.agents.get(id), parent=header.parentSession && ctx.agents.get(header.parentSession)
      return header.origin==='subagent' || Boolean(agent && parent && ctx.agents.isOwnedBy(agent.id,parent))
    },
    runtime(id) {
      const agent=ctx.agents.get(id)
      if (!agent) return null
      return {running:agent.status==='running',queuedMessages:[...agent.inbox.nextTurn,...agent.inbox.nextStep],
        events:()=>agent.session.snapshotEvents(), deliverResult:message=>agent.followup(message)}
    },
    require: requireCapability,
    async observe(id) {
      requireCapability('history')
      const value = await ctx.sessionQuery.observeSession(id, {projectionMode:'none'})
      try {
        if (value.header.id !== id) throw new Error('Session identity mismatch')
        return {header:value.header, events:value.events.slice(value.inheritedEventCount || 0), baselineSeq:value.events.at(-1)?.seq ?? -1}
      } finally { value[Symbol.dispose]() }
    },
    async search(query) {
      requireCapability('search')
      return ctx.sessionController.search({query}, new AbortController().signal)
    },
    async list() {
      requireCapability('list')
      const listed = await ctx.sessionController.list({}, new AbortController().signal)
      const workspaces = capabilities().workspaceNames ? workspaceRegistry.list() : []
      return listed.items.map(item => ({
        sessionId:item.sessionId, ...(item.updatedAt!==undefined?{updatedAt:item.updatedAt}:{}), ...(typeof item.origin==='string'?{origin:item.origin}:{}),
        workspace:workspaces.find(w=>w.sessionIds.includes(item.sessionId))?.title || '',
        ...(typeof item.cwd==='string'?{cwd:item.cwd}:{}), running:item.running===true,
        title:typeof item.projections?.values?.title==='string'?item.projections.values.title:item.sessionId,
      }))
    },
    async create({sessionId,cwd,assertCurrent}) {
      requireCapability('create')
      assertCurrent?.()
      const workspace = await workspaceRegistry.create(cwd, basename(cwd))
      assertCurrent?.()
      const created = await ctx.sessionController.create({sessionId,workspaceId:workspace.id})
      if (created.sessionId !== sessionId) throw new Error('Created Session identity mismatch')
      return created
    },
    prompt(request) {
      requireCapability('dispatch')
      return ctx.sessionController.prompt(request, new AbortController().signal)
    },
    cancel(sessionId) {
      requireCapability('stop')
      return ctx.sessionController.cancel({sessionId})
    },
  }
}
