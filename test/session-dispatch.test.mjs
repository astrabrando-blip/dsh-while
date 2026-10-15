import test from 'node:test'
import assert from 'node:assert/strict'
import {sessionFrontier,sessionRequestId,registerSessionDispatch} from '../lib/session-dispatch.js'
import {createImController} from '../lib/im-controller.js'
test('dispatch requires latest human input and stable identities',()=>{
 const s={enabled:true,inputVersion:2,messages:[{id:'m',role:'user'}]}
 assert.equal(sessionFrontier(s,{input_version:2,message_id:'m'}).id,'m')
 for(const i of [{input_version:1,message_id:'m'},{input_version:2,message_id:'fake'}])assert.throws(()=>sessionFrontier(s,i),/更新/)
 assert.throws(()=>sessionFrontier({...s,hold:true},{input_version:2,message_id:'m'}),/更新/)
 assert.equal(sessionRequestId('r','m','task'),sessionRequestId('r','m','task'));assert.notEqual(sessionRequestId('r','m','task'),sessionRequestId('r','m2','task'))
})
test('tools route new, selected and supplement through exact saved relations',async()=>{
 const tools={},calls=[],state={enabled:true,inputVersion:1,messages:[{id:'m',role:'user'}]}
 const linked=Object.fromEntries(['create','link','supplement','stop','metadata','poll'].map(k=>[k,async input=>{calls.push({k,input});return{accepted:true}}]))
 registerSessionDispatch((name,_d,_p,_r,fn)=>tools[name]=fn,{muse:{linkedController:linked}},'root',{peek:()=>state})
 const args={message_id:'m',input_version:1,task_key:'a',text:'task'}
 await tools.muse_dispatch_session(args);await tools.muse_dispatch_session({...args,target_session_id:'s'});await tools.muse_dispatch_session({...args,work_id:'w'})
 assert.deepEqual(calls.map(c=>c.k),['create','link','supplement']);assert.equal(calls[1].input.targetSessionId,'s');assert.equal(calls[2].input.workId,'w')
 state.inputVersion++;assert.throws(()=>calls[0].input.assertCurrent(),/更新/)
})
test('linked final is visible IM data once across reload without a new human batch',async()=>{
 let saved={version:1,root:'r',revision:0,seq:0,inputVersion:0,enabled:true,messages:[],works:{},batches:{},commitments:{}}
 const journal={load:async()=>structuredClone(saved),save:async s=>{saved=structuredClone(s)}}
 let c=createImController({journal,adapter:{}})
 const p={key:'exact-turn',text:'Created and verified output',targetSessionId:'s',workId:'w',outcome:'completed'}
 await c.linkedResult('r',p);await c.dispose();c=createImController({journal,adapter:{}});await c.linkedResult('r',p)
 const s=await c.read('r');assert.equal(s.messages.length,1);assert.equal(s.messages[0].kind,'linked_result');assert.match(s.messages[0].text,/Created and verified/);await c.dispose()
})
test('session listing receipts without results remain JSON-safe',async()=>{
 const registered=new Map()
 registerSessionDispatch((name,_d,_p,_r,run)=>registered.set(name,run),{muse:{linkedController:{metadata:async()=>[],poll:async()=>[{id:'work',targetSessionId:'session',deliveries:[{requestId:'request',status:'accepted',text:'task'}]}],capabilities:()=>({list:true})}}},'root',{})
 const result=await registered.get('muse_sessions')({})
 assert.deepEqual(result,JSON.parse(JSON.stringify(result)))
 assert.deepEqual(result.works[0].deliveries[0].results,[])
})
