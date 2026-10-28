import { expect, test } from 'vitest';
import { loadProfile } from '../crawler/src/agamajung/profile';
import { loadDiscoveryConfig } from '../crawler/src/source-discovery/config';
import { combinationAt, combinationCount, feedbackQueries, resolvedYears } from '../crawler/src/source-discovery/queries';
import { explicitSubjects } from '../crawler/src/source-discovery/entities';
import { extractDocument } from '../crawler/src/discovery/document';
import { discoveryAsset } from './helpers/source-discovery';
test('Cartesian cursor is deterministic, bilingual and freezes current year at KST run start',()=>{
 const c=loadDiscoveryConfig(),p=loadProfile();expect(combinationCount(c,p)).toBe(30);
 const years=resolvedYears(c,Date.parse('2026-12-31T14:59:59Z'));expect(years).toEqual(['2026']);
 const a=combinationAt(0,c,p,years,'fixture')!;expect(a.text).toBe('유모차 KR ko 2026 공구');expect(combinationAt(3,c,p,years,'fixture')?.text).toBe('stroller KR en 2026 group buy');expect(combinationAt(30,c,p,years,'fixture')).toBeUndefined();
 expect(a).toEqual(combinationAt(0,c,p,years,'fixture'));
});
test('explicit entities feed ordered prefixes and reverse queries only for the same subject and normalized conditions',()=>{
 const doc=extractDocument(discoveryAsset('entities.html'),'https://gear.example.org/','links'),s=explicitSubjects(doc.text,'fixture')[0],p=loadProfile();
 expect(s).toMatchObject({brand:'Example',model_number:'EX-100',conditions:{release_year:'2026',market:'KR',bundle:'body'}});
 const all=feedbackQueries('fixture',s,p),reverse=all.find(q=>q.text==='Example Line EX-100 2026 body KR Blue Example Shop KC 인증번호')!;expect(reverse.kind).toBe('missing_field');
 expect(all[0].text).toBe('Example');expect(all[2].text).toBe('Example Line EX-100');
 expect(feedbackQueries('fixture',s,p,[{field:'certifications',subject_ref:s.subject_ref,conditions:{scheme:'KC',...s.conditions}}]).some(q=>q.text.includes('KC 인증번호'))).toBe(false);
 for(const different of [{...s.conditions,release_year:'2025'},{...s.conditions,bundle:'set'},{...s.conditions,market:'overseas'}])expect(feedbackQueries('fixture',s,p,[{field:'certifications',subject_ref:s.subject_ref,conditions:{scheme:'KC',...different}}]).some(q=>q.text.includes('KC 인증번호'))).toBe(true);
 expect(feedbackQueries('fixture',{...s,conditions:{}},p).some(q=>q.text.includes('KC 인증번호'))).toBe(false);
 expect(explicitSubjects('모델번호: EX-100\nemail: fixture@example.org\ntoken: synthetic_private_value','fixture')[0]).toMatchObject({model_number:'EX-100',conditions:{}});
});
