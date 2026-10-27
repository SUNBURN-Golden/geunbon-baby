import type { FetcherPort } from '../../engine/types';
import { Scheduler } from '../scheduler';
import type { SourcePolicy } from '../source-policy';
export class SchedulerFetcher implements FetcherPort {
  constructor(readonly scheduler:Scheduler,readonly source:SourcePolicy){}
  get(url:string,options?:{headers?:Record<string,string>}){return this.scheduler.get(url,this.source,options);}
}
