import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
const source=await readFile(new URL('../lib/client.js',import.meta.url),'utf8')
let factory
vm.runInNewContext(source,{window:{__ModuleLoader__:{load:x=>factory=x.factory}}})
const react={createElement:(type,props,...children)=>({type,props,children}),useState:v=>[v,()=>{}]}
const ui=factory(name=>name==='react'?react:{}).__test
const nodes=x=>!x?[]:Array.isArray(x)?x.flatMap(nodes):typeof x==='object'?[x,...nodes(x.children)]:[]
const text=x=>JSON.stringify(x)
test('missing credentials guide users to model settings and keep technical details',()=>{
 const t=ui.ReplyError({error:'no API key for provider route deepseek-official',rows:[{type:'assistant',interrupted:true}]})
 assert.match(text(t),/设置 → 模型/);assert.match(text(t),/no API key/)
})
test('historical error is hidden during a new user turn and restored for a new failure',()=>{
 const error='no API key'
 assert.equal(ui.ReplyError({error,rows:[{type:'assistant',interrupted:true},{type:'user'}]}),null)
 assert.equal(ui.ReplyError({error,rows:[{type:'assistant-live'}]}),null)
 assert.equal(ui.ReplyError({error,rows:[{type:'assistant',text:'已完成'}]}),null)
 assert.ok(ui.ReplyError({error,rows:[{type:'user'},{type:'assistant',text:'这次回复中断了，尚未得到完整回答。'}]}))
})
test('linked code output is collapsed without discarding body, ordinary replies unchanged',()=>{
 const body='任务结果：\n\n```text\ncommand output\n```\n\n文件：/tmp/result.md'
 const tree=ui.AssistantMessage({row:{type:'assistant',kind:'linked_result',text:body}})
 const detail=nodes(tree).find(n=>n.type==='details');assert.ok(detail);assert.ok(!detail.props.open)
 assert.match(text(detail),/command output/);assert.match(text(tree),/result.md/)
 assert.equal(nodes(ui.AssistantMessage({row:{type:'assistant',text:body}})).filter(n=>n.type==='details').length,0)
})
