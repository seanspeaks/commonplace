import type { Actor, Tier, TierRank } from './types.js';

export interface WriteTarget {
  tier: TierRank;
  ownerId: string;
  domainId: string | null;
  ownerOnly?: boolean;
}

export type Decision = { ok: true } | { ok: false; reason: 'ceiling' | 'owner_only' | 'curators_only'; message: string };

/**
 * The whole write model in one place:
 *  1. A token never writes above its ceiling, not even for its own user. This is what keeps
 *     an agent acting for you from promoting its own guesses to Canon.
 *  2. Admins and the owner can write at any tier (within the ceiling).
 *  3. Otherwise the tier's write_policy decides: owner-only, domain curators, or any member.
 */
export function canWrite(actor: Actor, target: WriteTarget, tiers: Map<TierRank, Tier>): Decision {
  const tier = tiers.get(target.tier);
  if (!tier) throw new Error(`Unknown tier ${target.tier}`);

  if (target.tier < actor.ceiling) {
    const ceiling = tiers.get(actor.ceiling)!;
    return {
      ok: false,
      reason: 'ceiling',
      message: `This ${actor.tokenKind} token can write ${ceiling.name} (tier ${ceiling.rank}) and below. ${tier.name} (tier ${tier.rank}) needs the owner's approval.`,
    };
  }

  const isOwner = actor.userId === target.ownerId;
  if (actor.role === 'admin' || isOwner) return { ok: true };

  if (target.ownerOnly) {
    return { ok: false, reason: 'owner_only', message: 'Only the owner can do this.' };
  }

  switch (tier.write_policy) {
    case 'owner':
      return { ok: false, reason: 'owner_only', message: `${tier.name} knowledge can only be changed by its owner.` };
    case 'curators': {
      const curates = target.domainId !== null && (actor.curatedDomainIds.has(target.domainId) || actor.ownedDomainIds.has(target.domainId));
      return curates
        ? { ok: true }
        : { ok: false, reason: 'curators_only', message: `${tier.name} knowledge can only be changed by its owner or the domain's curators.` };
    }
    case 'members':
      return { ok: true };
  }
}

/** Default tier for new facts: Working for people, the ceiling for agents (Raw unless trusted). */
export function defaultFactTier(actor: Actor): TierRank {
  return Math.max(3, actor.ceiling) as TierRank;
}
