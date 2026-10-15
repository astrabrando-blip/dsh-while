import {createHash} from 'node:crypto'
/** Terminal public root events only: never reasoning, tool output or a live delta. */
export function nativeReply(events,end,state){
 if(end?.type!=='turn/end'||!Number.isInteger(end.seq)||!Number.isInteger(end.data?.turn))return null;
 const turn=end.data.turn,start=events.filter(e=>e.type==='turn/start'&&e.data?.turn===turn&&e.seq<end.seq).at(-1);if(!start)return null;
 const previousEnd=events.filter(e=>e.type==='turn/end'&&e.seq<start.seq).at(-1)?.seq??-1;
 const receipts=new Map(Object.values(state.batches||{}).filter(b=>b.requestId).map(b=>[b.requestId,b.id])),requestIds=[];
 for(const e of events.filter(e=>e.type==='user/message'&&e.seq>previousEnd&&e.seq<end.seq)){const m=e.data,request=m?.source?.rpcId;if(!receipts.has(request))continue;for(const block of m.content||[]){if(block.type!=='text')continue;try{const p=JSON.parse(block.text);if(p.protocol==='muse-im/1'&&p.kind==='input_batch'&&p.batchId===receipts.get(request))requestIds.push(request)}catch{}}}
 if(!requestIds.length)return null;
 const last=events.filter(e=>e.type==='assistant/message'&&e.data?.turn===turn&&e.seq>start.seq&&e.seq<end.seq).at(-1),blocks=last?.data?.message?.content||[];
 const text=end.data.reason?.kind==='completed'&&!blocks.some(b=>b.type==='tool-call')?blocks.filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text).join('').trim():'';
 return{turn,endSeq:end.seq,reason:end.data.reason?.kind||'unknown',requestIds:[...new Set(requestIds)],text:text.length<=32000?text:'',assistantSeq:last?.seq??null,textUnavailable:text.length>32000?'too_long':null};
}
export const nativeReplyRevision=createHash('sha256').update(nativeReply.toString()).digest('hex')
