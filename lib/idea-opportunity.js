export const opportunitySchema = {type:'object',additionalProperties:false,properties:{intentType:{type:'string',enum:['explicit','inferred']},userIntent:{type:'string',minLength:1,maxLength:400},relevance:{type:'string',minLength:1,maxLength:500},nextStep:{type:'string',minLength:1,maxLength:600},taskContext:{type:'string',minLength:1,maxLength:1800}},required:['intentType','userIntent','relevance','nextStep','taskContext']}
export function validateOpportunity(value) {
  if (!value || !['explicit','inferred'].includes(value.intentType)) throw Error('opportunity.intentType must be explicit or inferred')
  const extra=Object.keys(value).filter(k=>!Object.hasOwn(opportunitySchema.properties,k)); if(extra.length) throw Error('Unexpected opportunity fields: '+extra.join(', ')+'. Put hypothesis, adoptionBoundary and pluginOptions directly inside candidate, alongside opportunity.')
  for (const key of ['userIntent','relevance','nextStep','taskContext']) if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>opportunitySchema.properties[key].maxLength) throw Error('Bounded opportunity context required: '+key)
  return structuredClone(value)
}

// Correct only unambiguous nesting mistakes; never discard conflicting values.
export function normalizeDiscoveryResult(input) {
 const value=structuredClone(input)
 if(value.outcome==='candidate' && value.candidate?.opportunity) for(const key of ['hypothesis','adoptionBoundary','pluginOptions']) {
  const nested=value.candidate.opportunity[key]
  if(nested!==undefined && value.candidate[key]===undefined) {value.candidate[key]=nested;delete value.candidate.opportunity[key]}
  else if(nested!==undefined && JSON.stringify(nested)===JSON.stringify(value.candidate[key])) delete value.candidate.opportunity[key]
 }
 return value
}
