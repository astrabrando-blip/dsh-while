import test from 'node:test'
import assert from 'node:assert/strict'
import {parsePluginDirectory,createIdeaPluginPool,resolvePluginOptions} from '../lib/idea-plugins.js'

test('catalog recalls different categories and deduplicates actual repositories',()=>{
 const rows=parsePluginDirectory('### Files\n- [Docs](https://github.com/a/docs) - document editing\n### Memory\n- [Memo](https://github.com/a/memo) - recall\n- [Memo](https://github.com/a/memo) - duplicate')
 assert.equal(rows.length,2)
 assert.equal(rows[0].name,'Docs')
})
test('fixed public pool requests, fallback and cache work without sending private context',async()=>{
 const urls=[]
 const read=createIdeaPluginPool(async url=>{urls.push(url);if(url.includes('api.deepseek1024'))throw Error('offline');return new Response('- [Docs](https://github.com/a/docs) - document editing')})
 const first=await read();assert.equal(first.status,'available');assert.equal(first.plugins.length,1)
 assert.equal((await read()).plugins[0].url,'https://github.com/a/docs');assert.equal(urls.length,3)
 assert.ok(urls.every(url=>url.includes('q=memory')||url.includes('q=workflow')||url.endsWith('/README.md')))
})
test('existing entries are host resolved; ideas remain available without catalog',async()=>{
 const pool={plugins:[{id:'plugin-0',name:'Docs',url:'https://github.com/a/docs',source:'directory'}]}
 const options=resolvePluginOptions([{kind:'existing',pluginId:'plugin-0',name:'invented',reason:'整理材料'},{kind:'proposal',name:'面试案例整理',reason:'输入项目笔记，输出可检索的面试案例'}],pool)
 assert.equal(options[0].name,'Docs');assert.equal(options[1].url,undefined)
 assert.throws(()=>resolvePluginOptions([{kind:'existing',pluginId:'fake',reason:'x'}],pool),/supplied pool/)
 const unavailable=await createIdeaPluginPool(async()=>{throw Error('offline')})()
 assert.equal(unavailable.status,'unavailable')
 assert.equal(resolvePluginOptions([{kind:'proposal',name:'记录助手',reason:'从笔记整理案例'}],unavailable).length,1)
})
