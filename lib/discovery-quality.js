import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const keys = (value, allowed) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Invalid calculation structure') }
const gcd = (a,b) => { a=a<0n?-a:a;b=b<0n?-b:b;while(b){[a,b]=[b,a%b]}return a }
const rational = (n,d=1n) => { if(!d)throw new Error('Division by zero');if(d<0n){n=-n;d=-d}const g=gcd(n,d);n/=g;d/=g;if(n.toString().length>256||d.toString().length>256)throw new Error('Calculation exceeds bounded precision');return {n,d} }
const decimal = text => { if(typeof text!=='string'||!/^[-+]?\d{1,30}(?:\.\d{1,30})?$/.test(text))throw new Error('Exact finite decimal required');const sign=text[0]==='-'?-1n:1n;const [whole,part='']=text.replace(/^[-+]/,'').split('.');return rational(sign*BigInt(whole+part),10n**BigInt(part.length)) }
const exact = value => value.d===1n?String(value.n):`${value.n}/${value.d}`
const claimed = text => { if(typeof text==='string'&&/^[-+]?\d{1,256}\/\d{1,256}$/.test(text)){const [n,d]=text.split('/');return rational(BigInt(n),BigInt(d))}return decimal(text) }
export const discoveryFocus = run => run.sources.find(source=>source.anchorId===run.focusAnchorId)||run.sources.at(-1)
function reference(ref,sources){
 keys(ref,['anchorId','version','quote'])
 const source=sources.find(source=>source.anchorId===ref.anchorId&&source.version===ref.version)
 if(!source||typeof ref.quote!=='string'||!ref.quote.trim()||ref.quote.length>400||!source.sourceText.includes(ref.quote))throw new Error('Evidence must quote an exact authorized source/version')
 return {...ref}
}
export function evaluateCalculation(run,input){
 keys(input,['bindings','expression'])
 if(!Array.isArray(input.bindings)||!input.bindings.length||input.bindings.length>16)throw new Error('Bounded source bindings required')
 const bindings=new Map(),sourceRefs=[]
 for(const binding of input.bindings){
  keys(binding,['key','anchorId','version','quote','literal'])
  const ref=reference({anchorId:binding.anchorId,version:binding.version,quote:binding.quote},run.sources)
  const prefix=`${binding.anchorId}@${binding.version}:`
  if(typeof binding.key!=='string'||!binding.key.startsWith(prefix)||! /^[A-Za-z][A-Za-z0-9_]{0,24}$/.test(binding.key.slice(prefix.length))||bindings.has(binding.key))throw new Error('Parameter keys must be unique and source-namespaced')
  const numbers=binding.quote.match(/[-+]?\d+(?:\.\d+)?/g)||[]
  if(numbers.length!==1||numbers[0]!==binding.literal)throw new Error('Bind one exact source number per quoted fragment')
  bindings.set(binding.key,decimal(binding.literal));sourceRefs.push(ref)
 }
 let nodes=0;const assumptions=[],used=new Set()
 const visit=(node,depth=0)=>{
  if(++nodes>64||depth>12)throw new Error('Bounded calculation tree exceeded')
  keys(node,['ref','value','assumption','op','args'])
  if(typeof node.ref==='string'&&Object.keys(node).length===1){if(!bindings.has(node.ref))throw new Error('Unknown namespaced parameter');used.add(node.ref);return {value:bindings.get(node.ref),display:node.ref}}
  if(typeof node.value==='string'&&typeof node.assumption==='string'&&node.assumption.trim()&&node.assumption.length<=200&&Object.keys(node).length===2){assumptions.push(node.assumption);return {value:decimal(node.value),display:node.value}}
  if(!['add','sub','mul','div'].includes(node.op)||!Array.isArray(node.args)||node.args.length!==2||Object.keys(node).length!==2)throw new Error('Only binary arithmetic operations are available')
  const a=visit(node.args[0],depth+1),b=visit(node.args[1],depth+1),x=a.value,y=b.value
  const value=node.op==='add'?rational(x.n*y.d+y.n*x.d,x.d*y.d):node.op==='sub'?rational(x.n*y.d-y.n*x.d,x.d*y.d):node.op==='mul'?rational(x.n*y.n,x.d*y.d):rational(x.n*y.d,x.d*y.n)
  return {value,display:`(${a.display} ${ {add:'+',sub:'−',mul:'×',div:'÷'}[node.op]} ${b.display})`}
 }
 const evaluated=visit(input.expression)
 if(used.size!==bindings.size)throw new Error('Unused bindings cannot endorse unrelated sources')
 const result={runId:run.id,input:structuredClone(input),sourceRefs,assumptions,result:exact(evaluated.value),expression:evaluated.display,scope:new Set(sourceRefs.map(ref=>ref.anchorId)).size>1?'cross-source':'single-source'}
 return {...result,receiptId:`calc:${hash(result)}`}
}
/** Recognizable numerical derivations belong only in host-rendered receipt fields.
 * This is a conservative syntax gate, not a general natural-language math prover.
 */
export function guardRecommendationProse(input, run, sourceRefs) {
 const focus=discoveryFocus(run)
 const cited=[focus,...sourceRefs.map(ref=>run.sources.find(source=>source.anchorId===ref.anchorId&&source.version===ref.version))].filter(Boolean)
 for(const field of ['title','newInformation','suggested',...(input.hypothesis!==undefined?['hypothesis']:[]),...(input.adoptionBoundary!==undefined?['adoptionBoundary']:[])]) {
  let text=String(input[field]||'').normalize('NFKC').replace(/[−﹣－–—‒⁻₋]/g,'-').replace(/[﹦＝]/g,'=')
  // Only a standalone, explicitly labelled source quotation can bypass prose checks.
  text=text.replace(/(^|[。；;\n])\s*(?:来源)?原文\s*[：:]\s*[“「『"]([^”」』"]+)[”」』"](?=\s*(?:[。；;\n]|$))/g,(whole,_boundary,quote)=>{
   if(!cited.some(source=>source.sourceText.normalize('NFKC').includes(quote)))throw new Error('Inline source quotation is not an authorized exact source')
   return '。引用原文。'
  })
  // Ordinary calendar dates and explicitly marked versions are metadata, not calculations.
  text=text.replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\d{4}年\d{1,2}月\d{1,2}日/g,'日期')
  text=text.replace(/\bv\d+(?:\.\d+)*(?:[-.][A-Za-z]+\.?\d*)?\b|版本\s*\d+(?:\.\d+)*/gi,'版本')
  // A proposed single experiment is not an observed numeric result.
  text=text.replace(/一次(?=(?:可亲手体验的|本地|小型|小|短期|低成本|亲手)*(?:实验|试验|试用|体验|尝试))/g,'一项')
  const number='(?:[-+]?\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万亿点半]+)'
  const quantities=new RegExp(number+'\\s*[”」』"]?\\s*(?:元|块|美元|人民币|%|％|倍|分钟|小时|天|次|场|人|秒|毫秒|公斤|千克|米|万元|个(?:百分点|用户|请求|任务))','u')
  const equation=/[=≈≃≅≒≡≔⩵]|\d\s*[+*×÷/]\s*(?:\d|[A-Za-z(])|\d\s*-\s*\d/u
  const decimal=/\d+\.\d+/u
  const derived=new RegExp('(?:差(?:额|值)?|阈值|临界(?:值|场次)?|增长|减少|增加|成本|预算|比率|比例)\\s*(?:为|是|等于|达到|约为|降低到|增加到)\\s*'+number,'u')
  if(equation.test(text)||decimal.test(text)||(field!=='suggested'&&quantities.test(text))||derived.test(text)||/百分之[零〇一二两三四五六七八九十百千万亿点半\d]+|[一二两三四五六七八九十]+分之[一二两三四五六七八九十]+/u.test(text)) throw new Error(`Unverified numeric derivation in recommendation ${field}; move numbers to structured calculation receipts or remove the numerical recommendation`)
 }
}
export function candidateQuality(input,run){
 const refs=input.sourceRefs||[]
 if(!Array.isArray(refs)||refs.length>16)throw new Error('Bounded evidence references required')
 const sourceRefs=refs.map(ref=>reference(ref,run.sources))
 const focus=discoveryFocus(run)
 if(input.anchorId!==focus.anchorId||input.version!==focus.version)throw new Error('Candidate must remain anchored to the declared discovery focus')
 const assertions=input.calculations||[]
 if(!Array.isArray(assertions)||assertions.length>6)throw new Error('Bounded calculation assertions required')
 const verified=[]
 for(const assertion of assertions){
  keys(assertion,['receiptId','claimedResult'])
  const receipt=run.calculations?.[assertion.receiptId]
  if(!receipt||receipt.runId!==run.id)throw new Error('Exact same-run calculation receipt required')
  const checked=evaluateCalculation(run,receipt.input)
  if(checked.receiptId!==receipt.receiptId || checked.result!==receipt.result)throw new Error('Persisted calculation receipt inconsistent')
  if(exact(claimed(assertion.claimedResult))!==checked.result)throw new Error('Claimed numeric result contradicts deterministic calculation')
  if(checked.sourceRefs.some(ref=>!sourceRefs.some(item=>item.anchorId===ref.anchorId&&item.version===ref.version&&item.quote===ref.quote)))throw new Error('Calculation sources must be explicitly distinguished in candidate evidence')
  verified.push({receiptId:checked.receiptId,result:checked.result,expression:checked.expression,sourceRefs:checked.sourceRefs,assumptions:checked.assumptions,scope:checked.scope})
 }
 guardRecommendationProse(input,run,sourceRefs)
 return {revision:2,proseStatus:'unverified_hypothesis',numericStatus:'structured_only',calculations:verified,sourceRefs:sourceRefs.length?sourceRefs:[{anchorId:focus.anchorId,version:focus.version,quote:focus.sourceText.slice(0,400)}],label:'待验证判断',notice:'仅下列演算的具体数值已核对；解释、单位、关系与业务假设未获证实。'}
}
