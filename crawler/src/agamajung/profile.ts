import defaults from '../../profiles/agamajung.json';
import { FACT_FIELDS } from '../../../shared/collection-schema';
import { AGAMAJUNG_LABELS, MERGE_AXES, REQUIRED_FIELDS } from './vocab';
import { config, validateConfig, type CollectorConfig } from '../source-policy';
export type SourceSettings={tier:string;render:boolean;raw:'hash_only'|'store';content_types:string[]};
export type Profile=Omit<typeof defaults,'domain_policy'>&{domain_policy:Omit<typeof defaults.domain_policy,'sources'>&{sources:Record<string,SourceSettings>}};
const exact=(actual:string[],expected:readonly string[])=>actual.length===new Set(actual).size&&actual.length===expected.length&&expected.every(x=>actual.includes(x));
const deny=['instagram.com','cdninstagram.com','facebook.com','fbcdn.net','gonggumoa.com'];
export function validateProfile(p:Profile,c:CollectorConfig=config):Profile {
  validateConfig(c);
  const check=(ok:unknown)=>{if(!ok)throw new Error('invalid_profile');};
  check(p.id==='agamajung'&&p.profile_version===1);
  check(exact(p.stages,['discover','fetch','render','parse','label','extract','service'])&&p.stages.join(',')==='discover,fetch,render,parse,label,extract,service');
  check(exact(p.labels.map(x=>x.id),Object.keys(AGAMAJUNG_LABELS))&&exact(p.labels.map(x=>x.ko),Object.values(AGAMAJUNG_LABELS))&&p.labels.every(x=>AGAMAJUNG_LABELS[x.id as keyof typeof AGAMAJUNG_LABELS]===x.ko));
  check(exact(p.required_fields.map(x=>x.field),REQUIRED_FIELDS)&&p.required_fields.every(x=>FACT_FIELDS.includes(x.field as typeof FACT_FIELDS[number])));
  check(p.required_fields.every(f=>f.scope===(['shipping_fee','group_buy_terms'].includes(f.field)?'offer':'model')&&f.applicability===(f.field==='certifications'?'explicit_kr':f.scope==='offer'?'confirmed_offer':'confirmed_target')));
  check(p.required_fields.find(f=>f.field==='certifications')?.conditions?.scheme==='KC');
  check(exact(p.merge_forbidden.map(x=>x.id),['different_model_year','body_vs_set','kr_vs_overseas']));
  check(exact(p.merge_forbidden.flatMap(x=>x.axes??(x.axis?[x.axis]:[])),MERGE_AXES));
  check(p.merge_forbidden.some(x=>x.id==='different_model_year'&&exact(x.axes??[],['release_year','generation'])));
  check(p.merge_forbidden.some(x=>x.id==='body_vs_set'&&x.axis==='bundle'&&exact(x.values??[],['body','set'])));
  check(p.merge_forbidden.some(x=>x.id==='kr_vs_overseas'&&x.axis==='market'&&exact(x.values??[],['KR','overseas'])));
  check(p.categories.length>0&&new Set(p.categories.map(x=>x.id)).size===p.categories.length&&p.categories.every(x=>/^[a-z_]+$/.test(x.id)&&x.ko.length>0&&x.en.length>0&&[...x.ko,...x.en].every(k=>k.trim().length>0)));
  check(p.domain_policy.start_order.join(',')==='manufacturer,importer,catalog,official_seller,government'&&p.domain_policy.denied_hosts.every(h=>/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)));
  check(p.domain_policy.default==='deny'&&p.domain_policy.on_restricted==='halt_and_report');
  check(Object.values(p.limits).every(Number.isSafeInteger)&&p.limits.backoff_max_ms>=p.limits.backoff_base_ms&&p.limits.min_interval_ms>=5000&&p.limits.max_attempts===3&&p.limits.backoff_base_ms>=300000&&p.limits.backoff_max_ms<=21600000);
  check(Object.values(p.cost_caps).every(cap=>['requests','bytes','model_calls'].every(k=>Number.isSafeInteger(cap[k as keyof typeof cap])&&cap[k as keyof typeof cap]>=0)));
  check(p.model.enabled||Object.values(p.cost_caps).every(cap=>cap.model_calls===0));
  for(const [id,policy] of Object.entries(p.domain_policy.sources)){
    const source=c.sources.find(s=>s.id===id);check(source);if(!source)continue;
    const host=new URL(source.origin).hostname;
    check(![...deny,...p.domain_policy.denied_hosts].some(h=>host===h||host.endsWith(`.${h}`)));
    check(!policy.render||source.browser);
    check(['hash_only','store'].includes(policy.raw)&&policy.content_types.length>0&&policy.content_types.every(t=>/^[\w.+-]+\/[\w.+*-]+$/.test(t)));
    check(policy.raw!=='store'||source.full_text_allowed&&source.permission_basis);
    check(p.domain_policy.start_order.includes(policy.tier));
  }
  check(p.extractor_version.length>0&&p.labeler_version.length>0);
  return p;
}
export const loadProfile=(settings:CollectorConfig=config)=>validateProfile(structuredClone(defaults) as Profile,settings);
