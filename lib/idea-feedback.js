export function updateIdeaFeedback(card,input,now=()=>new Date().toISOString()) {
  if(!card||card.withdrawn||card.cardId!==input.cardId||card.version!==input.version)throw Error('点子已变化，请刷新后反馈')
  if(!['useful','not_useful','clear'].includes(input.rating)||!['','misunderstood','known','not_now'].includes(input.reason||'')||(input.rating!=='not_useful'&&input.reason))throw Error('Invalid idea feedback')
  const rating=input.rating==='clear'?null:input.rating,reason=input.reason||''
  if((card.feedback?.rating||null)===rating&&(card.feedback?.reason||'')===reason)return card
  const feedback={rating,reason,at:now()}
  return {...card,feedback,feedbackHistory:[...(card.feedbackHistory||[]),feedback].slice(-20)}
}
export function ideaFeedbackContext(cards=[]) {
  return cards.filter(c=>c.feedback?.rating).sort((a,b)=>b.feedback.at.localeCompare(a.feedback.at)).slice(0,10).map(c=>({cardId:c.cardId,version:c.version,title:c.title,idea:String(c.newInformation||'').slice(0,400),intent:String(c.opportunity?.userIntent||'').slice(0,200),source:String(c.sourceText||'').slice(0,300),nextStep:String(c.opportunity?.nextStep||c.suggested||'').slice(0,300),pluginNames:(c.pluginOptions||[]).map(p=>p.name),...c.feedback,scope:'This recommendation only; not a permanent preference or execution permission.'}))
}
