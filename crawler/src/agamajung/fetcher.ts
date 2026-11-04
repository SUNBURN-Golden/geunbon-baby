import { isPangpang, pangpangIdentityAllowed } from '../../lib/external/pangpang';
import { requireThat } from '../store';
import type { FetcherPort } from '../../engine/types';
import { Scheduler } from '../scheduler';
import { visitAllowed, type SourcePolicy } from '../source-policy';
export class SchedulerFetcher implements FetcherPort {
  constructor(readonly scheduler:Scheduler,readonly source:SourcePolicy){}
  async get(url:string,options?:{headers?:Record<string,string>}){
    const validateUrl=isPangpang(this.source)?(next:string)=>{requireThat(visitAllowed(next,this.source)&&pangpangIdentityAllowed(url,next),'redirect_identity');return true;}:undefined;
    const response=await this.scheduler.get(url,this.source,{...options,validateUrl});
    if(validateUrl)validateUrl(response.finalUrl??url);
    return response;
  }
}
