import { z } from 'zod';
import { deepFreeze } from '../freeze.js';
import type { ChallengeFamily } from './common.js';

/**
 * Root: POSIX-style permission checks with a small ACL.
 * mode is 9 chars (`rwxr-x---`): three triples, owner then group then other. A triple is 3 chars, positional:
 * `r` or `-`, then `w` or `-`, then `x` or `-`. Each ACL entry's `perms` is one triple in the same format.
 * Precedence for a request by user U with groups G for op o:
 *   1. U is the owner            -> the owner triple
 *   2. an ACL entry `user:U`     -> its perms
 *   3. any ACL entry `group:g` with g in G -> allowed if ANY such entry grants o
 *   4. the file's group is in G  -> the group triple
 *   5. otherwise                 -> the other triple
 * Answer: one '1'/'0' per request, concatenated.
 */
export interface AclEntry {
  who: string;
  perms: string;
}
export interface RootRequest {
  user: string;
  groups: string[];
  op: 'r' | 'w' | 'x';
}
export interface RootParams {
  mode: string;
  owner: string;
  group: string;
  acl: AclEntry[];
}
export interface RootPayload {
  requests: RootRequest[];
}
export interface RootAnswer {
  allowed: string;
}

const has = (triple: string, op: 'r' | 'w' | 'x') => triple[{ r: 0, w: 1, x: 2 }[op]] === op;

export function checkAccess(params: RootParams, req: RootRequest): boolean {
  if (req.user === params.owner) return has(params.mode.slice(0, 3), req.op);
  const user = params.acl.find((a) => a.who === `user:${req.user}`);
  if (user) return has(user.perms, req.op);
  const groups = params.acl.filter((a) => a.who.startsWith('group:') && req.groups.includes(a.who.slice(6)));
  if (groups.length) return groups.some((a) => has(a.perms, req.op));
  if (req.groups.includes(params.group)) return has(params.mode.slice(3, 6), req.op);
  return has(params.mode.slice(6, 9), req.op);
}

export const USERS: readonly string[] = deepFreeze(['root', 'alice', 'bob', 'carol', 'dave', 'erin']);
export const GROUPS: readonly string[] = deepFreeze(['wheel', 'staff', 'ops', 'guest']);

const triple = (rng: { chance(p: number): boolean }) => `${rng.chance(0.6) ? 'r' : '-'}${rng.chance(0.4) ? 'w' : '-'}${rng.chance(0.4) ? 'x' : '-'}`;

export const rootFamily: ChallengeFamily<RootParams, RootPayload, RootAnswer> = {
  type: 'root',
  rules: [
    'Root: POSIX-style permission checks with a small ACL.',
    'mode is 9 chars (`rwxr-x---`): three triples, owner then group then other. A triple is 3 chars, positional:',
    '`r` or `-`, then `w` or `-`, then `x` or `-`. Each ACL entry\'s `perms` is one triple in the same format.',
    'Precedence for a request by user U with groups G for op o:',
    '  1. U is the owner            -> the owner triple',
    '  2. an ACL entry `user:U`     -> its perms',
    '  3. any ACL entry `group:g` with g in G -> allowed if ANY such entry grants o',
    '  4. the file\'s group is in G  -> the group triple',
    '  5. otherwise                 -> the other triple',
    'Answer: one \'1\'/\'0\' per request, concatenated.',
  ].join('\n'),
  answerSchema: z.object({ allowed: z.string().regex(/^[01]*$/).max(16384) }),
  generate(size, _noise, rng) {
    const params: RootParams = {
      mode: triple(rng) + triple(rng) + triple(rng),
      owner: rng.pick(USERS),
      group: rng.pick(GROUPS),
      acl: [{ who: `user:${rng.pick(USERS)}`, perms: triple(rng) }, { who: `group:${rng.pick(GROUPS)}`, perms: triple(rng) }],
    };
    const requests: RootRequest[] = [];
    for (let i = 0; i < size; i++) {
      const groups = [...new Set([rng.pick(GROUPS), ...(rng.chance(0.5) ? [rng.pick(GROUPS)] : [])])];
      requests.push({ user: rng.pick(USERS), groups, op: rng.pick(['r', 'w', 'x'] as const) });
    }
    return { params, payload: { requests }, answer: { allowed: requests.map((r) => (checkAccess(params, r) ? '1' : '0')).join('') } };
  },
  check: (e, s) => e.allowed === s.allowed,
};
