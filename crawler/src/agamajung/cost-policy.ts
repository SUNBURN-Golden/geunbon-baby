import { CostLedger } from '../../engine/cost';
import type { Costs, EngineDb } from '../../engine/types';
import type { Profile } from './profile';
// Both commands bind daily costs here. Execution identity is intentionally separate.
export function agamajungCosts(store:EngineDb,profile:Profile,run:Costs=profile.cost_caps.run) {
  return new CostLedger(store,'agamajung',{run,day:profile.cost_caps.day},undefined,()=>profile.cost_caps.day);
}
