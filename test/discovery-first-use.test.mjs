import test from 'node:test'
import assert from 'node:assert/strict'
import {guardRecommendationProse} from '../lib/discovery-quality.js'
import {validateOpportunity,normalizeDiscoveryResult} from '../lib/idea-opportunity.js'
const run={sources:[{anchorId:'a',version:1,sourceText:'想了解主动性'}],focusAnchorId:'a'}
test('ordinary experiment wording passes, numerical claims still fail',()=>{
 assert.doesNotThrow(()=>guardRecommendationProse({title:'把主动性变成一次可亲手体验的本地小实验'},run,[]));
 assert.throws(()=>guardRecommendationProse({title:'成本降低到三元'},run,[]),/numeric/);
 assert.throws(()=>guardRecommendationProse({title:'增加20倍'},run,[]),/numeric/);
})
test('misplaced field diagnostic identifies the exact correction',()=>{
 assert.throws(()=>validateOpportunity({intentType:'explicit',pluginOptions:[]}),/pluginOptions.*directly inside candidate/);
})

test('known nesting mistakes are repaired without changing source or conflicting values',()=>{
 const input={outcome:'candidate',candidate:{anchorId:'a',opportunity:{intentType:'explicit',hypothesis:'假设',pluginOptions:[]}}};
 const result=normalizeDiscoveryResult(input);assert.equal(result.candidate.hypothesis,'假设');assert.deepEqual(result.candidate.pluginOptions,[]);assert.equal(result.candidate.opportunity.hypothesis,undefined);assert.equal(input.candidate.opportunity.hypothesis,'假设');
 input.candidate.hypothesis='不同';assert.equal(normalizeDiscoveryResult(input).candidate.opportunity.hypothesis,'假设');
})
