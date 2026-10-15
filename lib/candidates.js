import { validateOpportunity } from './idea-opportunity.js'
import { createHash } from 'node:crypto'
export const canonical = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
export function isConcern(text) { return !/\[Muse |\[灵感引用\]|后台|独立工作|子任务|停止|验收|不重发|只更新/.test(text) && /我(?:希望|想要|关心|担心)|长期|持续关注|目标[:：]|计划/.test(text) }
const grams = text => new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)))
export function equivalent(a, b) {
  a = canonical(a); b = canonical(b)
  if (a === b) return true
  const x = grams(a), y = grams(b), union = new Set([...x, ...y])
  return union.size > 0 && [...x].filter(v => y.has(v)).length / union.size >= .9
}
export function validateCandidate(input, source, prior) {
  const opportunity = input.opportunity ? validateOpportunity(input.opportunity) : null
  if (!source || input.version !== source.version) throw new Error('Candidate needs a current authorized human anchor')
  const title = String(input.title || '').trim(), suggested = String(input.suggested || '').trim(), novel = String(input.newInformation || '').trim()
  for (const [field,text,min,max] of [['title',title,4,80],['suggested',suggested,20,1200],['newInformation',novel,16,600]]) if(text.length<min||text.length>max) throw Error(`candidate.${field} needs ${min}–${max} characters; received ${text.length}. Keep a concrete next step and new information.`)
  if (/Heartbeat|Background subagent|Agent [\da-f-]+ sent|本轮(?:无|没有)|已收束|继续接收|收到补充|已派发|正在推进/.test(title + suggested + novel)) throw new Error('Lifecycle text is not a candidate')
  if (!opportunity && !/[?？]|未知|条件|如果|若|核对|确认|测量|记录|比较|验证|检查|阈值|分钟|次数|成本|风险/.test(suggested)) throw new Error('Candidate needs an actionable condition or question')
  if (!opportunity && (equivalent(novel, source.sourceText) || canonical(source.sourceText).includes(canonical(novel)))) throw new Error('Repeating the human source is not new information')
  if (prior.some(card => card.anchorId === source.anchorId && equivalent(card.newInformation, novel))) return null
  const fingerprint = createHash('sha256').update(`${source.anchorId}:${source.version}:${canonical(novel)}`).digest('hex')
  return { ...source, ...(opportunity?{opportunity}:{}), cardId: `candidate:${fingerprint}`, kind: 'proactive', title, suggested, newInformation: novel, fingerprint, evidence: `延续你的${source.origin}：${source.sourceText}`, freshness: '新的灵感', createdAt: new Date().toISOString() }
}
