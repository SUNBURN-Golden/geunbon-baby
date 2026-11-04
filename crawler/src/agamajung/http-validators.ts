import { filterText } from '../../../shared/privacy-rules';
// Validator identity must survive inspection unchanged. Redacted validators are unusable.
export function safeEtag(v:unknown){return typeof v==='string'&&v.length<=256&&/^(?:W\/)?"[\x21\x23-\x7e]*"$/.test(v)&&!/[&%]/.test(v)&&filterText(v,256)===v?v:null;}
export function safeModified(v:unknown){return typeof v==='string'&&v.length<=40&&new Date(v).toUTCString()===v?v:null;}
