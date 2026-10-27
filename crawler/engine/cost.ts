import { randomUUID } from 'node:crypto';
import { CostCapError, type CostCaps, type Costs, type CostTicket, type EngineDb, type RequestMeter } from './types';
import { dayKey } from './util';
type Hold={scopes:string[];amount:Partial<Costs>};
export class CostLedger implements RequestMeter {
  private runId='';
  constructor(readonly store:EngineDb,readonly profileId:string,readonly caps:CostCaps,readonly owner=randomUUID()){}
  open(runId:string){this.runId=runId;this.store.transaction(()=>this.ensureScopes());return this;}
  private ensureScopes(){
    const scopes=[`day:${dayKey(this.store.now())}:${this.profileId}`,`run:${this.runId}`];
    for(const scope of scopes)for(const kind of ['requests','bytes','model_calls'] as const)this.store.db.prepare('INSERT OR IGNORE INTO engine_costs(id,scope,kind,cap) VALUES(?,?,?,?)').run(`${scope}:${kind}`,scope,kind,this.caps[scope.startsWith('day:')?'day':'run'][kind]);
    return scopes;
  }
  hold(maxBytes:number){return this.holdKinds({requests:1,bytes:maxBytes});}
  holdKinds(amount:Partial<Costs>):CostTicket {
    if(!this.runId)throw new Error('cost_not_open');
    return this.store.transaction(()=>{
      const scopes=this.ensureScopes();
      for(const scope of scopes)for(const [kind,n] of Object.entries(amount)){
        if(!Number.isSafeInteger(n)||n<0)throw new Error('cost_amount');
        const r=this.store.db.prepare('SELECT * FROM engine_costs WHERE id=?').get(`${scope}:${kind}`) as {held:number;spent:number;cap:number};
        if(r.held+r.spent+n>r.cap)throw new CostCapError(scope.startsWith('day:')?'day':'run');
      }
      for(const scope of scopes)for(const [kind,n] of Object.entries(amount))this.store.db.prepare('UPDATE engine_costs SET held=held+? WHERE id=?').run(n,`${scope}:${kind}`);
      const id=randomUUID();this.store.db.prepare('INSERT INTO engine_cost_holds VALUES(?,?,?,?,?)').run(id,this.runId,this.owner,this.store.now(),JSON.stringify({scopes,amount}));return {id};
    });
  }
  settle(ticket:CostTicket,received:number){this.settleKinds(ticket,{requests:1,bytes:received});}
  settleKinds(ticket:CostTicket,actual:Partial<Costs>){this.store.transaction(()=>this.settleInside(ticket,actual));}
  private settleInside(ticket:CostTicket,actual?:Partial<Costs>){
    const row=this.store.db.prepare('SELECT data FROM engine_cost_holds WHERE id=?').get(ticket.id) as {data:string}|undefined;if(!row)return;
    const h=JSON.parse(row.data) as Hold;
    for(const scope of h.scopes)for(const [kind,n] of Object.entries(h.amount)){
      const used=actual?.[kind as keyof Costs]??n;
      if(!Number.isSafeInteger(used)||used<0||used>n)throw new Error('cost_overrun');
      this.store.db.prepare('UPDATE engine_costs SET held=held-?,spent=spent+? WHERE id=?').run(n,used,`${scope}:${kind}`);
    }
    this.store.db.prepare('DELETE FROM engine_cost_holds WHERE id=?').run(ticket.id);
  }
  recoverOrphans(){this.store.transaction(()=>{for(const r of this.store.db.prepare('SELECT id FROM engine_cost_holds').all() as {id:string}[])this.settleInside(r);});}
}
