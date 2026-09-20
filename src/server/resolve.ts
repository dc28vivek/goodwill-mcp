import type { SwUser } from '../splitwise/types.js';
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
