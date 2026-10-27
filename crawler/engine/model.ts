import type { ModelPort } from './types';
export class DisabledModel implements ModelPort {async classify(){return {status:'unsupported' as const,labels:[]};}}
