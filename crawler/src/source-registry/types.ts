import type { FactField } from '../../../shared/collection-schema';

export type PermissionCheck = {
  status: 'allowed'|'disallowed'|'unknown';
  checked_at: string|null;
  evidence: string|null;
};
export type RegistryScope = {
  origin: string|null;
  scope_hosts: string[];
  // Exact path, or descendants when the prefix ends in '/'.
  allowed_path_prefixes: string[];
  // Additional AND constraint; alternatives within this list are OR.
  path_patterns: string[];
  query_keys: string[];
};
export type SourceRegistryEntry = RegistryScope & {
  source_id: string;
  revision: number;
  kind: 'manufacturer_importer'|'catalog'|'official_seller'|'public_db'|'group_buy'|'social';
  blocked_paths: string[];
  collectable_fields: FactField[];
  permission: {robots: PermissionCheck; terms: PermissionCheck};
  refresh_ms: number|null;
  retention: {snippets_days: number|null; full_text_days: number|null; images_days: number|null; conditions: string};
  // '*' blocks collection; path scopes block matching paths; other values document unsupported capabilities.
  unsupported: {scope: string; reason: string}[];
  status: 'registered'|'deprioritized'|'excluded';
  reevaluate_at: string|null;
  evidence: {reference: string; details?: unknown}[];
};
// An approval binds the entire next policy, including exact scope and fields.
export type RevisionApproval = {
  source_id: string;
  base_revision: number;
  entry: SourceRegistryEntry;
  decided_by: string;
  evidence: string;
  approved_at: string;
  expires_at: string;
};
export type Reason = 'approved'|'unknown_source'|'invalid_url'|'origin_mismatch'|'host_mismatch'|'path_mismatch'|'query_denied'|'blocked_path'|'unsupported'|'field_denied'|'inactive'|'permission_unknown'|'permission_denied'|'reevaluation_due'|'approval_required'|'approval_expired'|'scope_shadowed'|'ambiguous_scope'|'legacy_scope_mismatch'|'legacy_disabled'|'legacy_field_denied';
export type RegistryDecision = {
  allowed: boolean; reason: Reason; source_id: string; revision: number|null;
  applied?: {source_id: string; revision: number};
  approval?: {id: string; approved_at: string; expires_at: string};
};
