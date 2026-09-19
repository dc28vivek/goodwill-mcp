import type { SwGroup, SwUser } from '../splitwise/types.js';
import { fullName } from './format.js';

export type Resolved =
  | { ok: true; user: SwUser }
  | { ok: false; reason: 'ambiguous'; candidates: SwUser[] }
  | { ok: false; reason: 'not_found' };

/**
 * Turn "me", a first name, a full name, or a numeric id into a group member.
 * Matching is case-insensitive on full name, then first name, then prefix.
 * Two matches is an ambiguity the user has to settle.
 */
export function resolveMember(group: Pick<SwGroup, 'members'>, ref: string | number, meId: number): Resolved {
  const members = group.members;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const id = Number(ref);
    const user = members.find((m) => m.id === id);
    return user ? { ok: true, user } : { ok: false, reason: 'not_found' };
  }
  const q = ref.trim().toLowerCase();
  if (q === 'me' || q === 'i' || q === 'myself') {
    const user = members.find((m) => m.id === meId);
    return user ? { ok: true, user } : { ok: false, reason: 'not_found' };
  }
  const exactFull = members.filter((m) => fullName(m).toLowerCase() === q);
  if (exactFull.length === 1) return { ok: true, user: exactFull[0]! };
  const exactFirst = members.filter((m) => m.first_name.toLowerCase() === q);
  if (exactFirst.length === 1) return { ok: true, user: exactFirst[0]! };
  if (exactFirst.length > 1) return { ok: false, reason: 'ambiguous', candidates: exactFirst };
  const prefix = members.filter((m) => fullName(m).toLowerCase().startsWith(q));
  if (prefix.length === 1) return { ok: true, user: prefix[0]! };
  if (prefix.length > 1) return { ok: false, reason: 'ambiguous', candidates: prefix };
  return { ok: false, reason: 'not_found' };
}

export function describeResolution(ref: string | number, r: Resolved): string {
  if (r.ok) return fullName(r.user);
  if (r.reason === 'ambiguous') {
    return `"${ref}" matches ${r.candidates.length} people: ${r.candidates.map((c) => `${fullName(c)} (id ${c.id})`).join(', ')}. Say which one, or use the id.`;
  }
  return `"${ref}" is not a member of this group. Use a member's name or id.`;
}
