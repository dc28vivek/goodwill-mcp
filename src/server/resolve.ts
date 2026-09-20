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
export function resolveMember(group: { members: SwUser[] }, ref: string | number, meId: number): Resolved {
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

export type ResolvedGroup =
  | { ok: true; group: SwGroup }
  | { ok: false; reason: 'ambiguous'; candidates: SwGroup[] }
  | { ok: false; reason: 'not_found'; candidates: SwGroup[] };

/** Group 0 is Splitwise's bucket for non-group expenses, never a real group. */
const realGroups = (groups: SwGroup[]) => groups.filter((g) => g.id !== 0);

const groupName = (g: SwGroup) => (g.name ?? '').trim().toLowerCase();

/**
 * Turn "Deewani", "deewani", "lisbon" or a numeric id into a group.
 *
 * Every group-taking tool used to demand a numeric id. People do not know
 * their group ids and have no reason to: they say "Deewani". Tools already
 * took a person by name, so taking a group by name is the same idea finished.
 * Ids still work, because the model may well have one from list_groups.
 * See ADR-0019.
 */
export function resolveGroup(groups: SwGroup[], ref: string | number): ResolvedGroup {
  const real = realGroups(groups);
  // An id wins when one matches. When none does, a digits-only reference is
  // not necessarily an id: "2027" is a perfectly good way to mean "Lisbon
  // 2027", so it falls through to name matching rather than failing.
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
    const group = real.find((g) => g.id === Number(ref));
    if (group) return { ok: true, group };
    if (typeof ref === 'number') return { ok: false, reason: 'not_found', candidates: real };
  }
  const q = String(ref).trim().toLowerCase();

  const exact = real.filter((g) => groupName(g) === q);
  if (exact.length === 1) return { ok: true, group: exact[0]! };
  if (exact.length > 1) return { ok: false, reason: 'ambiguous', candidates: exact };

  const prefix = real.filter((g) => groupName(g).startsWith(q));
  if (prefix.length === 1) return { ok: true, group: prefix[0]! };
  if (prefix.length > 1) return { ok: false, reason: 'ambiguous', candidates: prefix };

  const contains = real.filter((g) => groupName(g).includes(q));
  if (contains.length === 1) return { ok: true, group: contains[0]! };
  if (contains.length > 1) return { ok: false, reason: 'ambiguous', candidates: contains };

  return { ok: false, reason: 'not_found', candidates: real };
}

/** Name the group, or list the real options rather than only refusing. */
export function describeGroupResolution(ref: string | number, r: ResolvedGroup): string {
  if (r.ok) return r.group.name;
  const listed = r.candidates
    .slice(0, 12)
    .map((g) => `${g.name} (id ${g.id})`)
    .join(', ');
  const more = r.candidates.length > 12 ? `, and ${r.candidates.length - 12} more` : '';
  if (r.reason === 'ambiguous') {
    return `"${ref}" matches ${r.candidates.length} groups: ${listed}${more}. Say which one, or use the id.`;
  }
  return r.candidates.length
    ? `There is no group called "${ref}". Your groups are: ${listed}${more}.`
    : `There is no group called "${ref}", and you are not in any groups.`;
}

/** Someone named for a new or existing group. */
export type Invitee =
  | { kind: 'existing'; user: SwUser }
  | { kind: 'invite'; firstName: string; lastName: string; email: string }
  | { kind: 'unresolved'; ref: string; reason: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAMED_EMAIL = /^(.+?)\s*<\s*([^\s<>]+@[^\s<>]+)\s*>$/;

function titleCase(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word;
}

/** Derive a usable first and last name from an email local part. */
function nameFromEmail(email: string): { firstName: string; lastName: string } {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._\-+]/).filter((p) => p && !/^\d+$/.test(p));
  return { firstName: titleCase(parts[0] ?? local) || 'Friend', lastName: parts.length > 1 ? titleCase(parts[parts.length - 1]!) : '' };
}

/**
 * Turn what a person said into either a known Splitwise user or a new
 * invitation.
 *
 * The distinction matters more than it looks. Naming an existing friend is
 * safe; an email address sends a real invitation to whoever owns it, and a
 * typo invites a stranger into a group where they will see everyone's
 * spending. The caller must show both kinds separately in its preview.
 *
 * Accepts: "Priya", "Priya Sharma", a numeric id, "priya@example.com", and
 * "Priya Sharma <priya@example.com>".
 */
export function resolveInvitee(ref: string, candidates: SwUser[], meId: number): Invitee {
  const trimmed = ref.trim();
  if (!trimmed) return { kind: 'unresolved', ref, reason: 'empty name' };

  const named = trimmed.match(NAMED_EMAIL);
  if (named) {
    const email = named[2]!.toLowerCase();
    if (!EMAIL.test(email)) return { kind: 'unresolved', ref, reason: `"${email}" is not a valid email address` };
    const existing = candidates.find((c) => c.email?.toLowerCase() === email);
    if (existing) return { kind: 'existing', user: existing };
    const words = named[1]!.trim().split(/\s+/);
    return { kind: 'invite', firstName: words[0] ?? 'Friend', lastName: words.slice(1).join(' '), email };
  }

  if (trimmed.includes('@')) {
    const email = trimmed.toLowerCase();
    if (!EMAIL.test(email)) return { kind: 'unresolved', ref, reason: `"${trimmed}" looks like an email address but is not valid` };
    const existing = candidates.find((c) => c.email?.toLowerCase() === email);
    if (existing) return { kind: 'existing', user: existing };
    return { kind: 'invite', email, ...nameFromEmail(email) };
  }

  const resolved = resolveMember({ members: candidates }, trimmed, meId);
  if (resolved.ok) return { kind: 'existing', user: resolved.user };
  return { kind: 'unresolved', ref, reason: describeResolution(trimmed, resolved) };
}
