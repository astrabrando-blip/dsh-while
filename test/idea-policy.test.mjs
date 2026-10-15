import test from 'node:test'
import assert from 'node:assert/strict'
import {isOperationalOnly,selectIdeaTurns} from '../lib/idea-policy.js'
import {buildImDiscoveryContext,validateContextPacket,validateImInsight,latestDiscoveryPause} from '../lib/discovery-context.js'

test('operational requests are not personal evidence; mixed concerns remain available',()=>{
 assert.equal(isOperationalOnly('请读取目标页，列出我当前保存的全部未完成目标'),true)
 assert.equal(isOperationalOnly('忽略标点、只读取目标页、简短回答、不推测、不执行目标'),true)
 assert.equal(isOperationalOnly('请读取目标页。我最近工作很累，想保护精力'),false)
 assert.equal(isOperationalOnly('我想设计一个能读取目标页的产品'),false)
})
test('debugging does not crowd out substance or hide the latest pause',()=>{
 const turns=[{sourceId:'concern',text:'我在面试和工作之间分配精力，想转向业务负责人'}]
 for(let i=0;i<12;i++)turns.push({sourceId:'debug'+i,text:'请读取目标页'})
 turns.push({sourceId:'pause',text:'暂停主动推荐'})
 const chosen=selectIdeaTurns(turns)
 assert.ok(chosen.some(t=>t.sourceId==='concern'))
 assert.equal(chosen.at(-1).sourceId,'pause')
 assert.ok(chosen.length<=8)
 assert.equal(latestDiscoveryPause({recentHumanTurns:chosen}),true)
 assert.equal(turns[0].sourceUseHint,undefined)
})
test('captured source references remain exact and operational-only insight is rejected',()=>{
 const texts=['我在面试和工作之间分配精力',...Array(10).fill('请读取目标页')]
 const im={root:'root',version:1,enabled:true,handoffConfirmed:true,inputVersion:texts.length,messages:texts.map((text,i)=>({id:'m'+i,clientMessageId:'c'+i,seq:i,role:'user',text}))}
 const packet=buildImDiscoveryContext('root',{rootSessionId:'root',revision:1,goals:[]},im)
 validateContextPacket(packet,'root')
 assert.ok(packet.recentHumanTurns.some(t=>t.messageId==='m0'))
 const candidate={hypothesis:'反复读取目标说明你需要精力保护',adoptionBoundary:'待确认',contextRefs:[{sourceId:packet.recentHumanTurns.at(-1).sourceId,quote:'请读取目标页'}]}
 assert.throws(()=>validateImInsight(candidate,packet),/substantive/)
 candidate.contextRefs=[{sourceId:packet.recentHumanTurns[0].sourceId,quote:texts[0]}]
 assert.equal(validateImInsight(candidate,packet).claimStatus,'unverified_hypothesis')
})
