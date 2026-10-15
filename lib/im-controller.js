import {readImContext,imInputPacket} from './im-context.js'
import { randomUUID } from 'node:crypto'
const terminal = new Set(['completed','failed','cancelled'])
const active = w => !terminal.has(w.status)
const clean = (text,max=32000) => { if(typeof text!=='string'||!text.trim()||text.length>max)throw Error('Bounded message text required');return text.trim() }
const launchReply=(w,duplicate)=>({workId:w.id,childId:w.childId,status:w.status,launchStatus:w.launchStatus,startConfirmed:w.launchStatus==='accepted'&&typeof w.execution?.messageId==='string'&&Boolean(w.execution.messageId.trim())&&['running','completed'].includes(w.status),duplicate})
export const imProtocol = 'muse-im/1'
/** All durable transitions serialize; model/worker execution never occupies this writer. */
export function createImController({journal,adapter,clock={now:()=>Date.now(),setTimeout,clearTimeout},quietMs=800,maxWaitMs=4000}) {
  const states=new Map(),timers=new Map(),typing=new Map(),ops=new Set();let tail=Promise.resolve(),dead=false
  const queue=fn=>{const p=tail.then(()=>{if(dead)throw Error('IM controller closed');return fn()});tail=p.catch(()=>{});return p}
  const track=p=>{ops.add(p);p.catch(adapter.warn||(()=>{})).finally(()=>ops.delete(p));return p}
  const state=async root=>{if(states.has(root))return states.get(root);let s=await journal.load(root);if(s&&s.version!==1)throw Error('Unknown IM journal; no reset');if(!s)s={version:1,root,revision:0,inputVersion:0,seq:0,enabled:false,legacyCutoffSeq:-1,messages:[],batches:{},works:{},commitments:{},hold:false};states.set(root,s);return s}
  const change=async(root,fn)=>{const old=await state(root),s=structuredClone(old);const result=fn(s);s.revision++;await journal.save(s);states.set(root,s);return result}
  const snapshot=async root=>structuredClone(await state(root))
  const arm=root=>{if(dead)return;clock.clearTimeout(timers.get(root));const s=states.get(root);if(!s||s.hold)return;const b=Object.values(s.batches).find(b=>b.status==='buffering');if(!b)return;const activity=Math.max(b.lastAt,typing.get(root)?.at||0);const due=Math.min(activity+quietMs,b.firstAt+maxWaitMs);timers.set(root,clock.setTimeout(()=>{track(dispatch(root)).catch(()=>{})},Math.max(1,due-clock.now())))}
  const packet=imInputPacket
  async function dispatch(root) {
    const job=await queue(async()=>{
      const s=await state(root);if(s.hold)return null
      const b=Object.values(s.batches).find(b=>b.status==='buffering');if(!b)return null
      if(clock.now()<Math.min(Math.max(b.lastAt,typing.get(root)?.at||0)+quietMs,b.firstAt+maxWaitMs)){arm(root);return null}
      const domain=await adapter.goalContext?.(root);
      return change(root,n=>{const b=n.batches[Object.values(n.batches).find(b=>b.status==='buffering').id];b.status='dispatching';b.admissionVersion=n.inputVersion;b.requestId ||= randomUUID();return{batchId:b.id,requestId:b.requestId,packet:packet(domain?{...n,goals:domain.goals,goalRevision:domain.revision}:n,b)}})
    });if(!job)return
    try{await adapter.mainPrompt(root,job.requestId,job.packet);await queue(()=>change(root,s=>{s.batches[job.batchId].status='accepted'}))}
    catch(e){await queue(()=>change(root,s=>{s.batches[job.batchId].status='uncertain';s.batches[job.batchId].error=e.message}))}
    arm(root)
  }
  async function receive(input) {
    const text=clean(input.text);if(!/^[a-f\d-]{36}$/i.test(input.clientMessageId||''))throw Error('Stable client_message_id required')
    const result=await queue(async()=>{
      const s=await state(input.rootSessionId),old=s.messages.find(m=>m.clientMessageId===input.clientMessageId)
      if(old){if(old.text!==text||(old.quote?.id||null)!==(input.quote?.id||null)||(Object.hasOwn(old,'requestedWorkId')&&old.requestedWorkId!==(input.workId||null)))throw Error('Message identity reused with changed content');return{message:old,duplicate:true}}
      if(input.workId&&(!s.works[input.workId]||!active(s.works[input.workId])))throw Error('Exact active owned UI work required')
      const quote=input.quote?await adapter.quote(input.rootSessionId,input.quote):null
      if(!s.enabled)await adapter.beforeEnable?.(input.rootSessionId)
      return change(input.rootSessionId,n=>{
        if(!n.enabled){n.enabled=true;n.legacyCutoffSeq=adapter.cutoff(n.root)}
        const m={id:randomUUID(),clientMessageId:input.clientMessageId,seq:++n.seq,role:'user',text,at:clock.now(),status:'accepted',requestedWorkId:input.workId||null,...(quote?{quote}: {})};n.messages.push(m);n.inputVersion++
        // Existing UI Stop protocol is structured by exact owned workId plus fixed payload,
        // not a general natural-language authorization classifier.
        if(input.workId&&text==='停止'){
          const w=n.works[input.workId];w.intentVersion++;w.lastControlSeq=m.seq;m.workId=w.id;m.kind='control';w.constraints.push({messageId:m.id,text,version:w.intentVersion});
          const c={id:randomUUID(),messageId:m.id,version:w.intentVersion,kind:'cancel',requestedAction:'cancel',inputVersion:n.inputVersion,text,status:'pending'};w.controls.push(c);w.status='cancelling';w.stopReason='cancel';return{message:m,control:{workId:w.id,control:c}}
        }
        let b=Object.values(n.batches).find(b=>b.status==='buffering')
        if(!b){b={id:randomUUID(),messageIds:[],status:'buffering',firstAt:clock.now(),lastAt:clock.now()};n.batches[b.id]=b;n.commitments[b.id]={id:b.id,status:'awaiting_reply',messageIds:[],expected:'unclassified'}}
        if(m.kind==='continuation')b.admissionVersion=n.inputVersion;
        b.messageIds.push(m.id);b.lastAt=clock.now();n.commitments[b.id].messageIds.push(m.id);m.batchId=b.id
        return{message:m,...(b.status!=='buffering'?{continuation:{batchId:b.id,workId:b.workId||null,messageId:m.id,text}}:{})}
      })
    })
    await adapter.enable(input.rootSessionId)
    if(result.control)track(deliverControl(input.rootSessionId,result.control))
    if(result.continuation)track(adapter.continuation(input.rootSessionId,result.continuation))
    arm(input.rootSessionId)
    return{accepted:true,messageId:result.message.id,seq:result.message.seq,duplicate:!!result.duplicate}
  }
  async function deliverControl(root,{workId,control}) {
    const s=await snapshot(root),w=s.works[workId];if(!w)return
    await queue(()=>change(root,s=>{s.works[workId].controls.find(c=>c.id===control.id).status='dispatching'}))
    try{
      if(control.kind==='steer'){await queue(()=>change(root,s=>{s.works[workId].execution={generation:(w.execution?.generation||1)+1,controlId:control.id,intentVersion:control.version,afterSeq:w.terminal?.seq??-1}}));const receipt=await adapter.steer(root,w,control);await queue(()=>change(root,s=>{const c=s.works[workId].controls.find(c=>c.id===control.id);c.status='accepted';c.receipt=receipt;s.works[workId].execution.messageId=receipt}))}
      else{adapter.cancel(root,w);await queue(()=>change(root,s=>{s.works[workId].controls.find(c=>c.id===control.id).status='cancel_requested'}))}
    }catch(e){await queue(()=>change(root,s=>{const c=s.works[workId].controls.find(c=>c.id===control.id);c.status='uncertain';c.error=e.message}))}
  }
  function admission(s,input,expectedVersion) {
    const batch=s.batches[input.batch_id];if(!batch||!s.enabled)throw Error('Exact IM batch required')
    if(batch.workId)return{batch,duplicate:s.works[batch.workId]}
    const lastSeq=Math.max(...batch.messageIds.map(id=>s.messages.find(m=>m.id===id)?.seq??-1))
    const version=batch.revalidation?.inputVersion??batch.admissionVersion??s.messages.filter(m=>m.role==='user'&&m.seq<=lastSeq).length
    const requested=input.input_version??version
    if(s.hold)throw Error('Explicit listen hold blocks work admission')
    if(batch.launchBlocked)throw Error('Accepted stop blocks this pending batch admission')
    if(!Number.isInteger(requested)||requested!==s.inputVersion||version!==s.inputVersion||(expectedVersion!==undefined&&expectedVersion!==s.inputVersion))throw Error('Input changed before work admission; reconcile latest IM input')
    if(batch.revalidation&&JSON.stringify(batch.revalidation.authorizedMessageIds)!==JSON.stringify(batch.messageIds))throw Error('Original authorized batch changed after revalidation')
    if(!['accepted','dispatching'].includes(batch.status))throw Error('Collected batch must be dispatched before work admission')
    if(Object.values(s.works).some(active))throw Error('First slice permits one independent research; clarify existing work')
    return{batch,version:s.inputVersion}
  }
  async function reconcilePending(root,input) {
    return queue(()=>change(root,s=>{
      if(Object.keys(input).some(k=>!['batch_id','input_version','decisions'].includes(k)))throw Error('Exact pending revalidation fields required')
      const b=s.batches[input.batch_id]
      if(!s.enabled||!b||b.workId||!['accepted','dispatching'].includes(b.status))throw Error('Exact unresolved dispatched batch required')
      if(s.hold||b.launchBlocked)throw Error('Pending work paused or cancelled')
      if(s.commitments[b.id]?.status!=='awaiting_reply')throw Error('Exact unresolved commitment required')
      if(!Number.isInteger(input.input_version)||input.input_version!==s.inputVersion)throw Error('Input changed before pending revalidation')
      if(Object.values(s.works).some(active))throw Error('Existing active work blocks pending revalidation')
      const original=b.messageIds.map(id=>s.messages.find(m=>m.id===id))
      const through=Math.max(...original.map(m=>m.seq))
      const later=s.messages.filter(m=>m.role==='user'&&m.seq>through)
      if(!Array.isArray(input.decisions)||input.decisions.length!==later.length||later.length>100)throw Error('Every later original human message requires bounded reconciliation')
      const supplements=[]
      for(let i=0;i<later.length;i++){
        const m=later[i],d=input.decisions[i]
        if(!d||Object.keys(d).some(k=>!['message_id','relation'].includes(k))||d.message_id!==m.id||!['aside','supplement','cancel','replacement'].includes(d.relation))throw Error('Exact ordered original message decisions required')
        if(m.workId||['hold','control','constraint','ambiguous_control'].includes(m.kind)||s.batches[m.batchId]?.launchBlocked)throw Error('Host control cannot be classified as aside')
        if(d.relation==='supplement')supplements.push(m.id)
      }
      const withdrawn=input.decisions.find(d=>['cancel','replacement'].includes(d.relation))
      if(withdrawn){b.launchBlocked=withdrawn.message_id;s.commitments[b.id].status='cancelled';b.reconciliation={inputVersion:s.inputVersion,decisions:structuredClone(input.decisions),at:clock.now()};return{accepted:true,batchId:b.id,inputVersion:s.inputVersion,cancelled:true,started:false}}
      b.revalidation={inputVersion:s.inputVersion,authorizedMessageIds:[...b.messageIds],authorizedThroughSeq:through,decisions:structuredClone(input.decisions),supplementMessageIds:supplements,at:clock.now()}
      return{accepted:true,batchId:b.id,inputVersion:s.inputVersion,authorizedMessageIds:[...b.messageIds],supplementMessageIds:supplements,started:false}
    }))
  }
  async function declareIntent(root,input){return queue(()=>change(root,s=>{
    if(Object.keys(input).some(k=>!['batch_id','input_version','intent'].includes(k))||!['answer','research'].includes(input.intent))throw Error('Exact declared intent fields required')
    const b=s.batches[input.batch_id],c=s.commitments[input.batch_id];if(!s.enabled||!b||!c||b.workId||b.launchBlocked||s.hold||!['accepted','dispatching'].includes(b.status)||c.status!=='awaiting_reply')throw Error('Exact unresolved batch required')
    if(input.input_version!==s.inputVersion||(b.revalidation?.inputVersion??b.admissionVersion)!==s.inputVersion)throw Error('Input changed before intent declaration')
    if(c.declaration&&c.expected!==input.intent)throw Error('Existing intent cannot be silently reclassified')
    if(!c.declaration)c.legacyExpected=c.expected
    c.expected=input.intent;if(!c.declaration||c.declaration.inputVersion!==s.inputVersion)c.declaration={intent:input.intent,inputVersion:s.inputVersion,messageIds:[...b.messageIds],executionAfterSeq:adapter.cutoff(root),at:clock.now()};c.declaration.intent=input.intent;return{accepted:true,intent:c.expected,started:false}
  }))}
  // A direct native completion is explicit, separate from an acknowledgment.
  // Its semantic accuracy remains the native model responsibility, as for worker results.
  async function directResult(root,input){const captured=await queue(async()=>{const s=await state(root),b=s.batches[input.batch_id];if(!b||input.input_version!==s.inputVersion)throw Error('Input changed before direct completion');const c=s.commitments[b.id];if(!c?.declaration||c.declaration.inputVersion!==s.inputVersion||!Number.isInteger(c.declaration.executionAfterSeq))throw Error('Declared current research execution required');if(!Array.isArray(input.evidence_call_ids)||input.evidence_call_ids.length<1||input.evidence_call_ids.length>20||new Set(input.evidence_call_ids).size!==input.evidence_call_ids.length)throw Error('Successful native research evidence required');return{version:s.inputVersion,afterSeq:c.declaration.executionAfterSeq,quotes:[...b.messageIds,...(b.revalidation?.supplementMessageIds||[])].map(id=>s.messages.find(m=>m.id===id)?.quote).filter(Boolean)}});if(!adapter.directEvidence)throw Error('Successful native research evidence unavailable');const evidence=await adapter.directEvidence(root,input.evidence_call_ids,captured.afterSeq);if(!Array.isArray(evidence)||evidence.length!==input.evidence_call_ids.length)throw Error('Successful native research evidence required');for(const quote of captured.quotes)await adapter.currentQuote(root,quote);return queue(()=>change(root,s=>{
    if(Object.keys(input).some(k=>!['batch_id','input_version','result_id','text','evidence_call_ids'].includes(k)))throw Error('Exact direct result fields required')
    const b=s.batches[input.batch_id],c=s.commitments[input.batch_id];if(!b||!c||c.expected!=='research'||c.status!=='awaiting_reply'||b.workId||b.launchBlocked||s.hold)throw Error('Declared independent direct research required')
    if(input.input_version!==s.inputVersion||captured.version!==s.inputVersion||(b.revalidation?.inputVersion??b.admissionVersion)!==s.inputVersion)throw Error('Input changed before direct completion')
    const id=clean(input.result_id,100),text=clean(input.text,12000);s.directResults||={};const old=s.directResults[id];if(old){if(old.batchId!==b.id||old.text!==text||old.inputVersion!==input.input_version||JSON.stringify(old.evidence)!==JSON.stringify(evidence))throw Error('Direct result identity reused with changed payload');return{accepted:true,resultId:id,duplicate:true,started:false}}
    s.directResults[id]={id,batchId:b.id,inputVersion:s.inputVersion,text,status:'ready',evidence:structuredClone(evidence),at:clock.now()};return{accepted:true,resultId:id,started:false}
  }))}
  async function startWork(root,input) {
    // Source checks may wait: they never hold the IM writer or prevent a stop receipt.
    const captured=await queue(async()=>{const s=await state(root),a=admission(s,input);return a.duplicate?{duplicate:structuredClone(a.duplicate)}:{version:a.version,quotes:[...a.batch.messageIds,...(a.batch.revalidation?.supplementMessageIds||[])].map(id=>s.messages.find(m=>m.id===id).quote).filter(Boolean)}})
    if(captured.duplicate)return launchReply(captured.duplicate,true)
    for(const quote of captured.quotes)await adapter.currentQuote(root,quote)
    const reserved=await queue(async()=>{
      const s=await state(root),a=admission(s,input,captured.version)
      if(a.duplicate)return{work:structuredClone(a.duplicate),duplicate:true}
      const work=await change(root,n=>{const b=n.batches[input.batch_id],w={id:randomUUID(),root,childId:randomUUID(),batchId:b.id,goal:clean(input.goal,1000),intentVersion:1,status:'running',admissionVersion:n.inputVersion,launchStatus:'dispatching',execution:{generation:1,dispatchId:randomUUID(),intentVersion:1,afterSeq:-1},constraints:(b.revalidation?.supplementMessageIds||[]).map(messageId=>{const m=n.messages.find(m=>m.id===messageId);return{messageId,text:m.text,version:1,...(m.quote?{quote:structuredClone(m.quote)}:{})}}),authorization:{batchId:b.id,messageIds:[...b.messageIds]},revalidation:b.revalidation?structuredClone(b.revalidation):null,controls:[],results:[],createdAt:clock.now(),toolCalls:0,maxToolCalls:12};n.works[w.id]=w;b.workId=w.id;n.commitments[b.id].expected='research';n.commitments[b.id].status='working';n.commitments[b.id].workId=w.id;return structuredClone(w)})
      // Invoke the adapter inside this serialized commit boundary, but never await
      // worker creation here. The native adapter dispatch itself is synchronous.
      let pending;try{pending=Promise.resolve(adapter.start(root,work))}catch(error){pending=Promise.reject(error)}
      pending.catch(()=>{});return{work,pending,duplicate:false}
    })
    if(reserved.duplicate)return launchReply(reserved.work,true)
    try{const receipt=await reserved.pending;if(!receipt||typeof receipt.messageId!=='string'||!receipt.messageId.trim()||(receipt.childId!==undefined&&receipt.childId!==reserved.work.childId))throw Error('Worker launch receipt not confirmed');await queue(()=>change(root,s=>{const w=s.works[reserved.work.id];w.launchReceipt=receipt;w.execution.messageId=receipt.messageId;w.launchStatus='accepted'}))}
    catch(e){await queue(()=>change(root,s=>{const w=s.works[reserved.work.id];w.launchStatus='uncertain';if(w.status==='running')w.status='uncertain';w.error=e.message}))}
    const w=(await snapshot(root)).works[reserved.work.id];return launchReply(w,false)
  }
  async function result(root,child,input) {
    const recorded=await queue(()=>change(root,s=>{
      const w=Object.values(s.works).find(w=>w.childId===child);if(!w||w.status!=='running'||input.intent_version!==w.intentVersion)throw Error('Current owned work result required')
      const text=clean(input.text,12000),old=w.results.find(r=>r.id===input.result_id)
      if(old){if(old.text!==text)throw Error('Result identity reused');if(old.phase!==input.phase)throw Error('Result identity reused with changed phase');return{recorded:true,duplicate:true,workId:w.id}}
      if(w.results.length>=12)throw Error('Bounded result allowance exhausted')
      const r={id:clean(input.result_id,100),version:w.intentVersion,text,phase:input.phase==='final'?'final':'progress',status:input.phase==='progress'?'ready':'recorded',at:clock.now()};w.results.push(r);return{recorded:true,published:false,workId:w.id}
    }))
    if(input.phase==='progress')track(wakeResult(root,recorded.workId,`progress:${input.result_id}`))
    return recorded
  }
  async function send(root,input) {
    if(input.direct_result_id||input.work_id){
      const captured=await queue(async()=>{const s=await state(root);if(s.messages.some(m=>m.role==='assistant'&&m.idempotencyKey===input.idempotency_key))return{duplicate:true};if(input.input_version!==s.inputVersion)throw Error('Input changed before result delivery');const direct=input.direct_result_id?s.directResults?.[input.direct_result_id]:null,w=input.work_id?s.works[input.work_id]:null,b=s.batches[direct?.batchId||w?.batchId];if(!b)throw Error('Exact research result required');return{quotes:[...b.messageIds,...(b.revalidation?.supplementMessageIds||[])].map(id=>s.messages.find(m=>m.id===id)?.quote).filter(Boolean),direct:direct?structuredClone(direct):null}})
      if(!captured.duplicate){if(captured.direct){if(!adapter.directEvidence||!Array.isArray(captured.direct.evidence)||!captured.direct.evidence.length)throw Error('Recorded native execution unavailable');const proof=await adapter.directEvidence(root,captured.direct.evidence.map(e=>e.callId),-1);if(JSON.stringify(proof)!==JSON.stringify(captured.direct.evidence))throw Error('Recorded native execution changed before delivery')}for(const quote of captured.quotes)await adapter.currentQuote(root,quote)}
    }
    return queue(()=>change(root,s=>{
      if(!s.enabled)throw Error('IM conversation not enabled')
      const text=clean(input.text,12000),key=clean(input.idempotency_key,100)
      const old=s.messages.find(m=>m.role==='assistant'&&m.idempotencyKey===key)
      if(old){if(old.text!==text||old.workId!==(input.work_id||undefined)||old.resultId!==(input.result_id||undefined)||old.replyTo!==input.reply_to||old.directResultId!==(input.direct_result_id||undefined))throw Error('Outbox identity reused with changed payload');return{accepted:true,messageId:old.id,duplicate:true}}
      if(input.input_version!==s.inputVersion)throw Error('Input changed; reconcile IM context before sending')
      const reply=s.messages.find(m=>m.id===input.reply_to&&m.role==='user');if(!reply)throw Error('Exact conversation reply required')
      if(input.work_id){
        const w=s.works[input.work_id],r=w?.results.find(r=>r.id===input.result_id)
        if(!w||!r||r.version!==w.intentVersion||input.intent_version!==w.intentVersion||['pausing','paused','cancelling','cancelled','revising','uncertain'].includes(w.status))throw Error('Work result not ready/current')
        // Delivery identity belongs to work + revision + phase, never the model's key.
        const deliveredFinal=s.messages.find(m=>m.workId===w.id&&m.intentVersion===w.intentVersion&&w.results.some(result=>result.id===m.resultId&&result.version===w.intentVersion&&result.phase==='final'))
        if(r.phase==='final'&&deliveredFinal)return{accepted:true,messageId:deliveredFinal.id,duplicate:true}
        if(r.messageId&&r.status==='sent')return{accepted:true,messageId:r.messageId,duplicate:true}
        if(r.status!=='ready')throw Error('Work result not ready/current')
        if(r.phase==='progress'&&w.results.some(result=>result.version===w.intentVersion&&result.phase==='final'))throw Error('Progress superseded by current final; deliver exact final result')
      }
      if(input.direct_result_id){const r=s.directResults?.[input.direct_result_id];if(input.work_id||!r||r.batchId!==reply.batchId||r.inputVersion!==s.inputVersion||r.status!=='ready'||r.text!==text||s.commitments[reply.batchId].status!=='awaiting_reply')throw Error('Exact current direct result required')}
      const m={id:randomUUID(),seq:++s.seq,role:'assistant',text,at:clock.now(),status:'accepted',idempotencyKey:key,replyTo:reply.id,purpose:input.purpose||'communication',...(input.direct_result_id?{directResultId:input.direct_result_id}:{}),...(input.run?{run:input.run}:{}),...(input.work_id?{workId:input.work_id,resultId:input.result_id,intentVersion:input.intent_version}:{})};s.messages.push(m)
      if(m.directResultId){s.directResults[m.directResultId].status='sent';s.directResults[m.directResultId].messageId=m.id;s.commitments[reply.batchId].status='delivered'}else if(m.workId){const w=s.works[m.workId],r=w.results.find(r=>r.id===m.resultId);r.messageId=m.id;r.status='sent';if(r.phase==='final')s.commitments[w.batchId].status='delivered'}else if(reply.batchId&&input.purpose==='answer'&&s.commitments[reply.batchId].expected==='answer'&&s.commitments[reply.batchId].declaration?.intent==='answer'&&!s.commitments[reply.batchId].workId)s.commitments[reply.batchId].status='delivered'
      return{accepted:true,messageId:m.id,seq:m.seq,duplicate:false}
    }))
  }
  async function observe(root,workId,outcome) {
    if(['running','unknown'].includes(outcome.state))return
    const existing=states.get(root)?.works[workId];if(existing&&(terminal.has(existing.status)||existing.status==='paused'))return
    const job=await queue(()=>change(root,s=>{
      const w=s.works[workId];if(!w||terminal.has(w.status)||w.status==='paused')return null
      if(outcome.state==='running'||outcome.state==='unknown')return null
      w.terminal=outcome.terminal
      if(outcome.terminal?.synthetic){w.recoveryDispositions||=[];w.recoveryDispositions.push({at:clock.now(),kind:outcome.terminal.reason.kind,evidence:outcome.terminal.evidence})}
      if(w.status==='revising'&&!outcome.terminal?.synthetic){const c=w.controls.at(-1);return{resume:true,work:structuredClone(w),control:c}}
      if(w.status==='pausing'||w.status==='cancelling'){w.status=w.status==='pausing'?'paused':'cancelled';s.commitments[w.batchId].status=w.status==='paused'?'paused':'cancelled';return{notice:true,work:structuredClone(w)}}
      w.status=outcome.state==='completed'&&w.results.some(r=>r.version===w.intentVersion&&r.phase==='final')?'completed':'failed'
      if(outcome.state==='completed'&&w.status==='failed')w.error='Worker ended without a current final result; responsibility remains blocked'
      for(const r of w.results)if(r.version===w.intentVersion&&w.status==='completed'&&r.status==='recorded')r.status='ready'
      if(w.status==='failed'||!w.results.some(r=>r.phase==='final'&&r.status==='ready'))s.commitments[w.batchId].status=w.status==='failed'?'blocked':'awaiting_delivery'
      return{notice:true,work:structuredClone(w)}
    }))
    if(job?.resume){
      await queue(()=>change(root,s=>{const w=s.works[workId];w.status='running';w.execution={generation:(w.execution?.generation||1)+1,controlId:job.control.id,intentVersion:job.control.version,afterSeq:outcome.terminal.seq};w.controls.find(c=>c.id===job.control.id).status='dispatching'}))
      try{const receipt=await adapter.steer(root,job.work,job.control);await queue(()=>change(root,s=>{const c=s.works[workId].controls.find(c=>c.id===job.control.id);c.status='accepted';c.receipt=receipt;s.works[workId].execution.messageId=receipt}))}
      catch(e){await queue(()=>change(root,s=>{s.works[workId].status='uncertain';s.works[workId].error=e.message}))}
    }else if(job?.notice)track(wakeResult(root,workId))
  }
  async function wakeResult(root,workId,key='terminal') {
    const job=await queue(()=>change(root,s=>{const w=s.works[workId];w.notifications||={};if(w.notifications[key])return null;w.notifications[key]={requestId:randomUUID(),status:'dispatching'};return{requestId:w.notifications[key].requestId,packet:{protocol:imProtocol,kind:'work_result',workId,intentVersion:w.intentVersion,status:w.status}}}));if(!job)return
    try{await adapter.mainPrompt(root,job.requestId,job.packet);await queue(()=>change(root,s=>{s.works[workId].notifications[key].status='accepted'}))}catch(e){await queue(()=>change(root,s=>{s.works[workId].notifications[key].status='uncertain';s.works[workId].notifications[key].error=e.message}))}
  }
  async function recover(root) {
    await queue(()=>state(root));await adapter.enable(root)
    const s=await snapshot(root)
    for(const b of Object.values(s.batches).filter(b=>['dispatching','uncertain'].includes(b.status))){const receipt=await adapter.mainReceipt(root,b.requestId);await queue(()=>change(root,s=>{s.batches[b.id].status=receipt?'accepted':'uncertain'}))}
    for(const w of Object.values(s.works)){
      const outcome=await adapter.inspect(root,w)
      if(['provisioning','uncertain'].includes(w.status)&&outcome.state==='running')await queue(()=>change(root,s=>{s.works[w.id].status='running'}))
      if(active(w))await observe(root,w.id,outcome)
      for(const [key,note] of Object.entries(w.notifications||{})){if(['dispatching','uncertain'].includes(note.status)){const receipt=await adapter.mainReceipt(root,note.requestId);if(receipt)await queue(()=>change(root,s=>{s.works[w.id].notifications[key].status='accepted'}))}}
      if(terminal.has(w.status)&&!w.notifications?.terminal)track(wakeResult(root,w.id))
    }
    arm(root)
  }
  async function control(root,input) {
    const admitted=await queue(()=>change(root,s=>{
      const w=s.works[input.work_id],m=s.messages.find(m=>m.id===input.message_id&&m.role==='user')
      if(!w||!m||terminal.has(w.status)||!['supplement','pause','cancel'].includes(input.action))throw Error('Exact active work and original IM input required')
      const old=w.controls.find(c=>c.messageId===m.id)
      if(old){if((old.requestedAction||({revise:'supplement',steer:'supplement'}[old.kind]||old.kind))!==input.action)throw Error('Control identity reused with changed action');return{duplicate:true,workId:w.id,status:w.status}}
      if(!Number.isInteger(input.input_version)||input.input_version!==s.inputVersion||m.seq!==Math.max(...s.messages.filter(m=>m.role==='user').map(m=>m.seq)))throw Error('Input changed before work control; read latest context')
      if(m.seq<(w.lastControlSeq||0))throw Error('Newer work instruction already admitted')
      const authorizedThrough=Math.max(...s.batches[w.batchId].messageIds.map(id=>s.messages.find(m=>m.id===id).seq))
      if(m.seq<=authorizedThrough)throw Error('Work control requires a later original human message')
      w.intentVersion++;w.lastControlSeq=m.seq;m.workId=w.id;m.kind='control';w.constraints.push({messageId:m.id,text:m.text,version:w.intentVersion})
      const kind=input.action==='supplement'?'revise':input.action
      const c={id:randomUUID(),messageId:m.id,version:w.intentVersion,kind,requestedAction:input.action,inputVersion:s.inputVersion,text:m.text,status:'pending'};w.controls.push(c)
      if(kind!=='steer'){w.status=kind==='revise'?'revising':kind==='pause'?'pausing':'cancelling';w.stopReason=kind}
      return{workId:w.id,control:c,status:w.status}
    }))
    if(admitted.control)await deliverControl(root,admitted)
    return{accepted:true,workId:admitted.workId,status:admitted.status,duplicate:!!admitted.duplicate,terminalConfirmed:false}
  }
  async function discoveryResult(root,p) {
    return queue(()=>change(root,s=>{
      if(!s.enabled)throw Error('Muse chat is not enabled')
      if(!p.runId || !['completed','no_change','failed','blocked'].includes(p.status))throw Error('Terminal discovery required')
      const key='discovery:'+p.runId,old=s.messages.find(m=>m.idempotencyKey===key)
      if(old)return{published:true,duplicate:true,messageId:old.id}
      const text=p.status==='completed'?'新点子已生成，可以到「点子」页查看。':p.status==='no_change'?'这次没有找到值得新增的点子。可以补充一个想推进的方向，再试一次。':'这次点子没有生成成功。你可以点击「发现」重试。'
      const m={id:randomUUID(),seq:++s.seq,role:'assistant',text,at:clock.now(),status:'accepted',kind:'discovery_result',purpose:'communication',idempotencyKey:key}
      s.messages.push(m);return{published:true,messageId:m.id}
    }))
  }
  async function linkedResult(root,p) {
    return queue(()=>change(root,s=>{
      if(!s.enabled)throw Error('Muse chat is not enabled')
      if(typeof p.key!=='string'||!p.key||typeof p.text!=='string'||!p.text.trim()||p.text.length>25000)throw Error('Invalid linked result')
      const key='linked:'+p.key,old=s.messages.find(m=>m.idempotencyKey===key)
      if(old)return{published:true,duplicate:true,messageId:old.id}
      const m={id:randomUUID(),seq:++s.seq,role:'assistant',text:(p.outcome==='failed'?'这项工作未完整完成，执行会话返回：\n\n':'执行会话返回：\n\n')+p.text,at:clock.now(),status:'accepted',kind:'linked_result',purpose:'communication',idempotencyKey:key,linkedSessionId:p.targetSessionId,linkedWorkId:p.workId}
      s.messages.push(m);return{published:true,messageId:m.id}
    }))
  }
  async function nativeTerminal(root,outcome) {
    return queue(()=>change(root,s=>{
      if(!s.enabled||!Number.isInteger(outcome.endSeq)||outcome.endSeq<=(s.nativeTerminalThroughSeq??-1))return{duplicate:true};
      const batches=Object.values(s.batches).filter(b=>outcome.requestIds.includes(b.requestId)&&['dispatching','accepted','uncertain'].includes(b.status));
      const targets=batches.flatMap(b=>b.messageIds.map(id=>s.messages.find(m=>m.id===id&&m.role==='user'))).filter(Boolean).sort((a,b)=>a.seq-b.seq);const reply=targets.at(-1);if(!reply)return{ignored:true};
      s.nativeTerminalThroughSeq=outcome.endSeq;s.nativeReplies||={};const key=`native:${root}:${outcome.turn}:${outcome.endSeq}`;
      const already=s.messages.find(m=>m.role==='assistant'&&m.run?.turn===outcome.turn&&(m.replyTo===reply.id||s.messages.find(h=>h.id===m.replyTo)?.batchId===reply.batchId)&&(m.purpose==='answer'||m.directResultId||m.workId&&s.works[m.workId]?.results.some(r=>r.id===m.resultId&&r.phase==='final')||outcome.text&&m.text===outcome.text));if(already){s.nativeReplies[key]={status:'explicit_delivery',messageId:already.id};return{duplicate:true,messageId:already.id}}
      const w=Object.values(s.works).find(w=>w.batchId===reply.batchId),started=w?.launchStatus==='accepted'&&typeof w.execution?.messageId==='string'&&['running','completed'].includes(w.status);
      const answer=outcome.reason==='completed'&&typeof outcome.text==='string'&&Boolean(outcome.text.trim());
      const text=answer?outcome.text:outcome.reason!=='completed'?'这次回复中断了，尚未得到完整回答。':started?(w.status==='completed'?'后台工作已完成，结果尚未交付到聊天。':'后台工作已开始，结果尚未交付到聊天。'):'这次没有收到完整可显示的回答；未把工具输出或未完成内容当作回复。';
      const m={id:randomUUID(),seq:++s.seq,role:'assistant',text,at:clock.now(),status:'accepted',kind:answer?'native_reply':'delivery_notice',purpose:answer?'communication':'status',idempotencyKey:key,replyTo:reply.id,run:{sessionId:root,turn:outcome.turn,terminalSeq:outcome.endSeq,assistantSeq:outcome.assistantSeq},delivery:{source:'native-terminal',terminalReason:outcome.reason,answerComplete:!!answer,humanMessageIds:targets.map(m=>m.id),batchIds:batches.map(b=>b.id)}};s.messages.push(m);
      s.nativeReplies[key]={status:answer?'delivered':'no_complete_answer',messageId:m.id};while(Object.keys(s.nativeReplies).length>100)delete s.nativeReplies[Object.keys(s.nativeReplies)[0]];
      for(const b of batches){b.replyTerminal={turn:outcome.turn,endSeq:outcome.endSeq,status:answer?'delivered':'no_complete_answer'};const c=s.commitments[b.id];if(answer&&c&&!c.workId&&c.expected!=='research'){c.status='delivered';c.deliveryBasis='native-terminal-answer'}else if(c&&c.status==='awaiting_reply'&&!answer&&!c.workId)c.replyError='No complete native answer'}
      return{messageId:m.id,published:true,answerComplete:!!answer}
    }))
  }
  return{
    receive,discoveryResult,linkedResult,nativeTerminal,reconcilePending,declareIntent,directResult,startWork,result,send,observe,recover,control,
    async prepareLegacyArchive(root,cutoff,token){return queue(()=>change(root,s=>{if(s.messages.length||Object.keys(s.works).length||!Number.isInteger(cutoff)||cutoff<0)throw Error('Empty IM journal and exact archive cutoff required');s.enabled=true;s.legacyArchivedThroughSeq=cutoff;s.legacyCutoffSeq=cutoff;s.legacyVisibleSeqs=[];s.legacyArchiveToken=token}))},
    async confirmHandoff(root,cutoff,visibleSeqs){return queue(()=>change(root,s=>{if(!s.enabled||!Number.isInteger(cutoff))throw Error('Enabled IM with exact native cutoff required');s.legacyCutoffSeq=Math.max(s.legacyCutoffSeq,cutoff);if(visibleSeqs)s.legacyVisibleSeqs=[...new Set(visibleSeqs)].sort((a,b)=>a-b);s.handoffConfirmed=true}))},
    async context(root,input={}){await tail;const s=await snapshot(root);const domain=await adapter.goalContext?.(root);if(domain){s.goals=domain.goals;s.goalRevision=domain.revision}return readImContext(s,input)},
    async read(root){await tail;return snapshot(root)},
    peek:root=>states.get(root),
    async typing(input){if(typeof input.active!=='boolean'||Object.keys(input).some(k=>!['rootSessionId','active'].includes(k)))throw Error('Typing accepts state only');await queue(()=>state(input.rootSessionId));typing.set(input.rootSessionId,{active:input.active,at:clock.now()});arm(input.rootSessionId);return{accepted:true}},
    async ack(root,cursor){return queue(()=>change(root,s=>{if(!Number.isInteger(cursor)||cursor<0||cursor>s.seq)throw Error('Invalid display cursor');s.displayCursor=Math.max(s.displayCursor||0,cursor)}))},
    async checkTool(root,child,version,name,args,trace={}){return queue(()=>change(root,s=>{const w=Object.values(s.works).find(w=>w.childId===child);if(!w||w.status!=='running'||w.intentVersion!==version)throw Error('Work paused/cancelled or intent changed before dispatch');if(!['web_search','web_fetch','muse_im_work_result'].includes(name))throw Error('Read-only research tool boundary');if(name!=='muse_im_work_result'){if(w.toolCalls>=w.maxToolCalls)throw Error('Research tool allowance exhausted');if(w.constraints.some(c=>/官方|\bofficial\b/iu.test(c.text))&&!adapter.official(name,args))throw Error('Official-source constraint requires scoped actual tool arguments');w.toolCalls++;w.lastAction={version,name,args:structuredClone(args),...trace};w.actions||=[];w.actions.push(w.lastAction)}return true}))},
    async flush(){await tail;await Promise.allSettled([...ops]);await tail},
    async dispose(){dead=true;for(const t of timers.values())clock.clearTimeout(t);await tail;await journal.close?.()}
  }
}
