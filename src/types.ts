export type TierRank = 1 | 2 | 3 | 4;
export type WritePolicy = 'owner' | 'curators' | 'members';

export interface Tier {
  rank: TierRank;
  key: string;
  name: string;
  description: string;
  write_policy: WritePolicy;
}

export interface Actor {
  userId: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  tokenId: string;
  tokenKind: 'human' | 'agent';
  ceiling: TierRank;
  curatedDomainIds: Set<string>;
  ownedDomainIds: Set<string>;
}

export interface Source {
  kind?: string;
  ref?: string;
  url?: string;
  note?: string;
}

export interface EntityRow {
  id: string;
  type_key: string;
  name: string;
  aliases: string[];
  summary: string;
  properties: Record<string, unknown>;
  tier: TierRank;
  owner_id: string;
  domain_id: string | null;
  status: 'active' | 'deprecated';
  version: number;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface ObservationRow {
  id: string;
  entity_id: string;
  content: string;
  tier: TierRank;
  source: Source | null;
  status: 'active' | 'retracted';
  author_id: string;
  token_id: string | null;
  created_at: Date;
}

export interface RelationRow {
  id: string;
  type_key: string;
  from_id: string;
  to_id: string;
  tier: TierRank;
  source: Source | null;
  status: 'active' | 'removed';
  created_by: string;
  created_at: Date;
}

export interface PropertyDef {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'url' | 'enum';
  required?: boolean;
  options?: string[];
  description?: string;
}

export interface EntityTypeRow {
  key: string;
  name: string;
  description: string;
  default_tier: TierRank;
  domain_id: string | null;
  properties: PropertyDef[];
}

export interface RelationTypeRow {
  key: string;
  name: string;
  inverse_name: string | null;
  description: string;
  from_types: string[] | null;
  to_types: string[] | null;
}

export type ActionKey =
  | 'update_entity'
  | 'add_observation'
  | 'retract_observation'
  | 'add_relation'
  | 'remove_relation'
  | 'set_tier'
  | 'deprecate_entity'
  | 'transfer_ownership';

export interface ChangeRequestRow {
  id: string;
  entity_id: string;
  action: ActionKey;
  payload: Record<string, unknown>;
  summary: string;
  rationale: string;
  source: Source | null;
  base_version: number;
  requested_by: string;
  token_id: string | null;
  assignee_id: string;
  status: 'open' | 'approved' | 'rejected' | 'withdrawn';
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  applied: Record<string, unknown> | null;
  created_at: Date;
}
