import type { DatabaseSync } from 'node:sqlite';
export type Stage = string;
export type Phase = 'pending'|'leased'|'retry_wait'|'deferred'|'done'|'failed'|'skipped';
export type RunState = 'running'|'cost_wait'|'exhausted'|'halted'|'finished';
export type Data = Record<string, unknown>;
export interface EngineDb { db: DatabaseSync; transaction<T>(task:()=>T):T; now:()=>number }
export type Checkpoint = {id:string;run_id:string;stage:Stage;item_key:string;phase:Phase;attempts:number;next_at:number;lease_owner:string|null;lease_until:number|null;input_digest:string;version_tag:string;output_ref:string|null;error_code:string|null;data:Data};
export type FailureEntry = {id:string;run_id:string;stage:string;item_key:string;reason:string;attempts:number;retryable:number;next_retry_at:number|null;first_at:number;last_at:number;data:string};
export type StageResult = { outputRef?:string; data?:Data; nextStage?:string|null };
export type StageHandler = {kind:'transactional'|'external'; version:string; run:(checkpoint:Checkpoint)=>Promise<StageResult>; commit?:(result:StageResult,checkpoint:Checkpoint)=>StageResult|void; recover?:(checkpoint:Checkpoint)=>StageResult|undefined};
export type CostKind = 'requests'|'bytes'|'model_calls';
export type Costs = Record<CostKind,number>;
export type CostCaps = {run:Costs;day:Costs};
export type CostScope = {key:string;caps:Costs;local?:boolean};
export class CostCapError extends Error { constructor(readonly scope:'run'|'day',readonly local=false,readonly budgetScope=''){super(`cost_${scope}`);} }
export type CostTicket = {id:string};
export interface RequestMeter {hold(maxBytes:number):CostTicket;settle(ticket:CostTicket,received:number):void}
export type FetchResponse = {status:number;headers:Record<string,string>;body:string;bytes?:Buffer;finalUrl?:string};
export interface FetcherPort {get(url:string,options?:{headers?:Record<string,string>}):Promise<FetchResponse>}
export type RenderSnapshot = {finalUrl:string;html:string;text:string;regionText?:string;regionError?:string;title?:string;documentOrigin?:string};
export type MemoryCapability = {nonpersistent:true;version:string};
export interface RenderPort {capability?:MemoryCapability;render(url:string,document:FetchResponse,options?:{signal:AbortSignal;maxBytes:number}):Promise<RenderSnapshot>}
export interface ServicePort {submit(reservationId:string,payload:unknown,trustedSourceId?:string):{id:string;digest:string}|Promise<{id:string;digest:string}>;receipt(reservationId:string):{id:string;digest:string}|undefined}
export interface StoragePort {service?:ServicePort;capture(row:Data):void;extracted(row:Data):void;label(row:Data):void}
export interface ModelPort {classify(input:unknown):Promise<{status:'ok'|'unsupported';labels:string[]}>}
