import {validateContextPacket,contextReferences} from './discovery-context.js'
/** Read-only projection. Model prose is never promoted to a human quotation. */
export function sourceAttribution(card, packet, root) {
 const base={revision:1,rootSessionId:root,cardId:card.cardId,version:card.version,label:'Muse的推测',confirmation:'推测尚未得到你的确认',humanQuotes:[],sources:[]}
 if(!card.contextEvidence)return {...base,state:'legacy_unverified',notice:'没有核实的人类引文'}
 if(card.contextEvidence.rootSessionId!==root)throw Error('Attribution root mismatch')
 validateContextPacket(packet,root)
 if(packet.contextHash!==card.contextEvidence.contextHash)throw Error('Attribution snapshot mismatch')
 const records=[...packet.recentHumanTurns,...packet.activeGoals,...packet.pendingQuestions]
 for(const ref of card.contextEvidence.refs){
  const verified=contextReferences([{sourceId:ref.sourceId,quote:ref.quote}],packet)[0]
  for(const key of ['kind','messageId','seq','version','textHash','fullTextHash','anchorId','taskId','questionId','senderSessionId','sourceMessageId'])if(verified[key]!==ref[key])throw Error('Attribution evidence identity mismatch')
  const record=records.find(r=>r.sourceId===ref.sourceId),index=record.text.indexOf(ref.quote)
  // Extract from the host-owned snapshot, rather than returning model wording.
  const excerpt=record.text.slice(index,index+ref.quote.length)
  const value={sourceId:ref.sourceId,version:ref.version,excerpt,snapshotTruncated:record.truncated===true,...(ref.kind==='human'?{messageId:ref.messageId,seq:ref.seq}:{kind:ref.kind})}
  if(ref.kind==='human')base.humanQuotes.push(value);else base.sources.push(value)
 }
 return {...base,state:'current',notice:base.humanQuotes.length?null:'没有核实的人类引文'}
}
