import { withResultFiles } from './result-files.js'
import { discoverGoals, decideGoalProposal } from './goal-discovery.js'
import { updateIdeaFeedback } from './idea-feedback.js'
import {emptyMemory,changeMemory,readMemory,memoryContext} from './memory.js'
import {createConsentControl,consentHash,consentRevision,syntheticObservation,syntheticCommunity,previewInitial} from './observation-consent.js'
import {createAnalysisProvider,readPluginInventory,readAnalysisRoute,analysisPacket,validateSemanticSourceCards} from './observation-analysis.js'
import {createCommunitySource} from './community-source.js'
import {createObservationOwner,observationInitial,searchCommunity,observationLimits,observationRevision} from './observation.js'
import {imDomainSpec} from './im-journal.js'
import { sourceAttribution } from './source-attribution.js'
import { foldSurface } from './vendor/session-surface.js'
import { captureDiscoveryContext, validateContextPacket, contextFreshness, contextReferences, latestContextIncomplete, validateImInsight, buildImDiscoveryContext } from './discovery-context.js'
import { candidateQuality } from './discovery-quality.js'
import { requestQuote } from './request-source.js'
import { randomUUID, createHash } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { isConcern, validateCandidate, equivalent } from './candidates.js'

const hashSource = value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sourceSignature = card => createHash('sha256').update(JSON.stringify(['cardId', 'anchorId', 'version', 'kind', 'origin', 'sourceText', 'title', 'suggested', 'newInformation', 'fingerprint'].map(key => card[key] ?? null).concat(card.quality ? [card.quality] : []).concat(card.contextEvidence ? [card.contextEvidence] : []).concat(card.observation ? [card.observation,card.insight??null] : []).concat(card.sourceFullHash ? [card.sourceFullHash,card.sourceTextHash] : []))).digest('hex')
const goal = z.object({ id: z.string(), title: z.string().min(1), done: z.boolean(), version: z.number().int().positive(), sourceMessageId: z.string().optional(), mutationId: z.string().optional(), proposalId: z.string().optional(), linkedResults: z.array(z.record(z.string(), z.unknown())).optional() })
const record = z.object({ identity: z.enum(['muse', 'muse-qa']), rootSessionId: z.string().uuid(), revision: z.number().int().nonnegative(), goals: z.array(goal), goalProposals: z.array(z.record(z.string(), z.unknown())).optional(), saved: z.array(z.record(z.string(), z.unknown())).optional(), candidates: z.array(z.record(z.string(), z.unknown())).optional(), archivedRoots: z.array(z.object({ rootSessionId: z.string().uuid(), reason: z.string(), archivedAt: z.string() })).optional() })
export const domainSpec = { name: 'muse_desktop', version: 1, tables: { linked_work: { valueSchema: z.unknown() }, heartbeat_control: { valueSchema: z.unknown() }, heartbeat_jobs: { valueSchema: z.object({ id: z.string().uuid(), rootSessionId: z.string().uuid(), workerId: z.string().uuid(), status: z.enum(['generating', 'completed', 'failed', 'unknown', 'blocked']), createdAt: z.string(), evidence: z.record(z.string(), z.unknown()).optional(), error: z.string().optional() }) }, inbox: { valueSchema: z.object({ messageId: z.string(), rootSessionId: z.string().uuid(), text: z.string(), rpcId: z.string().optional(), workIntent: z.record(z.string(), z.unknown()).optional() }) }, quotes: { valueSchema: z.object({ id: z.string().uuid(), rootSessionId: z.string().uuid(), snapshot: z.record(z.string(), z.unknown()), createdAt: z.string() }) }, identity: { valueSchema: record }, tasks: { valueSchema: z.object({ id: z.string(), rootSessionId: z.string().uuid().optional(), requestText: z.string().optional(), authorization: z.record(z.string(), z.unknown()).optional(), source: z.record(z.string(), z.unknown()).optional(), sourceCardId: z.string().optional(), topicTerms: z.array(z.string()).optional(), childId: z.string().uuid(), anchor: z.string(), version: z.number(), status: z.enum(['provisioning', 'running', 'settled', 'failed', 'stopping', 'stopped', 'awaiting_user', 'resuming', 'blocked', 'uncertain']), runtimeState: z.enum(['running', 'settled']).optional(), question: z.record(z.string(), z.unknown()).optional(), questionHistory: z.array(z.record(z.string(), z.unknown())).optional(), error: z.string().optional(), lifecycleEvidence: z.record(z.string(), z.unknown()).optional(), receipts: z.array(z.string()), results: z.array(z.object({ source: z.string(), text: z.string() })) }) } } }

export const runtimeSpec = { name: 'muse_desktop_runtime', version: 1, tables: { heartbeat_control: { valueSchema: z.unknown() }, linked_work: { valueSchema: z.unknown() }, legacy_imports: { valueSchema: z.unknown() } } }
const compatibleHeartbeatJob = job => ['unknown', 'blocked'].includes(job.status) ? { ...job, status: job.status === 'unknown' ? 'generating' : 'failed', evidence: { ...job.evidence, runtimeStatus: job.status } } : job

/** Completion evidence changes presentation only; retained roots and archives remain intact. */
export function projectHistoryRecovery(identity,archives) {
  const covered=new Set(archives.filter(a=>a?.status==='completed'&&a.plan?.rootSessionId===identity.rootSessionId&&a.identity?.rootSessionId===identity.rootSessionId).flatMap(a=>(a.identity.archivedRoots||[]).map(r=>r.rootSessionId)))
  return {...identity,...(identity.archivedRoots?{archivedRoots:identity.archivedRoots.map(r=>({...r,recoveryRequired:!covered.has(r.rootSessionId)}))}:{})}
}

/** One serialized writer; a reservation precedes Session materialization. */
export class MuseService extends TypertRemoteService {
  static inject = ['storageDomain']
  constructor(ctx) { super(ctx, 'muse'); this.tail = Promise.resolve(); this.closed = false }
  async [Service.init]() {
    this.domain = await this.ctx.storageDomain.open(domainSpec)
    this.table = this.domain.table('identity')
    try{this.memoryDomain=await this.ctx.storageDomain.open({name:'muse_memory_v1',version:1,tables:{identities:{valueSchema:z.unknown()}}});this.memories=this.memoryDomain.table('identities');this.ctx.effect(()=>()=>this.memoryDomain.close(),'muse.memory-close')}catch(error){this.memoryError=error.message}
    this.tasks = this.domain.table('tasks')
    this.legacyLinkedWorks = this.domain.table('linked_work')
    this.quotes = this.domain.table('quotes')
    this.inbox = this.domain.table('inbox')
    this.heartbeatJobs = this.domain.table('heartbeat_jobs')
    this.legacyHeartbeatControl = this.domain.table('heartbeat_control')
    try {
      this.runtimeDomain = await this.ctx.storageDomain.open(runtimeSpec)
      this.linkedWorks = this.runtimeDomain.table('linked_work')
      this.heartbeatControl = this.runtimeDomain.table('heartbeat_control')
      this.legacyImports = this.runtimeDomain.table('legacy_imports')
      const copy = async (legacy, current, prefix) => {
        for (const [key, value] of legacy.entries()) if (current.get(key) === undefined) {
          const proof = `${prefix}-${key}`
          if (this.legacyImports.get(proof) === undefined) await this.legacyImports.put(proof, structuredClone(value))
          await current.put(key, structuredClone(value))
        }
      }
      await copy(this.legacyHeartbeatControl, this.heartbeatControl, 'heartbeat-control')
      await copy(this.legacyLinkedWorks, this.linkedWorks, 'linked-work')
      for (const [key, job] of this.heartbeatJobs.entries()) if (['unknown', 'blocked'].includes(job.status)) {
        const proof = `heartbeat-job-${key}`
        if (this.legacyImports.get(proof) === undefined) await this.legacyImports.put(proof, structuredClone(job))
        await this.heartbeatJobs.put(key, compatibleHeartbeatJob(job))
      }
    } catch (error) { await this.runtimeDomain?.close(); await this.domain.close(); throw error }
    this.ctx.effect(() => async () => { this.closed = true; await this.tail; await this.runtimeDomain.close(); await this.domain.close() }, 'muse.domain-close')
  }
  write(fn) {
    const operation = this.tail.then(() => { if (this.closed) throw new Error('Muse domain closed'); return fn() })
    this.tail = operation.catch(() => {})
    return operation
  }
  requireObservationRoot(root) { if(!this.ownsFormalRoot(root))throw Error('Observation is restricted to the current persisted formal Muse root') }
  async observationOwner() {
    if(this.observer)return this.observer
    this.observationOpening ||= this.ctx.storageDomain.open({name:'muse_observation_v1',version:1,tables:{roots:{valueSchema:z.unknown()}}}).then(d=>{this.observationDomain=d;this.ctx.effect(()=>()=>d.close(),'muse.observation-close');return d.table('roots')})
    const table=await this.observationOpening
    const read=async root=>{this.requireObservationRoot(root);await this.tail;return structuredClone(table.get(root)||observationInitial(root))}
    const write=(root,fn)=>this.write(async()=>{this.requireObservationRoot(root);const state=structuredClone(table.get(root)||observationInitial(root));if(state.version!==1||state.root!==root)throw Error('Unknown observation state; no reset');await table.put(root,await fn(state))})
    this.observer=createObservationOwner({read,write,analyze:createAnalysisProvider(this.ctx),revalidate:(root,packet,signal)=>this.validateObservationEvidence(root,packet,signal),search:createCommunitySource({primary:(q,signal)=>searchCommunity(globalThis.fetch,q,signal),fetcher:globalThis.fetch}),requireIssuedRequests:true,assertConsent:i=>this.assertObservationConsent(i),authorizeInput:i=>this.authorizeObservationInput(i,'production'),reserveAnalysis:(r,id,legacy)=>this.reserveObservationAnalysis(r,id,'production',legacy),attemptStatus:async(r,id,status,usage,diagnostics)=>(await this.observationConsentControl()).attempt(r,id,status,usage,diagnostics),snapshot:async root=>this.captureObservationSnapshot(root,await read(root)),publish:async(root,ideas,community,signal)=>{const next=await this.projectObservationIdeas(root,ideas,community,signal,this.table.get('muse').candidates||[]);if(next.length){const identity=this.table.get('muse');await this.table.put('muse',{...identity,candidates:[...(identity.candidates||[]),...next],revision:identity.revision+1})}return next.length}})
    return this.observer
  }
  async captureObservationSnapshot(root,state) {

      this.requireObservationRoot(root);await this.tail;const im=(await this.openImDomain()).table('conversations').get(root);if(!im?.enabled)throw Error('Persistent formal IM observations unavailable');let view,events=[],eventsUnavailable=false,eventsMore=false;try{view=await this.ctx.get('sessionQuery').observeSession(root,{projectionMode:'none'});if(view.header?.id!==root)throw Error('Exact root observation required');const pending=view.events.slice(view.inheritedEventCount||0).filter(e=>e.seq>state.eventCursor);events=pending.slice(0,5);eventsMore=pending.length>events.length}catch{eventsUnavailable=true}finally{view?.[Symbol.dispose]()}
      const agent=this.ctx.get('agents')?.get(root),capabilities={source:'installed_plugin_inventory',known:false,inventory:await readPluginInventory(this.ctx),interpretation:'Inventory may be partial; module presence or tool absence is not proof of capability or effect'};capabilities.known=capabilities.inventory.known&&capabilities.inventory.status==='complete'
      const ownedTasks=[...Object.values(im.works||{}).filter(w=>w.root===root),...[...this.tasks.entries()].map(([,t])=>t).filter(t=>t.rootSessionId===root)];const changedTasks=ownedTasks.filter(t=>state.taskHashes[t.id]!==hashSource(t)),tasks=changedTasks.slice(0,15),childEvents=[],childCursors={...state.childCursors},childCoverage=[],childTasks=ownedTasks.filter(t=>typeof t.childId==='string'&&(t.launchStatus==='accepted'||['running','settled','stopped','failed','awaiting_user'].includes(t.status))),offset=childTasks.length?(state.childOffset||0)%childTasks.length:0,selectedChildren=[...childTasks.slice(offset),...childTasks.slice(0,offset)].slice(0,2);for(const t of selectedChildren){let child;try{child=await this.ctx.get('sessionQuery').observeSession(t.childId,{projectionMode:'none'});if(child.header?.id!==t.childId||child.header?.parentSession!==root)throw Error('Owned child header mismatch');const pending=child.events.slice(child.inheritedEventCount||0).filter(e=>e.seq>(state.childCursors?.[t.childId]??-1));for(const e of pending.slice(0,5)){childEvents.push({...e,childId:t.childId,workId:t.id});childCursors[t.childId]=e.seq}childCoverage.push({workId:t.id,childId:t.childId,status:'verified',more:pending.length>5})}catch{childCoverage.push({workId:t.id,childId:t.childId,status:'unavailable'})}finally{child?.[Symbol.dispose]()}}const changedFeedback=Object.values(state.feedback||{}).filter(f=>this.table.get('muse').candidates?.some(c=>c.cardId===f.cardId)&&((f.action==='viewed'&&f.basis==='explicit quote-to-draft interaction')||f.interaction?.protocol==='muse-card-action-v1')).filter(f=>state.feedbackHashes?.[f.eventId]!==hashSource(f)),feedback=changedFeedback.slice(0,10),allUsage=this.observationUsageNow(root,im),changedUsage=allUsage.filter(u=>state.usageHashes?.[u.evidenceId]!==hashSource(u)),usageEvidence=changedUsage.slice(0,5);return{feedbackSequence:state.feedbackSequence||0,feedback:structuredClone(feedback),usageEvidence:structuredClone(usageEvidence),feedbackMore:changedFeedback.length>10,usageMore:changedUsage.length>5,at:new Date().toISOString(),inputVersion:im.inputVersion??null,messages:structuredClone([...im.messages.filter(m=>m.role==='user'&&m.seq<=state.messageCursor).slice(-10),...im.messages.filter(m=>m.role==='user'&&m.seq>state.messageCursor).slice(0,20)]),messagesMore:im.messages.filter(m=>m.role==='user'&&m.seq>state.messageCursor).length>20,tasksMore:changedTasks.length>15,events,eventsUnavailable,eventsMore,tasks,capabilities,childEvents,childCursors,childCoverage,childOffset:childTasks.length?(offset+selectedChildren.length)%childTasks.length:0,childrenMore:childTasks.length>selectedChildren.length}

  }
  observationUsageNow(root,im) {
    const imUsage=Object.values(im?.works||{}).filter(w=>w.root===root).slice(-50).flatMap(w=>(w.authorization?.messageIds||[]).flatMap(id=>{const m=im.messages.find(m=>m.role==='user'&&m.id===id);return m?.quote?.snapshot?.cardId?[{evidenceId:`im-work:${w.id}:quote:${m.quote.id}`,cardId:m.quote.snapshot.cardId,cardVersion:m.quote.snapshot.version,workId:w.id,version:w.intentVersion,status:w.status,humanMessageId:m.id,quoteId:m.quote.id,recordedDispatchAttempts:w.actions?.length||0,usageBasis:'owned work linked through versioned human quote; action records are dispatch attempts, not execution completion',evidenceHash:hashSource(w),effect:'unknown'}]:[]}));return [...imUsage,...[...this.tasks.entries()].map(([,t])=>t).filter(t=>t.rootSessionId===root&&typeof t.sourceCardId==='string').slice(-50).map(t=>({evidenceId:`legacy-work:${t.id}`,cardId:t.sourceCardId,cardVersion:t.source?.version??null,workId:t.id,version:t.version,status:t.status,evidenceHash:hashSource(t),effect:'unknown'}))]
  }
  async projectObservationIdeas(root,ideas,community,signal,prior=[]) {
    this.requireObservationRoot(root);signal.throwIfAborted();const im=(await this.openImDomain()).table('conversations').get(root),next=[];validateSemanticSourceCards(ideas,{messages:im.messages},root);
    for(const card of ideas){const semantic=card.observation.semantic;if(semantic.inputVersion!==null&&semantic.inputVersion!==undefined&&im.inputVersion!==semantic.inputVersion)throw Error('New input invalidated semantic projection');if(semantic.feedbackSequence!==null&&semantic.feedbackSequence!==undefined&&(this.observationDomain.table('roots').get(root)?.feedbackSequence||0)!==semantic.feedbackSequence)throw Error('New feedback invalidated semantic projection');if(prior.some(c=>c.cardId===card.cardId))continue;const anchorId=card.anchorId.split(':message:')[1],anchor=im.messages.find(m=>m.role==='user'&&m.id===anchorId);if(!anchor||card.sourceText!==anchor.text.slice(0,1000)||card.sourceFullHash!==hashSource(anchor.text)||card.sourceTextHash!==hashSource(card.sourceText))throw Error('Semantic anchor/source text or hash mismatch');const seen=new Set(),refs=[...card.observation.refs.filter(r=>r.kind==='human'),{messageId:anchorId}].filter(r=>{if(seen.has(r.messageId))return false;seen.add(r.messageId);return true}).map(ref=>{const m=im.messages.find(m=>m.role==='user'&&m.id===ref.messageId);if(!m||(ref.sha256&&hashSource(m.text)!==ref.sha256))throw Error('Observation source changed');const text=m.text.slice(0,1000);return{kind:'human',transport:'persistent-im',rootSessionId:root,sourceId:`im:${root}:message:${m.id}`,messageId:m.id,clientMessageId:m.clientMessageId,seq:m.seq,version:1,fullTextHash:hashSource(m.text),textHash:hashSource(text),quote:text.slice(0,80)}});const discussed=(card.observation.semantic.comparisons||[]).filter(c=>c.decision==='discuss'),matches=(community.matches||[]).filter(c=>discussed.some(d=>d.candidateId===`community_candidate:${hashSource([c.url,c.name])}`&&d.version===hashSource(c)));const cardCommunity={...community,matches,status:matches.length?'compared_unverified':'no_candidate_recommendation'};const description=matches.length?` 待讨论的社区候选：${matches.map(p=>p.name).join('、')}；来源非官方，版本、权限和适配仍待核查，未安装。`:'';next.push({...card,newInformation:card.newInformation+description,contextEvidence:{rootSessionId:root,contextHash:hashSource(refs),refs},community:cardCommunity})}signal.throwIfAborted();return next
  }
  async validateObservationEvidence(root,packet,signal) {
    this.requireObservationRoot(root);signal.throwIfAborted();const im=(await this.openImDomain()).table('conversations').get(root);if(packet.inputVersion!==null&&packet.inputVersion!==undefined&&im.inputVersion!==packet.inputVersion)throw Error('New human input invalidated analysis snapshot');if(packet.feedbackSequence!==null&&packet.feedbackSequence!==undefined&&(this.observationDomain.table('roots').get(root)?.feedbackSequence||0)!==packet.feedbackSequence)throw Error('New card feedback invalidated analysis snapshot');const refs=packet.rows?packet.rows.map(r=>r.ref):(packet.patterns||[]).flatMap(p=>p.refs);const views=new Map();try{for(const ref of refs){signal.throwIfAborted();if(ref.root!==root)throw Error('Evidence root changed');if(ref.kind==='human'){const m=im.messages.find(m=>m.role==='user'&&m.id===ref.messageId);if(!m||hashSource(m.text)!==ref.sha256)throw Error('Analysis source changed')}else if(ref.kind==='work'){const w=im.works?.[ref.workId]||this.tasks.get(ref.workId);if(!w||(w.root??w.rootSessionId)!==root||hashSource(w)!==ref.sha256)throw Error('Analysis task changed')}else if(ref.kind==='feedback'){const value=this.observationDomain.table('roots').get(root)?.feedback?.[ref.eventId];if(!value||hashSource(value)!==ref.sha256)throw Error('Feedback evidence changed')}else if(ref.kind==='usage'){const value=this.observationUsageNow(root,im).find(u=>u.evidenceId===ref.evidenceId);if(!value||hashSource(value)!==ref.sha256)throw Error('Usage evidence changed')}else if(ref.kind==='community_candidate'){if(ref.version!==ref.sha256||typeof ref.source!=='string')throw Error('Candidate provenance invalid')}else{const sessionId=ref.kind==='owned_child'?ref.childId:root;if(ref.kind==='owned_child'){const w=im.works?.[ref.workId]||this.tasks.get(ref.workId);if(!w||(w.root??w.rootSessionId)!==root||w.childId!==sessionId)throw Error('Child ownership changed')}if(!views.has(sessionId)){const v=await this.ctx.get('sessionQuery').observeSession(sessionId,{projectionMode:'none'});views.set(sessionId,v);if(v.header?.id!==sessionId||(sessionId!==root&&v.header.parentSession!==root))throw Error('Evidence session identity mismatch')}const v=views.get(sessionId),e=v.events.slice(v.inheritedEventCount||0).find(e=>e.seq===ref.seq);if(!e||hashSource(e.data)!==ref.sha256)throw Error('Analysis event changed')}}signal.throwIfAborted()}finally{for(const v of views.values())v[Symbol.dispose]()}
  }
  async observationConsentControl() {if(this.consentControl)return this.consentControl;await this.observationOwner();const table=this.observationDomain.table('roots');this.consentControl=createConsentControl({read:async root=>{this.requireObservationRoot(root);await this.tail;return structuredClone(table.get(`control:${root}`)||{version:1,root})},write:(root,fn)=>this.write(async()=>{this.requireObservationRoot(root);const state=structuredClone(table.get(`control:${root}`)||{version:1,root});await table.put(`control:${root}`,await fn(state))})});return this.consentControl}
  observationConsentCards(root) {this.requireObservationRoot(root);return (this.table.get('muse').candidates||[]).slice(-100).map(c=>({cardId:c.cardId,version:c.version,signature:sourceSignature(c)}))}
  async validateObservationConsent(ticket) {this.requireObservationRoot(ticket.root);const route=await readAnalysisRoute(this.ctx,ticket.root);if(consentHash(route)!==consentHash(ticket.disclosure.route))throw Error('Model route or reasoningEffort changed; review again');if(ticket.mode==='synthetic-live'){if(consentHash(syntheticObservation(ticket.root,route,ticket.snapshot.sampleId))!==ticket.disclosure.snapshotHash)throw Error('Synthetic sample changed; review again')}else{if(consentHash(this.observationConsentCards(ticket.root))!==ticket.disclosure.cardsHash)throw Error('Card version changed; review again');await this.validateObservationEvidence(ticket.root,analysisPacket(ticket.root,ticket.snapshot),new AbortController().signal)}}
  assertObservationConsent(input) {this.requireObservationRoot(input.rootSessionId);const t=this.observationDomain.table('roots').get(`control:${input.rootSessionId}`)?.consents?.[input.consentTicketId];if(!t||t.root!==input.rootSessionId||t.requestId!==input.requestId||t.status!=='consumed'||t.expiresAt<Date.now()||t.mode==='synthetic-live'&&this.observationDomain.table('roots').get(`control:${input.rootSessionId}`)?.selectedSampleId!==t.snapshot.sampleId)throw Error('Observation consent revoked or expired')}
  async authorizeObservationInput(input,mode) {return (await this.observationConsentControl()).authorize(input.rootSessionId,input,mode,t=>this.validateObservationConsent(t))}
  async reserveObservationAnalysis(root,id,mode,legacy) {const table=this.observationDomain.table('roots'),prod=table.get(root)||{};if(mode!=='production'&&['in_flight','unresolved'].includes(prod.providerAttempt?.status))throw Error('Formal provider attempt unresolved');const combined={...legacy};for(const [day,n] of Object.entries(prod.analysisBudget||{}))combined[day]=Math.max(combined[day]||0,n);return (await this.observationConsentControl()).reserve(root,id,mode,combined)}
  async prepareObservationRun(input) {this.requireObservationRoot(input.rootSessionId);if(Object.keys(input).some(k=>!['rootSessionId','mode','sampleId'].includes(k))||input.mode!==undefined&&!['production','synthetic-live'].includes(input.mode))throw Error('Exact observation mode preparation required');if(input.sampleId!==undefined&&input.mode!=='synthetic-live')throw Error('Named sample only for synthetic-live');const root=input.rootSessionId,mode=input.mode||'production',route=await readAnalysisRoute(this.ctx,root);let owner,snapshot,cards;if(mode==='production'){owner=await this.observationOwner();const state=await owner.read({rootSessionId:root});snapshot=await this.captureObservationSnapshot(root,state);snapshot.previousObservations=structuredClone(state.semanticObservations||[]);snapshot.route=route;cards=this.observationConsentCards(root)}else{owner=await this.liveObservationPreviewOwner();snapshot=syntheticObservation(root,route,input.sampleId);cards=[]}const issued=await owner.issue({rootSessionId:root}),control=await this.observationConsentControl();const ticket=await control.prepare(root,mode,snapshot,cards,route,issued.requestId,this.observationDomain.table('roots').get(root)?.analysisBudget||{});if(mode==='synthetic-live'){const state=this.observationDomain.table('roots').get(`control:${root}`);if(state.dispatchLease&&state.consents?.[state.dispatchLease.ticketId]?.status==='revoked')this.livePreviewOwner?.revoke({rootSessionId:root,requestId:state.dispatchLease.requestId})}return ticket}
  async decideObservationRun(input) {this.requireObservationRoot(input.rootSessionId);if(Object.keys(input).some(k=>!['rootSessionId','ticketId','requestId','disclosureHash','action'].includes(k))||!['approve-once','revoke'].includes(input.action))throw Error('Explicit approve-once or revoke decision required');const result=await (await this.observationConsentControl()).decide(input.rootSessionId,input,t=>this.validateObservationConsent(t));if(input.action==='revoke'){const owner=result.mode==='synthetic-live'?this.livePreviewOwner:this.observer;owner?.revoke({rootSessionId:input.rootSessionId,requestId:input.requestId})}return result}
  async observeMuse(input) {this.requireObservationRoot(input.rootSessionId);if(Object.keys(input).some(k=>!['rootSessionId','requestId','consentTicketId'].includes(k))||typeof input.consentTicketId!=='string')return{status:'analysis_not_authorized',published:0,notice:'先审阅并明确批准一次观察'};return (await this.observationOwner()).run(input)}
  async liveObservationPreviewOwner() {if(this.livePreviewOwner)return this.livePreviewOwner;await this.observationOwner();const table=this.observationDomain.table('roots'),read=async root=>{this.requireObservationRoot(root);await this.tail;return structuredClone(table.get(`live-preview:${root}`)||previewInitial(root))},write=(root,fn)=>this.write(async()=>{this.requireObservationRoot(root);const state=structuredClone(table.get(`live-preview:${root}`)||previewInitial(root));const result=await fn(state);if(this.pendingPreviewCards?.has(root)){result.cards=this.pendingPreviewCards.get(root);this.pendingPreviewCards.delete(root)}await table.put(`live-preview:${root}`,result)});this.livePreviewOwner=createObservationOwner({read,write,requireIssuedRequests:true,assertConsent:i=>this.assertObservationConsent(i),authorizeInput:i=>this.authorizeObservationInput(i,'synthetic-live'),reserveAnalysis:(r,id,legacy)=>this.reserveObservationAnalysis(r,id,'synthetic-live',legacy),attemptStatus:async(r,id,status,usage,diagnostics)=>(await this.observationConsentControl()).attempt(r,id,status,usage,diagnostics),snapshot:async()=>{throw Error('Synthetic live preview requires a frozen approved sample')},analyze:createAnalysisProvider(this.ctx),search:async()=>structuredClone(syntheticCommunity),revalidate:async(root,packet,signal)=>{this.requireObservationRoot(root);signal.throwIfAborted();const route=await readAnalysisRoute(this.ctx,root);if(consentHash(route)!==consentHash(packet.route))throw Error('Synthetic approved route changed');const expected=analysisPacket(root,syntheticObservation(root,route,packet.sampleId),[],packet.recall.status==='not_needed'?{status:'not_needed'}:syntheticCommunity);for(const row of packet.rows){const same=expected.rows.find(r=>r.evidenceId===row.evidenceId);if(!same||same.fullHash!==row.fullHash)throw Error('Synthetic evidence changed')}},publish:async(root,ideas,community,signal)=>{signal.throwIfAborted();validateSemanticSourceCards(ideas,syntheticObservation(root,ideas[0]?.observation?.semantic?.route,ideas[0]?.observation?.semantic?.sampleId),root);const state=table.get(`live-preview:${root}`)||previewInitial(root),prior=state.cards||[];const next=ideas.filter(c=>!prior.some(p=>p.cardId===c.cardId)); // Persist inside the owner's already serialized state mutation below.
        this.pendingPreviewCards||=new Map();this.pendingPreviewCards.set(root,[...prior,...next].slice(-100));return next.length}});return this.livePreviewOwner}
  async readObservation(input) {this.requireObservationRoot(input.rootSessionId);const state=await (await this.observationOwner()).read(input),im=(await this.openImDomain()).table('conversations').get(input.rootSessionId);return{root:state.root,observationImplementationRevision:observationRuntimeRevision,stopped:state.stopped,messageCursor:state.messageCursor,eventCursor:state.eventCursor,signalCount:state.signals.length,runs:state.runs,providerAttempt:state.providerAttempt||null,feedback:state.feedback||{},usageEvidence:this.observationUsageNow(input.rootSessionId,im)}}
  observationCardContext(card) {return{cardId:card.cardId,version:card.version,title:String(card.title).slice(0,200),anchorId:card.anchorId,hypothesis:String(card.observation?.semantic?.hypothesis||'unknown').slice(0,500),patternKind:card.observation?.kind||'unknown',candidateIds:(card.observation?.semantic?.comparisons||[]).map(c=>c.candidateId).slice(0,3),effect:'unknown'}}
  async prepareObservationFeedback(input) {this.requireObservationRoot(input.rootSessionId);if(Object.keys(input).some(k=>!['rootSessionId','cardId','cardVersion','action'].includes(k))||!['viewed','accepted','rejected'].includes(input.action))throw Error('Exact card action preparation required');const card=this.table.get('muse').candidates?.find(c=>c.cardId===input.cardId&&c.version===input.cardVersion&&c.observation);if(!card)throw Error('Owned observation card/version required');return (await this.observationOwner()).prepareFeedback(input.rootSessionId,{cardId:card.cardId,version:card.version,signature:sourceSignature(card),context:this.observationCardContext(card)},input.action)}
  async recordObservationFeedback(input) {this.requireObservationRoot(input.rootSessionId);if(Object.keys(input).some(k=>!['rootSessionId','ticketId','interactionId','cardId','cardVersion','action','protocol','kind'].includes(k))||input.protocol!=='muse-card-action-v1'||!['pointer','keyboard'].includes(input.kind)||!['viewed','accepted','rejected'].includes(input.action)||! /^[a-f0-9-]{36}$/.test(input.interactionId))throw Error('Typed card interaction required; unrelated human text is not evidence');return (await this.observationOwner()).commitFeedback(input.rootSessionId,input,()=>{const card=this.table.get('muse').candidates?.find(c=>c.cardId===input.cardId&&c.version===input.cardVersion&&c.observation);if(!card)throw Error('Observation card changed');return sourceSignature(card)})}
  async previewObservation(input) {
    this.requireObservationRoot(input.rootSessionId);if(input.mode==='synthetic-live'){if(Object.keys(input).some(k=>!['rootSessionId','requestId','mode','consentTicketId'].includes(k))||typeof input.consentTicketId!=='string')throw Error('Approved synthetic-live consent required');const owner=await this.liveObservationPreviewOwner(),receipt=await owner.run({rootSessionId:input.rootSessionId,requestId:input.requestId,consentTicketId:input.consentTicketId}),state=await owner.read({rootSessionId:input.rootSessionId});return{preview:true,mode:'synthetic-live',productionFeedWritten:false,productionImWritten:false,productionObservationReceiptWritten:false,receipt,cards:state.cards||[],budget:await (await this.observationConsentControl()).state(input.rootSessionId),notice:'真实模型只分析固定合成样本，不代表你的偏好或生产效果'}}if(Object.keys(input).some(k=>!['rootSessionId','requestId','mode'].includes(k))||input.mode!=='offline-fixture'||typeof input.requestId!=='string'||!input.requestId||input.requestId.length>100)throw Error('Exact offline preview required; no live model or supplied evidence is accepted');
    this.observationPreview||=new Map();const root=input.rootSessionId;let preview=this.observationPreview.get(root);if(!preview){const original=await (await this.observationOwner()).read({rootSessionId:root});let state={...structuredClone(original),messageCursor:-1,eventCursor:-1,childCursors:{},taskHashes:{},feedbackHashes:{},usageHashes:{},runs:{},analysisBudget:{},searchBudget:{},providerAttempt:null,semanticPatterns:[],semanticObservations:[],stopped:false};const cards=[],receipts=new Map();let tail=Promise.resolve();const owner=createObservationOwner({read:async()=>structuredClone(state),write:(_root,fn)=>{const p=tail.then(async()=>{state=await fn(structuredClone(state))});tail=p.catch(()=>{});return p},snapshot:async()=>this.captureObservationSnapshot(root,state),revalidate:(r,p,signal)=>this.validateObservationEvidence(r,p,signal),publish:async(r,ideas,community,signal)=>{const next=await this.projectObservationIdeas(r,ideas,community,signal,cards);cards.push(...next);return next.length},search:async q=>{const recorded=state.sourceCache?.[q]?.result;return recorded?{...structuredClone(recorded),status:'recorded_cache_unverified',verification:'no network during preview'}:{status:'offline_not_queried',query:q,matches:[]}},analyze:async packet=>{const human=packet.rows.find(r=>r.kind==='human'),comparisons=packet.rows.filter(r=>r.kind==='community_candidate').map(c=>({candidateId:c.evidenceId,candidateVersion:c.version,needEvidenceIds:human?[human.evidenceId]:[],decision:'defer',reason:'人工预览不能验证需求或候选适配',alternative:{kind:'clarify',status:'unknown',reason:'需要真实语义与用户核对'},permissions:'unknown',compatibility:'unknown',missingEvidence:['真实模型验收','候选适配证据']}));return{mode:'artificial-fixture',provider:'offline-preview',model:'explicit artificial fixture',packetHash:packet.packetHash,usage:{status:'unknown'},output:{patterns:human?[{kind:'correction',hypothesis:'人工预览样本，不能作为真实观察结论',possibleCauses:[{cause:'unclassified',reason:'本轮没有真实语义分析'}],evidenceIds:[human.evidenceId],confidence:0,missingEvidence:['真实模型与用户核对'],nextQuestion:'人工预览：稍后核对这条来源？'}]:[],comparisons}}}});preview={owner,cards,receipts};this.observationPreview.clear();this.observationPreview.set(root,preview)}
    if(preview.receipts.has(input.requestId))return structuredClone(preview.receipts.get(input.requestId));if(preview.receipts.size>=20)throw Error('Offline preview receipt window full; explicit service restart clears memory only');const receipt=await preview.owner.run({rootSessionId:root,requestId:input.requestId,analysisConsent:'one-tool-free-call'});const output={preview:true,mode:'offline-fixture',observationImplementationRevision:observationRuntimeRevision,productionReceiptsWritten:false,productionFeedWritten:false,networkPerformed:false,realModelCalled:false,receipt,cards:structuredClone(preview.cards),notice:'人工样本通过同一生产管道；不证明语义质量、联网或效果'};preview.receipts.set(input.requestId,output);return output
  }
  async readObservationPreview(input) {this.requireObservationRoot(input.rootSessionId);if(Object.keys(input).some(k=>k!=='rootSessionId'))throw Error('Exact preview root required');const owner=await this.liveObservationPreviewOwner(),state=await owner.read(input);return{root:state.root,runs:state.runs,providerAttempt:state.providerAttempt||null,cards:state.cards||[],budget:await (await this.observationConsentControl()).state(input.rootSessionId)}}
  async stopObservation(input) { this.requireObservationRoot(input.rootSessionId);await (await this.observationOwner()).stop(input);await (await this.liveObservationPreviewOwner()).stop(input);if(input.stopped)await (await this.observationConsentControl()).revokeAll(input.rootSessionId);return this.readObservation({rootSessionId:input.rootSessionId}) }
  async imReceive(input) { if (!this.imController) throw Error('IM protocol unavailable'); return this.imController.receive(input) }
  async imRead(input) { if (!this.imController) throw Error('IM protocol unavailable'); return this.imController.read(input) }
  async imTyping(input) { if (!this.imController) throw Error('IM protocol unavailable'); return this.imController.typing(input) }
  async imAck(input) { if (!this.imController) throw Error('IM protocol unavailable'); return this.imController.ack(input) }
  identityView(value) { return structuredClone(projectHistoryRecovery(value,[...this.legacyImports.entries()].filter(([key])=>key.startsWith('formal-archive:')).map(([,archive])=>archive))) }
  async identity() {
    return this.write(async () => {
      let value = this.table.get('muse')
      if (!value) { value = { identity: 'muse', rootSessionId: randomUUID(), revision: 0, goals: [] }; await this.table.put('muse', value) }
      return this.identityView(value)
    })
  }
  candidateSources(rootSessionId) {
    const entry = [...this.table.entries()].find(([, value]) => value.rootSessionId === rootSessionId)
    if (!entry) throw new Error('Muse root mismatch')
    const goals = entry[1].goals.filter(goal => !goal.done).map(goal => ({ anchorId: goal.id, version: goal.version, origin: '目标', sourceText: goal.title }))
    const concerns = [...this.inbox.entries()].map(([, item]) => item).filter(item => item.rootSessionId === rootSessionId && isConcern(item.text)).slice(-6).map(item => ({ anchorId: `message:${item.messageId}`, version: 1, origin: '历史关切', sourceText: item.text }))
    const im=this.imDomainHandle?.table('conversations').get(rootSessionId)
    if(im?.enabled){
      const packet=buildImDiscoveryContext(rootSessionId,this.discoveryContextSnapshotNow(rootSessionId),im)
      return [...goals,...packet.recentHumanTurns.map(m=>({anchorId:m.sourceId,version:m.version,origin:'聊天',sourceText:m.text}))]
    }
    return [...goals, ...concerns]
  }
  openImDomain() {
    this.imDomainOpening ||= this.ctx.storageDomain.open(imDomainSpec).then(handle=>{this.imDomainHandle=handle;this.ctx.effect(()=>()=>handle.close(),'muse.im-shared-domain-close');return handle})
    return this.imDomainOpening
  }
  async readDiscoveryImSnapshot(root) {
    if(!this.ownsRoot(root))throw Error('Exact Muse root required')
    const value=(await this.openImDomain()).table('conversations').get(root)
    if(!value?.enabled)return null
    if(value.root!==root||value.version!==1||!value.handoffConfirmed){const error=Error('Persistent IM frontier unavailable');error.code='MUSE_IM_FRONTIER_UNAVAILABLE';throw error}
    return structuredClone(value)
  }
  discoveryContextSnapshotNow(rootSessionId) {
    if (!this.ownsRoot(rootSessionId)) throw new Error('Exact Muse root required')
    const identity = [...this.table.entries()].find(([, value]) => value.rootSessionId === rootSessionId)[1]
    return structuredClone({ rootSessionId, revision: identity.revision, goals: identity.goals, rememberedContext:this.memoryRecall(rootSessionId,identity.goals.filter(g=>!g.done).map(g=>g.title).join(" ")), saved: identity.saved || [], candidates: identity.candidates || [], tasks: [...this.tasks.entries()].map(([, task]) => task).filter(task => task.rootSessionId === rootSessionId), recentInboxIds: [...this.inbox.entries()].map(([, item]) => item).filter(item => item.rootSessionId === rootSessionId).slice(-8).map(item => item.messageId) })
  }
  async discoveryContextSnapshot(root) { await this.tail; return this.discoveryContextSnapshotNow(root) }
  async discoveryContextCheckNow(run) {
    validateContextPacket(run.contextPacket, run.rootSessionId)
    const fresh = await captureDiscoveryContext({ muse: this, sessionQuery: this.ctx.get('sessionQuery') }, run.rootSessionId, async () => this.discoveryContextSnapshotNow(run.rootSessionId))
    if (latestContextIncomplete(fresh) || latestContextIncomplete(run.contextPacket) || contextFreshness(fresh) !== contextFreshness(run.contextPacket)) return { current: false, reason: 'stale_context' }
    return { current: true, packet: fresh }
  }
  async discoveryContextCheck(run) { return this.write(async () => { try { const { current, reason } = await this.discoveryContextCheckNow(run); return { current, ...(reason ? { reason } : {}) } } catch { return { current: false, reason: 'context_unavailable' } } }) }
  async contextSourceCheck(root, evidence) {
    if (evidence.rootSessionId !== root) throw Error('Context evidence belongs to another root')
    const snapshot = this.discoveryContextSnapshotNow(root)
    let observation
    try {
    if (evidence.refs.some(ref => ref.kind === 'human' && ref.transport !== 'persistent-im')) {
      try { observation = await this.ctx.get('sessionQuery').observeSession(root, { projectionMode: 'none' }) } catch { throw Error('Exact human source surface unavailable') }
    }
    const active = observation ? new Set(foldSurface(observation.events).nodes) : null
    for (const ref of evidence.refs) {
      let text
      if (ref.kind === 'goal') { const g=snapshot.goals.find(g => g.id === ref.anchorId && !g.done && g.version === ref.version); text=g?.title.slice(0,600) }
      else if (ref.kind === 'human' && ref.transport === 'persistent-im') {
        const im=await this.readDiscoveryImSnapshot(root),m=im?.messages.find(m=>m.role==='user'&&m.id===ref.messageId&&m.clientMessageId===ref.clientMessageId&&m.seq===ref.seq)
        if(!m||ref.rootSessionId!==root||ref.version!==1||ref.sourceId!==`im:${root}:message:${m.id}`||hashSource(m.text)!==ref.fullTextHash||(ref.quotedSource&&(m.quote?.id!==ref.quotedSource.quoteId||hashSource(m.quote?.snapshot)!==ref.quotedSource.snapshotHash)))throw Error('Persistent IM source changed')
        text=m.text.slice(0,1000)
      } else if (ref.kind === 'human') {
        const event=observation.events.slice(observation.inheritedEventCount || 0).find(e => active.has(e.seq) && e.seq === ref.seq && e.type === 'user/message' && e.data?.id === ref.messageId && e.data.source?.kind === 'user')
        const fullText=event?.data.content.filter(b => b.type === 'text').map(b => b.text).join('').split('[Muse 来源快照]')[0].trim()
        if (ref.fullTextHash && (fullText === undefined || createHash('sha256').update(JSON.stringify(fullText)).digest('hex') !== ref.fullTextHash)) throw Error('Context evidence changed beyond its bounded excerpt')
        text=fullText?.slice(0,1000)
      } else if (ref.kind === 'registered_question') { const t=snapshot.tasks.find(t => t.id === ref.taskId && t.status === 'awaiting_user' && t.question?.id === ref.questionId && t.question.senderSessionId === ref.senderSessionId && t.question.sourceMessageId === ref.sourceMessageId && t.receipts.includes(ref.sourceMessageId) && ['pending','asking'].includes(t.question.status)); text=t?.question.questions.map(q => q.question).join('\n').slice(0,400) }
      if (text === undefined || createHash('sha256').update(JSON.stringify(text)).digest('hex') !== ref.textHash || !text.includes(ref.quote)) throw Error('Context evidence changed, withdrawn or cancelled')
    }
    } finally { observation?.[Symbol.dispose]() }
  }
  async candidateContext(rootSessionId) { await this.tail;await this.readDiscoveryImSnapshot(rootSessionId); return structuredClone(this.candidateSources(rootSessionId)) }
  async publishCandidate(rootSessionId, input) {
    return this.write(async () => {
      const entry = [...this.table.entries()].find(([, value]) => value.rootSessionId === rootSessionId)
      const source = this.candidateSources(rootSessionId).find(source => source.anchorId === input.anchorId)
      const card = validateCandidate(input, source, entry?.[1].candidates || [])
      if (!card) return { published: false, duplicate: true }
      const candidates = [...(entry[1].candidates || []), card]
      await this.table.put(entry[0], { ...entry[1], candidates, revision: entry[1].revision + 1 })
      return { published: true, cardId: card.cardId }
    })
  }
  async heartbeatJobPut(job) { return this.write(() => this.heartbeatJobs.put(job.id, structuredClone(compatibleHeartbeatJob(job)))) }
  async heartbeatJobList() { await this.tail; return [...this.heartbeatJobs.entries()].map(([, job]) => structuredClone(job)) }
  async heartbeatControlGet() { await this.tail; const value = this.heartbeatControl.get('owner'); return value === undefined ? null : value === null ? { invalidControlRecord: true } : structuredClone(value) }
  async heartbeatRootIds() { await this.tail; return [...this.table.entries()].map(([, identity]) => identity.rootSessionId) }
  async heartbeatControlPut(value) { return this.write(async () => { await this.heartbeatControl.put('owner', value); return structuredClone(value) }) }
  async publishDiscoveryCandidate(run) {
    return this.write(async () => {
      if (!this.ownsRoot(run.rootSessionId) || run.result?.outcome !== 'candidate') throw new Error('Exact discovery result required')
      const entry = [...this.table.entries()].find(([, value]) => value.rootSessionId === run.rootSessionId)
      const key = `${run.id}:0`
      const previous = entry[1].candidates || []
      const committed = previous.find(card => card.discoveryKey === key)
      if (committed) return { published: true, duplicate: true, cardId: committed.cardId }
      const input = run.result.candidate
      let contextEvidence
      if (run.contextRevision === 1) {
        let check; try { check = await this.discoveryContextCheckNow(run) } catch { return { published: false, stale: true, reason: 'context_unavailable' } }
        if (!check.current) return { published: false, stale: true, reason: check.reason }
        contextEvidence = { rootSessionId: run.rootSessionId, contextHash: run.contextPacket.contextHash, refs: contextReferences(input.contextRefs, run.contextPacket) }
      }
      const captured = run.sources.find(source => source.anchorId === input.anchorId && source.version === input.version)
      const current = this.candidateSources(run.rootSessionId).find(source => source.anchorId === input.anchorId)
      if (!captured || !current || captured.version !== current.version || captured.sourceText !== current.sourceText) return { published: false, stale: true }
      if (run.contextRevision === 1 && previous.some(prior => equivalent(prior.title, input.title) || (prior.newInformation && equivalent(prior.newInformation,input.newInformation)))) return { published: false, duplicate: true, reason: 'duplicate_direction' }
      const card = validateCandidate(input, current, previous)
      if (!card) return { published: false, duplicate: true }
      const quality = candidateQuality(input, run)
      const currentSources = this.candidateSources(run.rootSessionId)
      if (quality.sourceRefs.some(ref => { const captured = run.sources.find(source => source.anchorId === ref.anchorId && source.version === ref.version); const now = currentSources.find(source => source.anchorId === ref.anchorId); return !captured || !now || now.version !== ref.version || now.sourceText !== captured.sourceText })) return { published: false, stale: true }
      const insight=run.contextRevision===1?validateImInsight(input,run.contextPacket):null
      const next = { ...card, pluginOptions: structuredClone(input.pluginOptions || []), quality, ...(insight?{insight}:{}), ...(contextEvidence ? { contextEvidence } : {}), discoveryKey: key, discoveryRunId: run.id }
      await this.table.put(entry[0], { ...entry[1], candidates: [...previous, next], revision: entry[1].revision + 1 })
      return { published: true, cardId: next.cardId }
    })
  }
  async requestDiscovery(input) { if(!this.requestDiscoveryOnce)throw Error('Explicit discovery owner unavailable');return this.requestDiscoveryOnce(input) }
  async readDiscoveryRequest(input) { if(!this.readDiscoveryOnce)throw Error('Explicit discovery owner unavailable');return this.readDiscoveryOnce(input) }
  async checkHeartbeat(input) {
    if (!this.ownsRoot(input.rootSessionId) || !this.generateHeartbeat) throw new Error('Muse heartbeat unavailable')
    return this.generateHeartbeat(input.rootSessionId, { synthetic: input.synthetic === true })
  }
  async inboxPut(value) { return this.write(() => this.inbox.put(value.messageId, value)) }
  async inboxGet(id) { await this.tail; return this.inbox.get(id) }
  topicFor(rootSessionId, anchor, version) {
    const value = [...this.table.entries()].find(([, item]) => item.rootSessionId === rootSessionId)?.[1]
    return value?.goals.find(goal => goal.id === anchor && goal.version === version)?.title || ''
  }
  async taskPut(task) { return this.write(() => this.tasks.put(task.id, task)) }
  async taskUpdate(id, update) { return this.write(() => this.tasks.update(id, update)) }
  ownsFormalRoot(id) { const value=this.table.get('muse');return value?.identity==='muse'&&value.rootSessionId===id }
  ownsQaRoot(id) { const value=this.table.get('muse-qa');return value?.identity==='muse-qa'&&value.rootSessionId===id }
  ownsRoot(id) { return [...this.table.entries()].some(([, value]) => value.rootSessionId === id) }
  async qaIdentity() {
    return this.write(async () => {
      let value = this.table.get('muse-qa')
      if (!value) { value = { identity: 'muse-qa', rootSessionId: randomUUID(), revision: 0, goals: [] }; await this.table.put('muse-qa', value) }
      return structuredClone(value)
    })
  }
  async archiveFormalSynthetic(plan,checkIdle) {
    if(!this.ownsFormalRoot(plan.rootSessionId)||!Number.isInteger(plan.throughSeq)||plan.throughSeq<0||!/^user-approved-[a-z0-9-]+$/.test(plan.token))throw Error('Exact authorized formal archival required')
    return this.write(async()=>{
      await checkIdle()
      const key=`formal-archive:${plan.token}`,prior=this.legacyImports.get(key)
      let archive=prior
      if(!archive){
        const identity=structuredClone(this.table.get('muse'))
        const records={}
        for(const [name,table] of [['inbox',this.inbox],['quotes',this.quotes],['tasks',this.tasks]])records[name]=[...table.entries()].filter(([,v])=>v.rootSessionId===plan.rootSessionId).map(([k,v])=>[k,structuredClone(v)])
        if(records.tasks.some(([,t])=>!['settled','stopped','failed'].includes(t.status)))throw Error('Cannot archive outstanding native task')
        archive={version:1,plan:structuredClone(plan),identity,records,archivedAt:new Date().toISOString(),status:'preserved'}
        await this.legacyImports.put(key,archive)
      }
      if(archive.plan.rootSessionId!==plan.rootSessionId||archive.plan.throughSeq!==plan.throughSeq)throw Error('Archive identity changed')
      if(archive.status==='completed')return structuredClone(archive)
      await checkIdle()
      for(const [name,table] of [['inbox',this.inbox],['quotes',this.quotes],['tasks',this.tasks]])for(const [k,v] of archive.records[name])if(JSON.stringify(table.get(k))===JSON.stringify(v))await table.delete(k)
      const current=this.table.get('muse')
      if(JSON.stringify(current)===JSON.stringify(archive.identity))await this.table.put('muse',{...current,goals:[],saved:[],candidates:[],revision:current.revision+1})
      archive={...archive,status:'completed',completedAt:new Date().toISOString()};await this.legacyImports.put(key,archive)
      return structuredClone(archive)
    })
  }
  async recoverSynthetic(input) {
    return this.write(async () => {
      const current = this.table.get('muse')
      const allowed = '99d003c2-a1b8-4296-91c5-3621c9a4d3fe'
      if (current?.archivedRoots?.some(root => root.rootSessionId === allowed)) return structuredClone(current)
      if (input.rootSessionId !== allowed || current?.rootSessionId !== allowed) throw new Error('恢复仅限已授权的 Muse 合成验收根')
      const next = { ...current, rootSessionId: randomUUID(), revision: current.revision + 1,
        archivedRoots: [...(current.archivedRoots || []), { rootSessionId: allowed, reason: '原生加载校验拒绝：缺少消息身份；保留原始历史，启用新的可用根', archivedAt: new Date().toISOString() }] }
      await this.table.put('muse', next)
      return structuredClone(next)
    })
  }
  async sourceCheck(rootSessionId, quoteId) {
    await this.readDiscoveryImSnapshot(rootSessionId)
    const quote = this.quotes.get(quoteId)
    if (!this.ownsRoot(rootSessionId) || !quote || quote.rootSessionId !== rootSessionId) throw new Error('Exact owned source quote required')
    const value = [...this.table.entries()].find(([, item]) => item.rootSessionId === rootSessionId)?.[1]
    const snapshot = quote.snapshot
    const anchor = this.candidateSources(rootSessionId).find(item => item.anchorId === snapshot.anchorId)
    const goalCard = snapshot.kind === 'goal' && snapshot.cardId === `goal:${snapshot.anchorId}` && value.goals.some(goal => goal.id === snapshot.anchorId && !goal.done)
    const card = goalCard ? snapshot : value?.candidates?.find(item => item.cardId === snapshot.cardId)
    if (!card || card.withdrawn || card.paused || !anchor || anchor.version !== snapshot.version || anchor.sourceText !== snapshot.sourceText || (!goalCard && sourceSignature(card) !== sourceSignature(snapshot))) throw new Error('Linked source changed, withdrawn or paused; explicitly refresh the reference before sending')
    if (card.quality?.sourceRefs?.some(ref => { const current = this.candidateSources(rootSessionId).find(source => source.anchorId === ref.anchorId); return !current || current.version !== ref.version || !current.sourceText.includes(ref.quote) })) throw new Error('Linked source changed: cited related source is no longer current')
    if (card.contextEvidence) await this.contextSourceCheck(rootSessionId, card.contextEvidence)
    return { quoteId, cardId: snapshot.cardId, anchorId: snapshot.anchorId, version: snapshot.version, signature: sourceSignature(card), title: snapshot.title, kind: goalCard ? 'goal' : 'candidate' }
  }
  linkedSourceCheck(rootSessionId, quoteId) { return this.sourceCheck(rootSessionId, quoteId) }
  async sourceStateForMessage(rootSessionId, messageId) {
    const message = this.inbox.get(messageId)
    if (!this.ownsRoot(rootSessionId) || !message || message.rootSessionId !== rootSessionId) return { status: 'invalid_source', messageId, reason: 'Exact owned human input required' }
    const envelope = requestQuote(message.text)
    if (envelope.status !== 'quote') return { ...envelope, messageId }
    const quote = this.quotes.get(envelope.quoteId)
    if (!quote || quote.rootSessionId !== rootSessionId) return { status: 'invalid_source', messageId, quoteId: envelope.quoteId, reason: 'Exact owned source quote required' }
    const anchor = this.candidateSources(rootSessionId).find(item => item.anchorId === quote.snapshot.anchorId)
    const versions = { expectedVersion: quote.snapshot.version, ...(anchor ? { currentVersion: anchor.version } : {}) }
    try { return { status: 'current', messageId, ...versions, source: await this.sourceCheck(rootSessionId, envelope.quoteId) } }
    catch (error) { return { status: 'source_changed', messageId, quoteId: envelope.quoteId, ...versions, reason: error.message } }
  }
  async sourceState(input) { return this.write(async () => structuredClone(await this.sourceStateForMessage(input.rootSessionId, input.messageId))) }
  async admitWork(task, source) {
    return this.write(async () => {
      if (!this.ownsRoot(task.rootSessionId)) throw new Error('Muse root required')
      const existing = this.tasks.get(task.id)
      if (existing) { if (existing.rootSessionId !== task.rootSessionId) throw new Error('Work identity belongs to another root'); return { admitted: true, duplicate: true, task: structuredClone(existing) } }
      const state = await this.sourceStateForMessage(task.rootSessionId, task.id)
      if (!['none', 'current'].includes(state.status) || (state.source?.signature || null) !== (source?.signature || null) || (state.source?.quoteId || null) !== (source?.quoteId || null)) return { admitted: false, sourceState: state }
      await this.tasks.put(task.id, structuredClone(task))
      return { admitted: true, duplicate: false }
    })
  }
  async linkedSource(input) { return this.write(() => {
    const quote = this.quotes.get(input.quoteId)
    if (!quote || quote.rootSessionId !== input.rootSessionId || !this.ownsRoot(input.rootSessionId)) throw new Error('Exact owned source quote required')
    const card = quote.snapshot
    return { quoteId: quote.id, cardId: card.cardId, anchorId: card.anchorId, version: card.version, signature: sourceSignature(card), title: card.title }
  }) }
  async withLinkedSource(rootSessionId, source, action) {
    return this.write(async () => { if (!this.ownsRoot(rootSessionId)) throw new Error('Exact Muse root authorization no longer current'); if (source) { try { const current = await this.linkedSourceCheck(rootSessionId, source.quoteId); if (current.signature !== source.signature) throw new Error('Linked source binding changed') } catch (error) { error.code = 'muse/source-changed'; throw error } } return action() })
  }
  async projectLinkedCard(rootSessionId, projection) {
    return this.write(async () => {
      const owned=[...this.table.entries()].find(([,value])=>value.rootSessionId===rootSessionId)?.[1]
      const applied=[...(owned?.goals||[]),...(owned?.candidates||[])].flatMap(card=>card.linkedResults||[]).find(result=>result.key===projection.key&&result.sourceSignature===projection.source.signature&&result.targetSessionId===projection.targetSessionId&&result.text===projection.text)
      if(applied)return{status:'applied',duplicate:true}

      let current
      try { current = await this.linkedSourceCheck(rootSessionId, projection.source.quoteId) }
      catch (error) { return { status: 'stale', error: error.message } }
      if (current.signature !== projection.source.signature) return { status: 'stale', error: 'Source signature no longer current' }
      const entry = [...this.table.entries()].find(([, value]) => value.rootSessionId === rootSessionId)
      const card = current.kind === 'goal' ? entry[1].goals.find(item => item.id === current.anchorId) : entry[1].candidates.find(item => item.cardId === current.cardId)
      if (card.linkedResults?.some(result => result.key === projection.key)) return { status: 'applied', duplicate: true }
      const result = { key: projection.key, sourceVersion: current.version, sourceSignature: current.signature, targetSessionId: projection.targetSessionId, outcome: projection.outcome, text: projection.text, createdAt: new Date().toISOString() }
      const next = { ...entry[1], revision: entry[1].revision + 1, goals: entry[1].goals.map(item => current.kind === 'goal' && item.id === current.anchorId ? { ...item, linkedResults: [...(item.linkedResults || []), result] } : item), candidates: entry[1].candidates?.map(item => current.kind !== 'goal' && item.cardId === card.cardId ? { ...item, linkedResults: [...(item.linkedResults || []), result] } : item), saved: entry[1].saved?.map(item => item.cardId === current.cardId && sourceSignature(item) === current.signature ? { ...item, linkedResults: [...(item.linkedResults || []).filter(row => row.key !== result.key), result] } : item) }
      // Undefined optional fields are omitted before JSON storage.
      if (!next.saved) delete next.saved
      if (!next.candidates) delete next.candidates
      await this.table.put(entry[0], next)
      return { status: 'applied' }
    })
  }
  async linkedAll() { await this.tail; return [...this.linkedWorks.entries()].map(([, work]) => structuredClone(work)) }
  async linkedPut(work) { return this.write(() => this.linkedWorks.put(work.id, structuredClone(work))) }
  linkedCandidates(input) { if (!this.linkedController) throw new Error('Linked work unavailable'); return this.linkedController.metadata(input) }
  linkSessionWork(input) { if (!this.linkedController) throw new Error('Linked work unavailable'); return this.linkedController.link(input) }
  continueLinkedWork(input) { if (!this.linkedController) throw new Error('Linked work unavailable'); return this.linkedController.supplement(input) }
  async linkedWorkList(input) { if (!this.linkedController) throw new Error('Linked work unavailable'); const works = await this.linkedController.poll(input); return Promise.all(works.map(async work => ({ ...work, deliveries: await Promise.all(work.deliveries.map(async delivery => ({ ...delivery, results: await withResultFiles(delivery.results) }))) }))) }
  async taskList() { await this.tail; return Promise.all([...this.tasks.entries()].map(async ([, task]) => ({ ...structuredClone(task), results: await withResultFiles(task.results) }))) }
  async cardAttributionNow(rootSessionId, cardId) {
    if (!this.ownsRoot(rootSessionId)) throw Error('Exact attribution root required')
    const identity = [...this.table.entries()].find(([, value]) => value.rootSessionId === rootSessionId)[1]
    const card = identity.candidates?.find(card => card.cardId === cardId)
    if (!card) return { revision: 1, rootSessionId, cardId, state: 'legacy_unverified', humanQuotes: [], sources: [], notice: '没有核实的人类引文' }
    if (!card.contextEvidence) return sourceAttribution(card, null, rootSessionId)
    try {
      const run = this.heartbeatControl.get('owner')?.runs?.[card.discoveryRunId]
      const projection = sourceAttribution(card, run?.contextPacket, rootSessionId)
      await this.contextSourceCheck(rootSessionId, card.contextEvidence)
      return { ...projection, signature: sourceSignature(card) }
    } catch { return { revision: 1, rootSessionId, cardId, state: 'source_unverified', humanQuotes: [], sources: [], notice: '来源已变化或尚未核实，未显示为你的原话' } }
  }
  async cardAttributions(input) {
    return this.write(async () => {
      if (!this.ownsRoot(input.rootSessionId) || !Array.isArray(input.cardIds) || input.cardIds.length > 12 || input.cardIds.some(id => typeof id !== 'string')) throw Error('Exact bounded attribution request required')
      return Promise.all(input.cardIds.map(id => this.cardAttributionNow(input.rootSessionId, id)))
    })
  }
  async saveQuote(input) {
    const value=await this.write(async () => {
      if (!this.ownsRoot(input.rootSessionId)) throw new Error('Muse root mismatch')
      const snapshot = structuredClone(input.snapshot)
      delete snapshot.attribution
      const identity = [...this.table.entries()].find(([, value]) => value.rootSessionId === input.rootSessionId)[1]
      const card = identity.candidates?.find(card => card.cardId === snapshot.cardId)
      if (card?.contextEvidence && sourceSignature(card) !== sourceSignature(snapshot)) throw Error('Source snapshot changed or rewritten; refresh the card')
      snapshot.attribution = await this.cardAttributionNow(input.rootSessionId, snapshot.cardId)
      const value = { id: randomUUID(), rootSessionId: input.rootSessionId, snapshot, createdAt: new Date().toISOString() }
      await this.quotes.put(value.id, value)
      return structuredClone(value)
    })
    if(this.ownsFormalRoot(input.rootSessionId)&&value.snapshot.observation)try{await (await this.observationOwner()).feedback(input.rootSessionId,{eventId:`quote:${value.id}`,cardId:value.snapshot.cardId,cardVersion:value.snapshot.version,cardContext:this.observationCardContext(value.snapshot),action:'viewed',basis:'explicit quote-to-draft interaction',quoteId:value.id,effect:'unknown'})}catch{value.observationFeedbackStatus='unconfirmed'};return value
  }
  async cancelWork(input) {
    if (!this.ownsRoot(input.rootSessionId) || !this.cancelOwnedWork) throw new Error('Muse cancellation unavailable')
    return this.cancelOwnedWork(input)
  }
  async readQuote(input) {
    await this.tail
    const value = this.quotes.get(input.id)
    if (!value || value.rootSessionId !== input.rootSessionId) throw new Error('Muse source snapshot mismatch')
    return structuredClone(value)
  }
  async setGoalForRoot(rootSessionId, title, sourceMessageId) {
    return this.write(async () => {
      const entry = [...this.table.entries()].find(([, value]) => value.rootSessionId === rootSessionId)
      if (!entry) throw new Error('Muse root mismatch')
      const existing = entry[1].goals.find(goal => goal.title === title && !goal.done)
      if (existing) return { goal: structuredClone(existing), revision: entry[1].revision, duplicate: true }
      const goal = { id: randomUUID(), title, done: false, version: 1, ...(sourceMessageId ? { sourceMessageId } : {}) }
      const next = { ...entry[1], revision: entry[1].revision + 1, goals: [...entry[1].goals, goal] }
      await this.table.put(entry[0], next)
      return { goal: structuredClone(goal), revision: next.revision, duplicate: false }
    })
  }
  async discoverGoalProposals(input) {
    const root=input.rootSessionId
    if(!this.ownsRoot(root))throw Error('Exact Muse root required')
    this.goalDiscoveryFlights ||= new Map()
    if(this.goalDiscoveryFlights.has(root))return this.goalDiscoveryFlights.get(root)
    const flight=(async()=>{
      const im=await this.readDiscoveryImSnapshot(root)
      if(!im)throw Error('聊天历史尚不可用')
      const key=this.memoryKey(root),identity=this.table.get(key)
      const packet={messages:im.messages.filter(m=>m.role==='user').slice(-60).map(m=>({id:m.id,text:m.text.slice(0,1200)})),goals:identity.goals,previous:(identity.goalProposals||[]).map(p=>({title:p.title,status:p.status}))}
      const proposals=await discoverGoals(this.ctx,root,packet)
      return this.write(async()=>{
        if(!this.ownsRoot(root)||this.table.get(key)?.rootSessionId!==root)throw Error('Muse root changed')
        const current=this.table.get(key),previous=current.goalProposals||[]
        const fresh=proposals.filter(p=>!previous.some(q=>q.fingerprint===p.fingerprint||equivalent(q.title,p.title))&&!current.goals.some(g=>equivalent(g.title,p.title)))
        if(previous.length+fresh.length>200)throw Error('目标建议记录已满')
        const next={...current,goalProposals:[...previous,...fresh],revision:current.revision+1}
        await this.table.put(key,next);return this.identityView(next)
      })
    })().finally(()=>this.goalDiscoveryFlights.delete(root))
    this.goalDiscoveryFlights.set(root,flight);return flight
  }
  async decideGoalProposal(input, assertCurrent) {
    return this.write(async()=>{
      assertCurrent?.()
      const key=this.memoryKey(input.rootSessionId),current=this.table.get(key)
      const next=decideGoalProposal(current,input)
      if(next!==current)await this.table.put(key,next)
      return this.identityView(next)
    })
  }
  async recordIdeaFeedback(input) {
    return this.write(async()=>{
      const entry=[...this.table.entries()].find(([,v])=>v.rootSessionId===input.rootSessionId)
      if(!entry)throw Error('Exact Muse root required')
      const card=entry[1].candidates?.find(c=>c.cardId===input.cardId)
      const updated=updateIdeaFeedback(card,input)
      if(updated===card)return this.identityView(entry[1])
      const next={...entry[1],revision:entry[1].revision+1,candidates:entry[1].candidates.map(c=>c.cardId===card.cardId?updated:c),saved:(entry[1].saved||[]).map(c=>c.cardId===card.cardId?{...c,feedback:updated.feedback}:c)}
      await this.table.put(entry[0],next)
      return this.identityView(next)
    })
  }
  async setIdeaDeleted(input) {
    return this.write(async()=>{
      if(typeof input.deleted!=='boolean')throw Error('Explicit deletion state required')
      const entry=[...this.table.entries()].find(([,v])=>v.rootSessionId===input.rootSessionId)
      if(!entry)throw Error('Exact Muse root required')
      const card=entry[1].candidates?.find(c=>c.cardId===input.cardId)
      if(!card||card.version!==input.version)throw Error('点子已变化，请刷新后重试')
      if(Boolean(card.deleted)===input.deleted)return this.identityView(entry[1])
      const updated={...card,deleted:input.deleted}
      const next={...entry[1],revision:entry[1].revision+1,candidates:entry[1].candidates.map(c=>c.cardId===card.cardId?updated:c)}
      await this.table.put(entry[0],next);return this.identityView(next)
    })
  }
  async saveFeed(input) {
    return this.write(async () => {
      const entry = [...this.table.entries()].find(([, value]) => value.rootSessionId === input.rootSessionId)
      if (!entry || entry[1].revision !== input.revision) throw new Error('Muse 来源已变化，请刷新后保存')
      const saved = z.array(z.record(z.string(), z.unknown())).max(100).parse(input.saved)
      const next = { ...entry[1], saved, revision: entry[1].revision + 1 }
      await this.table.put(entry[0], next)
      return this.identityView(next)
    })
  }
  memoryKey(root){const entry=[...this.table.entries()].find(([,v])=>v.rootSessionId===root);if(!entry)throw Error('Exact Muse root required');return entry[0]}
  memoryState(root){const key=this.memoryKey(root);if(!this.memories)throw Error('Memory storage unavailable');return structuredClone(this.memories.get(key)||emptyMemory())}
  memoryRead(root,input){return readMemory(this.memoryState(root),input)}
  memoryRecall(root,query){try{return memoryContext(this.memoryState(root),query)}catch{return{unavailable:true,notice:'Memory unavailable; continue the conversation without inventing recalled facts.'}}}
  async memoryWrite(root,input,frontier){return this.write(async()=>{const key=this.memoryKey(root),im=frontier();if(im?.root!==root)throw Error('Memory source root mismatch');const changed=changeMemory(this.memoryState(root),input,im);await this.memories.put(key,changed.state);return changed.result})}
  async mutateImGoal(rootSessionId, input, frontier) {
    return this.write(async () => {
      const {action,title,goal_id,expected_version,message_id,input_version,request_id}=input
      if(!['create','update','complete'].includes(action)||typeof title!=='string'||!title.trim()||title.length>2000||typeof request_id!=='string'||!request_id.trim()||request_id.length>100)throw Error('Valid goal action, title and stable request_id required')
      const entry=[...this.table.entries()].find(([,v])=>v.rootSessionId===rootSessionId)
      if(!entry)throw Error('Exact Muse root required')
      const im=frontier(),human=im?.messages?.filter(m=>m.role==='user').at(-1)
      if(!im?.enabled||im.hold||im.root!==rootSessionId||im.inputVersion!==input_version||human?.id!==message_id)throw Error('Goal request changed; read latest human context before saving')
      const mutationId=hashSource([rootSessionId,message_id,request_id]),goals=structuredClone(entry[1].goals)
      const previous=goals.find(g=>g.mutationId===mutationId)
      if(previous){if(previous.title!==title.trim()||(action!=='create'&&previous.id!==goal_id))throw Error('Stable request_id reused with different goal');return{saved:true,duplicate:true,goal:previous,revision:entry[1].revision}}
      let saved
      if(action==='create'){
        if(goal_id!==undefined||expected_version!==undefined)throw Error('Create does not accept existing goal selectors')
        if(goals.length>=200)throw Error('Goal limit reached')
        saved={id:randomUUID(),title:title.trim(),done:false,version:1,sourceMessageId:message_id,mutationId};goals.push(saved)
      }else{
        const index=goals.findIndex(g=>g.id===goal_id)
        if(index<0||!Number.isInteger(expected_version)||goals[index].version!==expected_version)throw Error('Goal changed or missing; reread goals before updating')
        saved={...goals[index],...(action==='complete'?{done:true}:{}),title:title.trim(),version:goals[index].version+1,sourceMessageId:message_id,mutationId};goals[index]=saved
      }
      const next={...entry[1],goals,revision:entry[1].revision+1}
      await this.table.put(entry[0],next)
      return{saved:true,goal:saved,revision:next.revision,executionStarted:false}
    })
  }
  async saveGoals(input) {
    return this.write(async () => {
      const entry = [...this.table.entries()].find(([, value]) => value.rootSessionId === input.rootSessionId)
      const current = entry?.[1]
      if (!current || input.rootSessionId !== current.rootSessionId) throw new Error('Muse root mismatch')
      if (input.revision !== current.revision) throw new Error('Muse goals changed; reload before saving')
      const goals = z.array(goal).max(200).parse(input.goals)
      const next = { ...current, goals, revision: current.revision + 1 }
      await this.table.put(entry[0], next)
      return this.identityView(next)
    })
  }
}
// JavaScript equivalent of the public Stage-3 @Remote decorator. No private metadata writes.
for (const name of ['observeMuse', 'readObservation', 'stopObservation', 'recordObservationFeedback', 'prepareObservationRun', 'decideObservationRun', 'readObservationPreview', 'prepareObservationFeedback', 'previewObservation', 'identity', 'qaIdentity', 'recoverSynthetic', 'saveGoals', 'saveFeed', 'setIdeaDeleted', 'recordIdeaFeedback', 'discoverGoalProposals', 'decideGoalProposal', 'saveQuote', 'readQuote', 'taskList', 'checkHeartbeat', 'requestDiscovery', 'readDiscoveryRequest', 'cancelWork', 'linkedCandidates', 'linkSessionWork', 'continueLinkedWork', 'linkedWorkList', 'sourceState', 'cardAttributions', 'imReceive', 'imRead', 'imTyping', 'imAck']) {
  Remote(MuseService.prototype[name], { kind: 'method', name, static: false, private: false,
    addInitializer(initialize) { initialize.call(Object.create(MuseService.prototype)) } })
}

export const observationRuntimeRevision=hashSource([consentRevision,observationRevision,sourceSignature.toString(),...['requireObservationRoot','validateObservationEvidence','captureObservationSnapshot','projectObservationIdeas','observationUsageNow','observationOwner','observeMuse','readObservation','stopObservation','recordObservationFeedback','prepareObservationRun','decideObservationRun','observationConsentControl','observationConsentCards','validateObservationConsent','authorizeObservationInput','assertObservationConsent','reserveObservationAnalysis','liveObservationPreviewOwner','readObservationPreview','prepareObservationFeedback','observationCardContext','previewObservation','saveQuote'].map(n=>MuseService.prototype[n].toString())])
