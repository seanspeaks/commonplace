import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canWrite } from '../src/policy.js';
import type { Actor, Tier, TierRank } from '../src/types.js';

const tiers = new Map<TierRank, Tier>([
  [1, { rank: 1, key: 'canon', name: 'Canon', description: '', write_policy: 'owner' }],
  [2, { rank: 2, key: 'verified', name: 'Verified', description: '', write_policy: 'curators' }],
  [3, { rank: 3, key: 'working', name: 'Working', description: '', write_policy: 'members' }],
  [4, { rank: 4, key: 'raw', name: 'Raw', description: '', write_policy: 'members' }],
]);

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: 'me',
  email: 'me@x.com',
  name: 'Me',
  role: 'member',
  tokenId: 't',
  tokenKind: 'human',
  ceiling: 1,
  curatedDomainIds: new Set(),
  ownedDomainIds: new Set(),
  ...over,
});

const target = (tier: TierRank, ownerId = 'someone', domainId: string | null = 'd1') => ({ tier, ownerId, domainId });

test('owners can overwrite their own knowledge at every tier', () => {
  for (const t of [1, 2, 3, 4] as TierRank[]) assert.equal(canWrite(actor(), target(t, 'me'), tiers).ok, true);
});

test('Canon is owner-only, even for curators', () => {
  const d = canWrite(actor({ curatedDomainIds: new Set(['d1']) }), target(1), tiers);
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.reason, 'owner_only');
});

test('Verified is open to the domain curators and domain owner, not other members', () => {
  assert.equal(canWrite(actor({ curatedDomainIds: new Set(['d1']) }), target(2), tiers).ok, true);
  assert.equal(canWrite(actor({ ownedDomainIds: new Set(['d1']) }), target(2), tiers).ok, true);
  assert.equal(canWrite(actor({ curatedDomainIds: new Set(['other']) }), target(2), tiers).ok, false);
  assert.equal(canWrite(actor(), target(2, 'someone', null), tiers).ok, false);
});

test('Working and Raw are open to any member', () => {
  assert.equal(canWrite(actor(), target(3), tiers).ok, true);
  assert.equal(canWrite(actor(), target(4), tiers).ok, true);
});

test('admins can write anything within their ceiling', () => {
  assert.equal(canWrite(actor({ role: 'admin' }), target(1), tiers).ok, true);
});

test('a token ceiling beats ownership and admin rights', () => {
  const agent = actor({ tokenKind: 'agent', ceiling: 4, role: 'admin' });
  const d = canWrite(agent, target(3, 'me'), tiers);
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.reason, 'ceiling');
  assert.equal(canWrite(agent, target(4, 'me'), tiers).ok, true);
});

test('ownerOnly targets reject everyone but the owner and admins', () => {
  assert.equal(canWrite(actor(), { ...target(4), ownerOnly: true }, tiers).ok, false);
  assert.equal(canWrite(actor(), { ...target(4, 'me'), ownerOnly: true }, tiers).ok, true);
});
