import { approved } from './approved';
const status=document.querySelector('#status')!;
document.querySelector('form')!.addEventListener('submit',async event=>{event.preventDefault();const input=document.querySelector<HTMLInputElement>('#token')!;await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});const old=(await chrome.storage.local.get('settings')).settings??{};await chrome.storage.local.set({settings:{...old,token:input.value}});input.value='';status.textContent='연결 정보를 저장했습니다.';});
document.querySelector('#enable')!.addEventListener('click',async()=>{
  if(!approved.length){status.textContent='승인된 브라우저 수집 사이트가 없습니다.';return;}
  const granted=await chrome.permissions.request({origins:approved.map(s=>`${s.origin}/*`)});
  const old=(await chrome.storage.local.get('settings')).settings??{};await chrome.storage.local.set({settings:{...old,unattended:granted}});status.textContent=granted?'자동 읽기를 켰습니다.':'권한이 부여되지 않았습니다.';
});
document.querySelector('#disable')!.addEventListener('click',async()=>{const old=(await chrome.storage.local.get('settings')).settings??{};await chrome.storage.local.set({settings:{...old,unattended:false}});status.textContent='자동 읽기를 껐습니다.';});
