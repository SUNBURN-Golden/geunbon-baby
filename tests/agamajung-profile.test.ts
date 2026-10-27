import { expect, test } from 'vitest';
import { loadProfile, validateProfile, type Profile } from '../crawler/src/agamajung/profile';
import { config } from '../crawler/src/source-policy';
import { source } from './helpers/collector';
test('deployed profile validates vocabulary separately from fact fields and defaults to denying sources',()=>{
 const p=loadProfile();expect(p.labels).toHaveLength(6);expect(p.required_fields).toHaveLength(7);expect(p.model.enabled).toBe(false);expect(p.domain_policy.sources.pangpang).toBeUndefined();
});
const mutations:((p:Profile)=>void)[]=[p=>p.labels.pop(),p=>p.labels.push(p.labels[0]),p=>p.labels[0].ko='다른라벨',p=>p.labels[0].id='other',p=>p.required_fields.pop(),p=>p.required_fields[0]=p.required_fields[1],p=>p.required_fields[0].field='unknown',p=>p.domain_policy.sources.unknown=p.domain_policy.sources.cpsc,p=>p.limits.min_interval_ms=4999,p=>p.cost_caps.day.model_calls=1,p=>p.categories.push(p.categories[0]),p=>p.categories[0].ko=[''],p=>p.merge_forbidden[1].axis='other',p=>p.merge_forbidden[1].values=['body','other'],p=>p.merge_forbidden[0].id=p.merge_forbidden[1].id,p=>p.domain_policy.sources.cpsc.render=true,p=>p.domain_policy.sources.cpsc.raw='store'];
test.each(mutations.map((fn,i)=>({fn,i})))('rejects invalid profile case $i',({fn})=>{const p=loadProfile();fn(p);expect(()=>validateProfile(p)).toThrow();});
test.each(['instagram.com','www.instagram.com','cdninstagram.com','facebook.com','images.fbcdn.net'])('denied host %s cannot be enabled by a profile',host=>{
 const p=loadProfile();p.domain_policy.sources={[source.id]:{tier:'manufacturer',render:false,raw:'hash_only',content_types:['text/html']}};const s={...source,origin:`https://${host}`,entries:[`https://${host}/`]};expect(()=>validateProfile(p,{...config,sources:[s]})).toThrow();
});
