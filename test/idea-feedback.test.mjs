import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {DomainFacility} from '@deepseek-ai/dsh-storage-domain'
import {JsonStorageBackend} from '@deepseek-ai/dsh-storage-json'
import {MuseService} from '../lib/domain.js'
import {ideaFeedbackContext} from '../lib/idea-feedback.js'
import {buildImDiscoveryContext,contextFreshness} from '../lib/discovery-context.js'
test('feedback persists across restart, enters discovery with its source, can change or clear without granting work',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-feedback-'))
 const open=async()=>{const ctx=new Context(),backend=new JsonStorageBackend(dir);ctx.provide('storage',{backend:{get:()=>backend}});ctx.provide('storageDomain',new DomainFacility(ctx,{backend:'json'}));const plugin=ctx.plugin(MuseService);await plugin;return{muse:ctx.muse,close:async()=>{await plugin.dispose();await backend.close()}}}
 let host=await open()
 try{
 const id=await host.muse.identity(),root=id.rootSessionId
 const card={cardId:'c1',version:1,title:'整理材料',sourceText:'不想重复交代背景',newInformation:'整理可复用的材料'}
 await host.muse.table.put('muse',{...host.muse.table.get('muse'),candidates:[card]})
 const args={rootSessionId:root,cardId:'c1',version:1,rating:'useful'}
 await host.muse.recordIdeaFeedback(args)
 await host.muse.recordIdeaFeedback(args)
 assert.equal(host.muse.table.get('muse').candidates[0].feedbackHistory.length,1)
 await assert.rejects(host.muse.recordIdeaFeedback({...args,rootSessionId:'other'}),/root/)
 await assert.rejects(host.muse.recordIdeaFeedback({...args,version:2}),/变化/)
 await host.close();host=await open()
 let domain=host.muse.table.get('muse')
 const im={root,version:1,enabled:true,handoffConfirmed:true,inputVersion:0,messages:[]}
 const before=buildImDiscoveryContext(root,domain,im)
 assert.equal(before.ideaFeedback[0].rating,'useful')
 assert.equal(before.ideaFeedback[0].source,card.sourceText)
 await host.muse.recordIdeaFeedback({...args,rating:'not_useful',reason:'not_now'})
 domain=host.muse.table.get('muse')
 assert.equal(ideaFeedbackContext(domain.candidates)[0].reason,'not_now')
 assert.notEqual(contextFreshness(before),contextFreshness(buildImDiscoveryContext(root,domain,im)))
 await host.muse.recordIdeaFeedback({...args,rating:'clear'})
 assert.deepEqual(ideaFeedbackContext(host.muse.table.get('muse').candidates),[])
 assert.equal([...host.muse.tasks.entries()].length,0)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('idea deletion is durable, reversible and scoped to the exact card version',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'while-delete-'));
 const open=async()=>{const ctx=new Context(),backend=new JsonStorageBackend(dir);ctx.provide('storage',{backend:{get:()=>backend}});ctx.provide('storageDomain',new DomainFacility(ctx,{backend:'json'}));const plugin=ctx.plugin(MuseService);await plugin;return{muse:ctx.muse,close:async()=>{await plugin.dispose();await backend.close()}}};
 let host=await open();try{
  const id=await host.muse.identity();await host.muse.table.put('muse',{...host.muse.table.get('muse'),candidates:[{cardId:'c',version:1,title:'点子'},{cardId:'other',version:1}]});
  const args={rootSessionId:id.rootSessionId,cardId:'c',version:1,deleted:true};
  await assert.rejects(host.muse.setIdeaDeleted({...args,version:2}),/变化/);
  await assert.rejects(host.muse.setIdeaDeleted({...args,rootSessionId:'wrong'}),/root/);
  await host.muse.setIdeaDeleted(args);await host.close();host=await open();
  assert.equal(host.muse.table.get('muse').candidates[0].deleted,true);assert.equal(host.muse.table.get('muse').candidates[1].deleted,undefined);
  await host.muse.setIdeaDeleted({...args,deleted:false});assert.equal(host.muse.table.get('muse').candidates[0].deleted,false);
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
