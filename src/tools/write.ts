import { type McpServer, acceptedContent, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type ExpenseLike, findDuplicates, fingerprint, toExpenseLike } from '../domain/dedupe.js';
import { ReceiptMismatch, splitByItems } from '../domain/items.js';
import { fromMinor, rescaleShares, splitEqual, toMinor } from '../domain/money.js';
import { parseExpenseSentence } from '../domain/parser.js';
import type { Deps, PendingWrite } from '../server/deps.js';
import { GROUP_URL, fail, fullName, joinNames, missingScope, ok, sentenceCase, timed, untrusted } from '../server/format.js';
import { type Invitee, describeResolution, resolveInvitee, resolveMember } from '../server/resolve.js';
import type { SwAddUserToGroup, SwCreateExpenseByShares, SwCreateGroup, SwExpense, SwUser } from '../splitwise/types.js';
import { AddExpenseOutput, AddMembersOutput, ConfirmSchema, GroupOutput, ItemSplitOutput, NudgeOutput, ReceiptItemInput, SettleOutputWrite, UpdateExpenseOutput } from './schemas.js';

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

/**
 * Every expense this connector creates or changes gets a comment saying so.
 *
 * Splitwise attributes an expense to the app that made it, but that is easy to
 * miss. A comment is visible to everyone on the expense and says plainly that
 * an agent did this, which is the same principle as previewing a write to the
 * person confirming it: the people whose balances moved should be able to tell
 * where the change came from.
 */
const SIGNATURE = 'Added by Goodwill MCP.';

/**
 * Post the trail comment. Never fails the write: the expense already exists by
 * this point, and losing the note is much better than reporting failure for
 * something that succeeded.
 */
async function annotate(deps: Deps, expenseId: number, what: string): Promise<boolean> {
  try {
    await deps.client.createComment(expenseId, `${what} ${SIGNATURE}`);
    return true;
  } catch {
    return false;
  }
}

interface AddPayload {
  body: SwCreateExpenseByShares;
  description: string;
  cost: string;
  currency: string;
  affected: string[];
  preview: string;
}

interface NudgePayload {
  expenseId: number;
  content: string;
  toName: string;
}

interface UpdatePayload {
  expenseId: number;
  body: Partial<SwCreateExpenseByShares>;
  changes: { field: string; from: string; to: string }[];
  balanceChanges: { person: { id: number; name: string }; from: string; to: string }[];
  description: string;
}

interface GroupPayload {
  body: SwCreateGroup;
  name: string;
  groupType: string;
  members: { name: string; status: 'already_on_splitwise' | 'invited' }[];
}

interface AddMembersPayload {
  groupId: number;
  groupName: string;
  additions: { body: SwAddUserToGroup; name: string; status: 'already_on_splitwise' | 'invited' }[];
}

interface SettlePayload {
  body: SwCreateExpenseByShares;
  fromName: string;
  toName: string;
  amount: string;
  currency: string;
}

interface ItemSplitPayload {
  body: SwCreateExpenseByShares;
  description: string;
  total: string;
  currency: string;
  breakdown: { person: { id: number; name: string }; items: string; extras: string; owes: string }[];
}

/** Was the confirmation declined or cancelled (as opposed to missing)? */
function declined(responses: Record<string, unknown> | undefined): boolean {
  const view = inputResponse(responses, 'confirm');
  return view.kind === 'elicit' && view.action !== 'accept';
}

function localDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function registerWriteTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'add_expense',
    {
      title: 'Add an expense',
      description:
        'Add a shared expense to a group from a sentence ("dinner 84, I paid, split with everyone") or from explicit fields. Step 1 returns a preview naming everyone whose balance changes and asks for confirmation. Nothing is posted until the user confirms. Checks for likely duplicates first. Equal split only in this version; give participants to limit who shares it. Posts a comment on the expense noting that Goodwill MCP created it, so the group can see where it came from.',
      inputSchema: z.object({
        group_id: z.number().int().describe('Group to post into. See splitwise://groups.'),
        text: z.string().max(300).optional().describe('A sentence like "taxi 16 paid by Sam split with me and Sam".'),
        description: z.string().max(120).optional().describe('Overrides the description parsed from text.'),
        cost: z.string().optional().describe('Decimal string like "84.00". Overrides text.'),
        currency: z.string().length(3).optional().describe('ISO code. Defaults to your Splitwise default currency.'),
        payer: z.string().optional().describe('"me" or a member name or id. Defaults to me.'),
        participants: z.array(z.string()).optional().describe('Member names or ids who share the cost. Defaults to everyone in the group.'),
        date: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
        category_id: z.number().int().optional().describe('From splitwise://categories.'),
        idempotency_key: z.string().max(64).optional().describe('Repeat the same key to retry safely without a second post.'),
      }),
      outputSchema: AddExpenseOutput,
      annotations: WRITE,
    },
    timed(deps.metrics, 'add_expense', async (args, ctx) => {
      const denied = missingScope(ctx, 'add');
      if (denied) return denied;
      const me = await deps.me();
      const pending = ctx.mcpReq.requestState<PendingWrite>();

      // Round 2: the client came back with an answer.
      if (pending && pending.kind === 'add_expense') {
        if (pending.userId !== me.id) return fail('This confirmation belongs to a different Splitwise account. Start again.');
        const payload = pending.payload as AddPayload;
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
        if (!answer || answer.confirm !== true || declined(ctx.mcpReq.inputResponses)) {
          deps.metrics.emit({ type: 'preview_declined', tool: 'add_expense' });
          return ok('Cancelled. Nothing was posted.', { posted: false, group_id: args.group_id, note: 'Cancelled by the user.' });
        }
        deps.metrics.emit({ type: 'preview_confirmed', tool: 'add_expense' });
        const existing = await deps.writeLog.find(String(me.id), pending.fingerprint, pending.idempotencyKey);
        if (existing) {
          deps.metrics.emit({ type: 'duplicate_blocked', tool: 'add_expense', source: 'write_log' });
          return ok(`Already posted as expense #${existing.expenseId} ("${existing.description}"). Nothing new was created.`, {
            posted: false,
            expense_id: existing.expenseId,
            group_id: args.group_id,
            note: 'A matching expense was posted in the last 48 hours. Refused to post again.',
          });
        }
        const created = await deps.client.createExpense(payload.body);
        deps.metrics.emit({ type: 'write_posted', tool: 'add_expense' });
        await annotate(deps, created.id, `${payload.description}, ${payload.cost} ${payload.currency}, split with ${payload.affected.length + 1} ${payload.affected.length === 0 ? 'person' : 'people'}.`);
        await deps.writeLog.record(String(me.id), {
          fingerprint: pending.fingerprint,
          ...(pending.idempotencyKey ? { idempotencyKey: pending.idempotencyKey } : {}),
          expenseId: created.id,
          createdAt: deps.now().toISOString(),
          description: payload.description,
        });
        return ok(`Posted "${payload.description}" ${payload.cost} ${payload.currency} as expense #${created.id}. ${GROUP_URL(args.group_id)}`, {
          posted: true,
          expense_id: created.id,
          group_id: args.group_id,
          description: payload.description,
          cost: payload.cost,
          currency: payload.currency,
          affected: payload.affected,
          note: 'Posted. Everyone in the split can see it in Splitwise.',
        });
      }

      // Round 1: build the proposal.
      const group = await deps.group(args.group_id);
      const parsed = args.text ? parseExpenseSentence(args.text, deps.now()) : null;
      const description = untrusted(args.description ?? parsed?.description ?? '', 120);
      const costText = args.cost ?? parsed?.cost;
      const currency = (args.currency ?? parsed?.currency ?? me.default_currency ?? 'USD').toUpperCase();
      const date = args.date ?? parsed?.date ?? localDate(deps.now());

      const missing: string[] = [];
      if (!description) missing.push('description');
      if (!costText) missing.push('cost');
      if (missing.length) return fail(`I need the ${joinNames(missing)}. Example: text "dinner 84, I paid, split with everyone".`);

      let costMinor: number;
      try {
        costMinor = toMinor(costText!);
      } catch {
        return fail(`"${costText}" is not an amount. Use a decimal like "84.00".`);
      }
      if (costMinor <= 0) return fail('The cost must be greater than zero.');

      const payerRef = args.payer ?? parsed?.payer ?? 'me';
      const payerRes = resolveMember(group, payerRef, me.id);
      if (!payerRes.ok) return fail(describeResolution(payerRef, payerRes));
      const payer = payerRes.user;

      const partRefs = args.participants ?? (parsed?.participants === 'everyone' || !parsed?.participants ? 'everyone' : parsed.participants);
      let participants: SwUser[];
      if (partRefs === 'everyone') {
        participants = group.members;
      } else {
        participants = [];
        for (const ref of partRefs) {
          const r = resolveMember(group, ref, me.id);
          if (!r.ok) return fail(describeResolution(ref, r));
          participants.push(r.user);
        }
      }
      if (participants.length === 0) return fail('Nobody to split with. Name the participants or leave it empty for everyone.');

      const { shares } = splitEqual(costMinor, participants.map((p) => p.id), payer.id);
      const everyone = new Map<number, SwUser>(participants.map((p) => [p.id, p]));
      everyone.set(payer.id, payer);

      const body: SwCreateExpenseByShares = {
        cost: fromMinor(costMinor),
        description,
        group_id: group.id,
        currency_code: currency,
        date: `${date}T12:00:00Z`,
        ...(args.category_id !== undefined ? { category_id: args.category_id } : {}),
      };
      let i = 0;
      for (const [id] of everyone) {
        body[`users__${i}__user_id`] = id;
        body[`users__${i}__paid_share`] = id === payer.id ? fromMinor(costMinor) : '0.00';
        body[`users__${i}__owed_share`] = fromMinor(shares.get(id) ?? 0);
        i += 1;
      }

      const candidate: ExpenseLike = { description, cost: fromMinor(costMinor), currency_code: currency, date: `${date}T12:00:00Z`, payerId: payer.id };
      const fp = fingerprint(group.id, candidate);

      const already = await deps.writeLog.find(String(me.id), fp, args.idempotency_key);
      if (already) {
        deps.metrics.emit({ type: 'duplicate_blocked', tool: 'add_expense', source: 'write_log' });
        return ok(`Already posted as expense #${already.expenseId} ("${already.description}") within the last 48 hours. Nothing new was created.`, {
          posted: false,
          expense_id: already.expenseId,
          group_id: group.id,
          note: 'Duplicate of a recent post from this connector. Refused.',
        });
      }

      const windowStart = new Date(new Date(`${date}T12:00:00Z`).getTime() - 3 * 86_400_000).toISOString();
      const windowEnd = new Date(new Date(`${date}T12:00:00Z`).getTime() + 3 * 86_400_000).toISOString();
      const nearby: SwExpense[] = await deps.client.expenses({ group_id: group.id, dated_after: windowStart, dated_before: windowEnd, limit: 100 });
      const dupes = findDuplicates(candidate, nearby.filter((e) => !e.deleted_at && !e.payment).map(toExpenseLike));

      const affected = [...everyone.values()].filter((u) => u.id !== me.id).map((u) => fullName(u));
      const shareLines = [...shares.entries()].map(([id, minor]) => `${fullName(everyone.get(id))} ${fromMinor(minor)}`).join(', ');
      let preview = `Add "${description}" for ${fromMinor(costMinor)} ${currency} to ${untrusted(group.name, 60)} on ${date}. ${fullName(payer)} paid. Split: ${shareLines}.`;
      preview += affected.length ? ` This changes what ${joinNames(affected)} owe.` : '';
      if (dupes.length) {
        const d = dupes[0]!;
        preview += ` Possible duplicate: #${d.existing.id} "${untrusted(d.existing.description, 60)}" ${d.existing.cost} ${d.existing.currency_code} on ${d.existing.date.slice(0, 10)} (${Math.round(d.confidence * 100)}%: ${d.reasons.join(', ')}).`;
      }
      preview += ` It will carry a comment saying ${SIGNATURE.replace(/\.$/, '')}, so the group can see where it came from.`;

      if (dupes.length) deps.metrics.emit({ type: 'duplicate_blocked', tool: 'add_expense', source: 'splitwise' });
      deps.metrics.emit({ type: 'preview_shown', tool: 'add_expense' });
      const payload: AddPayload = { body, description, cost: fromMinor(costMinor), currency, affected, preview };
      const state = await deps.codec.mint({
        kind: 'add_expense',
        userId: me.id,
        fingerprint: fp,
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
        payload,
      });
      return inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({ message: `${preview} Post it?`, requestedSchema: ConfirmSchema }),
        },
        requestState: state,
      });
    }),
  );

  server.registerTool(
    'update_expense',
    {
      title: 'Correct an expense',
      description:
        'Fix an expense that is already in Splitwise: a wrong amount, a typo in the description, the wrong date or category. Other people have already seen it, so the preview shows the current values next to the new ones and what each person\'s share becomes. Changing the cost keeps the split everyone agreed to, rescaled in proportion. It posts a comment saying what was corrected and that Goodwill MCP did it. This cannot add or remove people, change who paid, or turn an expense into a payment; do those in the Splitwise app.',
      inputSchema: z.object({
        expense_id: z.number().int().describe('From list_expenses or read_expense.'),
        description: z.string().max(120).optional(),
        cost: z.string().optional().describe('Decimal string. Shares are rescaled in proportion.'),
        date: z.string().optional().describe('YYYY-MM-DD.'),
        category_id: z.number().int().optional(),
        notes: z.string().max(300).optional(),
        idempotency_key: z.string().max(64).optional(),
      }),
      outputSchema: UpdateExpenseOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    timed(deps.metrics, 'update_expense', async (args, ctx) => {
      const denied = missingScope(ctx, 'modify');
      if (denied) return denied;
      const me = await deps.me();
      const pending = ctx.mcpReq.requestState<PendingWrite>();

      if (pending && pending.kind === 'update_expense') {
        if (pending.userId !== me.id) return fail('This confirmation belongs to a different Splitwise account. Start again.');
        const payload = pending.payload as UpdatePayload;
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
        if (!answer || answer.confirm !== true || declined(ctx.mcpReq.inputResponses)) {
          deps.metrics.emit({ type: 'preview_declined', tool: 'update_expense' });
          return ok('Cancelled. The expense is unchanged.', { updated: false, expense_id: payload.expenseId, note: 'Cancelled by the user.' });
        }
        deps.metrics.emit({ type: 'preview_confirmed', tool: 'update_expense' });
        const existing = await deps.writeLog.find(String(me.id), pending.fingerprint, pending.idempotencyKey);
        if (existing) {
          deps.metrics.emit({ type: 'duplicate_blocked', tool: 'update_expense', source: 'write_log' });
          return ok(`That correction was already applied to #${payload.expenseId}. Nothing was changed again.`, {
            updated: false,
            expense_id: payload.expenseId,
            note: 'The same correction was applied in the last 48 hours. Refused to repeat it.',
          });
        }
        await deps.client.updateExpense(payload.expenseId, payload.body);
        deps.metrics.emit({ type: 'write_posted', tool: 'update_expense' });
        await annotate(deps, payload.expenseId, `Corrected: ${payload.changes.map((c) => `${c.field} ${c.from} to ${c.to}`).join('; ')}.`);
        await deps.writeLog.record(String(me.id), {
          fingerprint: pending.fingerprint,
          ...(pending.idempotencyKey ? { idempotencyKey: pending.idempotencyKey } : {}),
          expenseId: payload.expenseId,
          createdAt: deps.now().toISOString(),
          description: payload.description,
        });
        return ok(
          [`Updated #${payload.expenseId} "${payload.description}".`, ...payload.changes.map((c) => `  ${c.field}: ${c.from} -> ${c.to}`)].join('\n'),
          { updated: true, expense_id: payload.expenseId, changes: payload.changes, balance_changes: payload.balanceChanges, note: 'Updated. Everyone on the expense sees the new values.' },
        );
      }

      // Round 1: read the current state. Refuse rather than guess.
      if (args.description === undefined && args.cost === undefined && args.date === undefined && args.category_id === undefined && args.notes === undefined) {
        return fail('Nothing to change. Give at least one of description, cost, date, category_id or notes.');
      }
      let current;
      try {
        current = await deps.client.expense(args.expense_id);
      } catch {
        return fail(`No expense #${args.expense_id}, or you cannot see it. Use list_expenses to find the right id.`);
      }
      if (current.deleted_at) return fail(`Expense #${args.expense_id} was deleted. Restore it in the Splitwise app first.`);
      if (current.payment) return fail(`#${args.expense_id} is a settle-up payment, not an expense. This tool does not change payments.`);

      const body: Partial<SwCreateExpenseByShares> = {};
      const changes: UpdatePayload['changes'] = [];
      const oldDescription = untrusted(current.description, 120);

      if (args.description !== undefined && untrusted(args.description, 120) !== oldDescription) {
        body.description = untrusted(args.description, 120);
        changes.push({ field: 'description', from: oldDescription, to: body.description });
      }
      if (args.date !== undefined && args.date !== current.date.slice(0, 10)) {
        body.date = `${args.date}T12:00:00Z`;
        changes.push({ field: 'date', from: current.date.slice(0, 10), to: args.date });
      }
      if (args.category_id !== undefined && args.category_id !== current.category?.id) {
        body.category_id = args.category_id;
        changes.push({ field: 'category', from: untrusted(current.category?.name ?? 'none', 40), to: `id ${args.category_id}` });
      }
      if (args.notes !== undefined && args.notes !== (current.details ?? '')) {
        body.details = untrusted(args.notes, 300);
        changes.push({ field: 'notes', from: untrusted(current.details ?? '(none)', 60), to: untrusted(args.notes, 60) });
      }

      const balanceChanges: UpdatePayload['balanceChanges'] = [];
      if (args.cost !== undefined) {
        let newCost: number;
        try {
          newCost = toMinor(args.cost);
        } catch {
          return fail(`"${args.cost}" is not an amount. Use a decimal like "90.00".`);
        }
        if (newCost <= 0) return fail('The cost must be greater than zero.');
        const oldCost = toMinor(current.cost);
        if (newCost !== oldCost) {
          changes.push({ field: 'cost', from: fromMinor(oldCost), to: fromMinor(newCost) });
          body.cost = fromMinor(newCost);
          // Supplying any share field overwrites all of them, so every share is
          // rebuilt, rescaled by the proportion each person already had.
          const owed = new Map(current.users.map((u) => [u.user_id, toMinor(u.owed_share)]));
          const paid = new Map(current.users.map((u) => [u.user_id, toMinor(u.paid_share)]));
          const newOwed = rescaleShares(owed, newCost);
          const newPaid = rescaleShares(paid, newCost);
          let i = 0;
          for (const u of current.users) {
            const to = newOwed.get(u.user_id) ?? 0;
            body[`users__${i}__user_id`] = u.user_id;
            body[`users__${i}__paid_share`] = fromMinor(newPaid.get(u.user_id) ?? 0);
            body[`users__${i}__owed_share`] = fromMinor(to);
            const from = owed.get(u.user_id) ?? 0;
            if (from !== to) balanceChanges.push({ person: { id: u.user_id, name: fullName(u.user) }, from: fromMinor(from), to: fromMinor(to) });
            i += 1;
          }
        }
      }

      if (changes.length === 0) return ok('Nothing to change; the expense already has those values.', { updated: false, expense_id: args.expense_id, note: 'No difference between the current and requested values.' });

      const fp = `update|${args.expense_id}|${changes.map((c) => `${c.field}=${c.to}`).sort().join(',')}`;
      const already = await deps.writeLog.find(String(me.id), fp, args.idempotency_key);
      if (already) {
        deps.metrics.emit({ type: 'duplicate_blocked', tool: 'update_expense', source: 'write_log' });
        return ok(`That correction was already applied to #${args.expense_id} within the last 48 hours.`, { updated: false, expense_id: args.expense_id, note: 'Duplicate correction. Refused.' });
      }

      const others = balanceChanges.filter((b) => b.person.id !== me.id);
      const preview = [
        `Change expense #${args.expense_id} "${oldDescription}", which everyone on it can already see:`,
        ...changes.map((c) => `  ${c.field}: ${c.from} -> ${c.to}`),
        ...(balanceChanges.length ? ['', 'Shares become:', ...balanceChanges.map((b) => `  ${b.person.name}: ${b.from} -> ${b.to}`)] : []),
        ...(others.length ? ['', `This changes what ${joinNames(others.map((b) => b.person.name))} owe.`] : []),
        '',
        `A comment saying ${SIGNATURE.replace(/\.$/, '')} will be posted on it.`,
      ].join('\n');

      deps.metrics.emit({ type: 'preview_shown', tool: 'update_expense' });
      const payload: UpdatePayload = { expenseId: args.expense_id, body, changes, balanceChanges, description: body.description ?? oldDescription };
      const state = await deps.codec.mint({
        kind: 'update_expense',
        userId: me.id,
        fingerprint: fp,
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
        payload,
      });
      return inputRequired({
        inputRequests: { confirm: inputRequired.elicit({ message: `${preview}\n\nApply it?`, requestedSchema: ConfirmSchema }) },
        requestState: state,
      });
    }),
  );

  server.registerTool(
    'create_group',
    {
      title: 'Create a group',
      description:
        'Create a new Splitwise group and optionally add people to it. Name people who are already your Splitwise friends by name; invite anyone else with an email address. Shows a preview separating the two, because an email sends a real invitation, and waits for confirmation. Use this before add_expense when the group does not exist yet.',
      inputSchema: z.object({
        name: z.string().min(1).max(80).describe('What the group is called, e.g. "Goa Trip".'),
        group_type: z.enum(['trip', 'home', 'couple', 'other']).default('other').describe('Use "home" for flatmates.'),
        members: z.array(z.string().max(120)).max(50).default([]).describe('Friend names, or email addresses to invite someone new. "Priya Sharma <priya@example.com>" works too. You are added automatically.'),
        simplify_by_default: z.boolean().optional().describe('Turn on Splitwise debt simplification for this group.'),
        idempotency_key: z.string().max(64).optional(),
      }),
      outputSchema: GroupOutput,
      annotations: WRITE,
    },
    timed(deps.metrics, 'create_group', async (args, ctx) => {
      const denied = missingScope(ctx, 'add');
      if (denied) return denied;
      const me = await deps.me();
      const pending = ctx.mcpReq.requestState<PendingWrite>();

      if (pending && pending.kind === 'create_group') {
        if (pending.userId !== me.id) return fail('This confirmation belongs to a different Splitwise account. Start again.');
        const payload = pending.payload as GroupPayload;
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
        if (!answer || answer.confirm !== true || declined(ctx.mcpReq.inputResponses)) {
          deps.metrics.emit({ type: 'preview_declined', tool: 'create_group' });
          return ok('Cancelled. No group was created.', { created: false, note: 'Cancelled by the user.' });
        }
        deps.metrics.emit({ type: 'preview_confirmed', tool: 'create_group' });
        const existing = await deps.writeLog.find(String(me.id), pending.fingerprint, pending.idempotencyKey);
        if (existing) {
          deps.metrics.emit({ type: 'duplicate_blocked', tool: 'create_group', source: 'write_log' });
          return ok(`A group called "${payload.name}" was already created (#${existing.expenseId}). Nothing new was created.`, {
            created: false,
            group_id: existing.expenseId,
            note: 'A matching group was created in the last 48 hours. Refused to create it again.',
          });
        }
        const group = await deps.client.createGroup(payload.body);
        deps.metrics.emit({ type: 'write_posted', tool: 'create_group' });
        await deps.writeLog.record(String(me.id), {
          fingerprint: pending.fingerprint,
          ...(pending.idempotencyKey ? { idempotencyKey: pending.idempotencyKey } : {}),
          expenseId: group.id,
          createdAt: deps.now().toISOString(),
          description: payload.name,
        });
        const invited = payload.members.filter((m) => m.status === 'invited').length;
        return ok(
          `Created "${payload.name}" (${payload.groupType}) with ${payload.members.length} other ${payload.members.length === 1 ? 'person' : 'people'}${invited ? `, ${invited} of whom will get an invitation email` : ''}. ${GROUP_URL(group.id)}`,
          { created: true, group_id: group.id, name: payload.name, group_type: payload.groupType, url: GROUP_URL(group.id), members: payload.members, note: 'Created. Add expenses to it with add_expense.' },
        );
      }

      // Round 1.
      const name = untrusted(args.name, 80);
      const friends = await deps.client.friends();
      const resolved: Invitee[] = args.members.map((ref) => resolveInvitee(ref, friends, me.id));
      const bad = resolved.filter((r): r is Extract<Invitee, { kind: 'unresolved' }> => r.kind === 'unresolved');
      if (bad.length) {
        return fail(
          `Could not work out who ${bad.length === 1 ? 'this is' : 'these are'}:\n${bad.map((b) => `  "${untrusted(b.ref, 60)}": ${b.reason}`).join('\n')}\nGive an email address to invite someone who is not already your friend on Splitwise. Nothing was created.`,
        );
      }

      const body: SwCreateGroup = { name, group_type: args.group_type };
      if (args.simplify_by_default !== undefined) body.simplify_by_default = args.simplify_by_default;
      const members: GroupPayload['members'] = [];
      let i = 0;
      for (const r of resolved) {
        if (r.kind === 'existing') {
          if (r.user.id === me.id) continue;
          body[`users__${i}__user_id`] = r.user.id;
          members.push({ name: fullName(r.user), status: 'already_on_splitwise' });
        } else if (r.kind === 'invite') {
          body[`users__${i}__first_name`] = r.firstName;
          if (r.lastName) body[`users__${i}__last_name`] = r.lastName;
          body[`users__${i}__email`] = r.email;
          members.push({ name: `${[r.firstName, r.lastName].filter(Boolean).join(' ')} <${r.email}>`, status: 'invited' });
        }
        i += 1;
      }

      const fp = `group|${me.id}|${name.toLowerCase()}|${members.map((m) => m.name).sort().join(',')}`;
      const already = await deps.writeLog.find(String(me.id), fp, args.idempotency_key);
      if (already) {
        deps.metrics.emit({ type: 'duplicate_blocked', tool: 'create_group', source: 'write_log' });
        return ok(`"${name}" was already created (#${already.expenseId}) within the last 48 hours. Nothing new was created.`, {
          created: false,
          group_id: already.expenseId,
          note: 'Duplicate of a recent group created by this connector. Refused.',
        });
      }

      const known = members.filter((m) => m.status === 'already_on_splitwise');
      const invites = members.filter((m) => m.status === 'invited');
      const lines = [`Create a ${args.group_type} group called "${name}" with you in it.`];
      if (known.length) lines.push(`  Adding, already on Splitwise: ${known.map((m) => m.name).join(', ')}`);
      if (invites.length) lines.push(`  Inviting by email (they will receive a real invitation): ${invites.map((m) => m.name).join(', ')}`);
      if (!members.length) lines.push('  Nobody else yet. You can add people later with add_to_group.');

      deps.metrics.emit({ type: 'preview_shown', tool: 'create_group' });
      const payload: GroupPayload = { body, name, groupType: args.group_type, members };
      const state = await deps.codec.mint({
        kind: 'create_group',
        userId: me.id,
        fingerprint: fp,
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
        payload,
      });
      return inputRequired({
        inputRequests: { confirm: inputRequired.elicit({ message: `${lines.join('\n')}\n\nCreate it?`, requestedSchema: ConfirmSchema }) },
        requestState: state,
      });
    }),
  );

  server.registerTool(
    'add_to_group',
    {
      title: 'Add people to a group',
      description:
        'Add one or more people to an existing Splitwise group. Name existing friends, or give an email address to invite someone new. Anyone already in the group is skipped. Shows a preview and waits for confirmation, because an email sends a real invitation and everyone added can see the whole group history. This connector cannot remove anyone; do that in the Splitwise app.',
      inputSchema: z.object({
        group_id: z.number().int(),
        members: z.array(z.string().max(120)).min(1).max(50).describe('Friend names, or email addresses to invite someone new.'),
      }),
      outputSchema: AddMembersOutput,
      annotations: WRITE,
    },
    timed(deps.metrics, 'add_to_group', async (args, ctx) => {
      const denied = missingScope(ctx, 'add');
      if (denied) return denied;
      const me = await deps.me();
      const pending = ctx.mcpReq.requestState<PendingWrite>();

      if (pending && pending.kind === 'add_to_group') {
        if (pending.userId !== me.id) return fail('This confirmation belongs to a different Splitwise account. Start again.');
        const payload = pending.payload as AddMembersPayload;
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
        if (!answer || answer.confirm !== true || declined(ctx.mcpReq.inputResponses)) {
          deps.metrics.emit({ type: 'preview_declined', tool: 'add_to_group' });
          return ok('Cancelled. Nobody was added.', { added: false, group_id: payload.groupId, note: 'Cancelled by the user.' });
        }
        deps.metrics.emit({ type: 'preview_confirmed', tool: 'add_to_group' });
        // One call per person, so a failure halfway leaves the earlier ones
        // added. Report per person rather than pretending it was atomic.
        const results: { name: string; status: 'already_on_splitwise' | 'invited' | 'failed'; detail?: string }[] = [];
        for (const addition of payload.additions) {
          try {
            await deps.client.addUserToGroup(addition.body);
            results.push({ name: addition.name, status: addition.status });
          } catch (err) {
            results.push({ name: addition.name, status: 'failed', detail: (err as Error).message });
          }
        }
        const failed = results.filter((r) => r.status === 'failed');
        if (results.some((r) => r.status !== 'failed')) deps.metrics.emit({ type: 'write_posted', tool: 'add_to_group' });
        const summary = results.filter((r) => r.status !== 'failed').map((r) => r.name);
        return ok(
          [
            summary.length ? `Added to "${payload.groupName}": ${summary.join(', ')}.` : `Nobody was added to "${payload.groupName}".`,
            ...failed.map((f) => `Failed for ${f.name}: ${f.detail}`),
          ].join('\n'),
          { added: summary.length > 0, group_id: payload.groupId, group_name: payload.groupName, members: results, note: failed.length ? 'Some additions failed; see the list.' : 'Everyone named was added.' },
        );
      }

      // Round 1.
      const group = await deps.group(args.group_id);
      const friends = await deps.client.friends();
      const alreadyIn = new Set(group.members.map((m) => m.id));
      // Anyone who is both a friend and a member would otherwise appear twice
      // and resolve as ambiguous, so dedupe by id before matching names.
      const candidates = [...new Map([...friends, ...group.members].map((u) => [u.id, u])).values()];
      const resolved = args.members.map((ref) => ({ ref, r: resolveInvitee(ref, candidates, me.id) }));
      const bad = resolved.filter((x) => x.r.kind === 'unresolved');
      if (bad.length) {
        return fail(
          `Could not work out who ${bad.length === 1 ? 'this is' : 'these are'}:\n${bad.map((b) => `  "${untrusted(b.ref, 60)}": ${(b.r as { reason: string }).reason}`).join('\n')}\nGive an email address to invite someone new. Nobody was added.`,
        );
      }

      const additions: AddMembersPayload['additions'] = [];
      const skipped: string[] = [];
      for (const { r } of resolved) {
        if (r.kind === 'existing') {
          if (alreadyIn.has(r.user.id)) {
            skipped.push(fullName(r.user));
            continue;
          }
          additions.push({ body: { group_id: group.id, user_id: r.user.id }, name: fullName(r.user), status: 'already_on_splitwise' });
        } else if (r.kind === 'invite') {
          additions.push({
            body: { group_id: group.id, first_name: r.firstName, last_name: r.lastName || r.firstName, email: r.email },
            name: `${[r.firstName, r.lastName].filter(Boolean).join(' ')} <${r.email}>`,
            status: 'invited',
          });
        }
      }

      if (!additions.length) {
        return ok(
          skipped.length ? `${joinNames(skipped)} ${skipped.length === 1 ? 'is' : 'are'} already in "${untrusted(group.name, 60)}". Nobody to add.` : 'Nobody to add.',
          { added: false, group_id: group.id, group_name: untrusted(group.name, 60), note: 'Everyone named is already in the group.' },
        );
      }

      const known = additions.filter((a) => a.status === 'already_on_splitwise');
      const invites = additions.filter((a) => a.status === 'invited');
      const lines = [`Add ${additions.length} ${additions.length === 1 ? 'person' : 'people'} to "${untrusted(group.name, 60)}", which has ${group.members.length} ${group.members.length === 1 ? 'member' : 'members'} today. They will see the group's whole expense history.`];
      if (known.length) lines.push(`  Already on Splitwise: ${known.map((a) => a.name).join(', ')}`);
      if (invites.length) lines.push(`  Inviting by email (they will receive a real invitation): ${invites.map((a) => a.name).join(', ')}`);
      if (skipped.length) lines.push(`  Skipping, already in the group: ${skipped.join(', ')}`);

      deps.metrics.emit({ type: 'preview_shown', tool: 'add_to_group' });
      const payload: AddMembersPayload = { groupId: group.id, groupName: untrusted(group.name, 60), additions };
      const state = await deps.codec.mint({ kind: 'add_to_group', userId: me.id, fingerprint: `addto|${group.id}|${additions.map((a) => a.name).sort().join(',')}`, payload });
      return inputRequired({
        inputRequests: { confirm: inputRequired.elicit({ message: `${lines.join('\n')}\n\nAdd them?`, requestedSchema: ConfirmSchema }) },
        requestState: state,
      });
    }),
  );

  server.registerTool(
    'split_by_items',
    {
      title: 'Split a receipt by item',
      description:
        'Split a bill line by line instead of equally, so everyone pays for what they ordered. Read the receipt yourself (from a photo, a PDF or text the user pasted) and pass the lines in as `items`, each with who shares it. Tax and tip are allocated in proportion to what each person ordered, not split equally. Pass `total` from the receipt and the tool will refuse to post if the lines do not add up, which catches a misread photo before it becomes five wrong balances. Shows a preview and waits for confirmation, and posts a comment noting that Goodwill MCP created it.',
      inputSchema: z.object({
        group_id: z.number().int(),
        description: z.string().max(120).describe('What the bill was, e.g. "Dinner at Cervejaria".'),
        items: z.array(ReceiptItemInput).min(1).max(100),
        tax: z.string().optional().describe('Tax as printed. Allocated in proportion to each person\'s items.'),
        tip: z.string().optional().describe('Tip as printed. Allocated the same way.'),
        total: z.string().optional().describe('The printed grand total. Strongly recommended: it is the check that the receipt was read correctly.'),
        currency: z.string().length(3).optional(),
        payer: z.string().optional().describe('"me" or a member name or id. Defaults to me.'),
        date: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
        category_id: z.number().int().optional(),
        idempotency_key: z.string().max(64).optional(),
      }),
      outputSchema: ItemSplitOutput,
      annotations: WRITE,
    },
    timed(deps.metrics, 'split_by_items', async (args, ctx) => {
      const denied = missingScope(ctx, 'add');
      if (denied) return denied;
      const me = await deps.me();
      const pending = ctx.mcpReq.requestState<PendingWrite>();

      if (pending && pending.kind === 'split_by_items') {
        if (pending.userId !== me.id) return fail('This confirmation belongs to a different Splitwise account. Start again.');
        const payload = pending.payload as ItemSplitPayload;
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
        if (!answer || answer.confirm !== true || declined(ctx.mcpReq.inputResponses)) {
          deps.metrics.emit({ type: 'preview_declined', tool: 'split_by_items' });
          return ok('Cancelled. Nothing was posted.', { posted: false, group_id: args.group_id, note: 'Cancelled by the user.' });
        }
        deps.metrics.emit({ type: 'preview_confirmed', tool: 'split_by_items' });
        const existing = await deps.writeLog.find(String(me.id), pending.fingerprint, pending.idempotencyKey);
        if (existing) {
          deps.metrics.emit({ type: 'duplicate_blocked', tool: 'split_by_items', source: 'write_log' });
          return ok(`Already posted as expense #${existing.expenseId}. Nothing new was created.`, {
            posted: false,
            expense_id: existing.expenseId,
            group_id: args.group_id,
            note: 'A matching expense was posted in the last 48 hours. Refused to post again.',
          });
        }
        const created = await deps.client.createExpense(payload.body);
        deps.metrics.emit({ type: 'write_posted', tool: 'split_by_items' });
        await annotate(deps, created.id, `Split by item: ${payload.breakdown.map((b) => `${b.person.name} ${b.owes}`).join(', ')}.`);
        await deps.writeLog.record(String(me.id), {
          fingerprint: pending.fingerprint,
          ...(pending.idempotencyKey ? { idempotencyKey: pending.idempotencyKey } : {}),
          expenseId: created.id,
          createdAt: deps.now().toISOString(),
          description: payload.description,
        });
        return ok(`Posted "${payload.description}" ${payload.total} ${payload.currency} as expense #${created.id}, split by item. ${GROUP_URL(args.group_id)}`, {
          posted: true,
          expense_id: created.id,
          group_id: args.group_id,
          total: payload.total,
          currency: payload.currency,
          breakdown: payload.breakdown,
          note: 'Posted. Everyone in the split can see it in Splitwise.',
        });
      }

      // Round 1.
      const group = await deps.group(args.group_id);
      const currency = (args.currency ?? me.default_currency ?? 'USD').toUpperCase();
      const description = untrusted(args.description, 120);
      const date = args.date ?? localDate(deps.now());

      const payerRes = resolveMember(group, args.payer ?? 'me', me.id);
      if (!payerRes.ok) return fail(describeResolution(args.payer ?? 'me', payerRes));
      const payer = payerRes.user;

      // Resolve every name on every line, so a typo fails before any maths.
      const byId = new Map<number, SwUser>();
      const lines = [];
      for (const item of args.items) {
        const ids: number[] = [];
        for (const ref of item.shared_by) {
          if (/^(everyone|everybody|all|the group)$/i.test(ref.trim())) {
            for (const m of group.members) {
              byId.set(m.id, m);
              ids.push(m.id);
            }
            continue;
          }
          const r = resolveMember(group, ref, me.id);
          if (!r.ok) return fail(`On line "${untrusted(item.description, 60)}": ${describeResolution(ref, r)}`);
          byId.set(r.user.id, r.user);
          ids.push(r.user.id);
        }
        lines.push({ description: untrusted(item.description, 120), amount: item.amount, sharedBy: ids });
      }

      let split;
      try {
        split = splitByItems(lines, {
          ...(args.tax !== undefined ? { tax: args.tax } : {}),
          ...(args.tip !== undefined ? { tip: args.tip } : {}),
          ...(args.total !== undefined ? { statedTotal: args.total } : {}),
        });
      } catch (err) {
        if (err instanceof ReceiptMismatch) {
          return fail(
            `The lines do not add up to the printed total. Items come to ${fromMinor(err.itemsTotal)}, plus ${fromMinor(err.extras)} tax and tip, which is ${fromMinor(err.itemsTotal + err.extras)} ${currency}, but the receipt says ${fromMinor(err.stated)} ${currency}. Re-read the receipt and check for a missed line or a misread digit. Nothing was posted.`,
          );
        }
        return fail(`${(err as Error).message}. Nothing was posted.`);
      }

      byId.set(payer.id, payer);
      const body: SwCreateExpenseByShares = {
        cost: fromMinor(split.total),
        description,
        group_id: group.id,
        currency_code: currency,
        date: `${date}T12:00:00Z`,
        ...(args.category_id !== undefined ? { category_id: args.category_id } : {}),
      };
      const participants = new Set<number>([...split.shares.keys(), payer.id]);
      let i = 0;
      for (const id of participants) {
        body[`users__${i}__user_id`] = id;
        body[`users__${i}__paid_share`] = id === payer.id ? fromMinor(split.total) : '0.00';
        body[`users__${i}__owed_share`] = fromMinor(split.shares.get(id) ?? 0);
        i += 1;
      }

      const breakdown = [...split.shares.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, owes]) => ({
          person: { id, name: fullName(byId.get(id)) },
          items: fromMinor(split.subtotals.get(id) ?? 0),
          extras: fromMinor(owes - (split.subtotals.get(id) ?? 0)),
          owes: fromMinor(owes),
        }));

      const candidate: ExpenseLike = { description, cost: fromMinor(split.total), currency_code: currency, date: `${date}T12:00:00Z`, payerId: payer.id };
      const fp = fingerprint(group.id, candidate);
      const already = await deps.writeLog.find(String(me.id), fp, args.idempotency_key);
      if (already) {
        deps.metrics.emit({ type: 'duplicate_blocked', tool: 'split_by_items', source: 'write_log' });
        return ok(`Already posted as expense #${already.expenseId} within the last 48 hours. Nothing new was created.`, {
          posted: false,
          expense_id: already.expenseId,
          group_id: group.id,
          note: 'Duplicate of a recent post from this connector. Refused.',
        });
      }

      const extrasNote = split.tax || split.tip ? ` Tax and tip of ${fromMinor(split.tax + split.tip)} ${currency} split in proportion to what each person ordered.` : '';
      const rows = breakdown.map((b) => `  ${b.person.name}: ${b.owes} ${currency} (${b.items} of items${split.tax || split.tip ? ` + ${b.extras} extras` : ''})`);
      const affected = breakdown.filter((b) => b.person.id !== me.id).map((b) => b.person.name);
      const preview = [
        `Add "${description}" for ${fromMinor(split.total)} ${currency} to ${untrusted(group.name, 60)} on ${date}, split by item. ${fullName(payer)} paid.${extrasNote}`,
        ...rows,
        affected.length ? `This changes what ${joinNames(affected)} owe.` : '',
        `It will carry a comment saying ${SIGNATURE.replace(/\.$/, '')}.`,
      ]
        .filter(Boolean)
        .join('\n');

      deps.metrics.emit({ type: 'preview_shown', tool: 'split_by_items' });
      const payload: ItemSplitPayload = { body, description, total: fromMinor(split.total), currency, breakdown };
      const state = await deps.codec.mint({
        kind: 'split_by_items',
        userId: me.id,
        fingerprint: fp,
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
        payload,
      });
      return inputRequired({
        inputRequests: { confirm: inputRequired.elicit({ message: `${preview}\n\nPost it?`, requestedSchema: ConfirmSchema }) },
        requestState: state,
      });
    }),
  );

  server.registerTool(
    'settle_up',
    {
      title: 'Record a payment',
      description:
        'Record that money changed hands, so the balance closes in Splitwise. Use this after you actually paid someone (or they paid you) through Venmo, UPI, a bank transfer or cash. Defaults to the full outstanding balance. Shows a preview and waits for confirmation. This does not move money; it records a payment that already happened. Posts a comment noting that Goodwill MCP recorded it.',
      inputSchema: z.object({
        friend: z.string().describe('Member name or id.'),
        amount: z.string().optional().describe('Decimal string like "61.00". Defaults to the full outstanding balance with this person.'),
        currency: z.string().length(3).optional(),
        direction: z.enum(['i_paid', 'they_paid']).default('i_paid').describe('Who handed over the money.'),
        group_id: z.number().int().optional().describe('Record it inside a group. Otherwise it is a direct payment.'),
        date: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
        idempotency_key: z.string().max(64).optional(),
      }),
      outputSchema: SettleOutputWrite,
      annotations: WRITE,
    },
    timed(deps.metrics, 'settle_up', async (args, ctx) => {
      const denied = missingScope(ctx, 'add');
      if (denied) return denied;
      const me = await deps.me();
      const pending = ctx.mcpReq.requestState<PendingWrite>();

      if (pending && pending.kind === 'settle_up') {
        if (pending.userId !== me.id) return fail('This confirmation belongs to a different Splitwise account. Start again.');
        const payload = pending.payload as SettlePayload;
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
        if (!answer || answer.confirm !== true || declined(ctx.mcpReq.inputResponses)) {
          deps.metrics.emit({ type: 'preview_declined', tool: 'settle_up' });
          return ok('Cancelled. No payment was recorded.', { recorded: false, note: 'Cancelled by the user.' });
        }
        deps.metrics.emit({ type: 'preview_confirmed', tool: 'settle_up' });
        const existing = await deps.writeLog.find(String(me.id), pending.fingerprint, pending.idempotencyKey);
        if (existing) {
          deps.metrics.emit({ type: 'duplicate_blocked', tool: 'settle_up', source: 'write_log' });
          return ok(`Already recorded as #${existing.expenseId}. Nothing new was created.`, {
            recorded: false,
            expense_id: existing.expenseId,
            note: 'A matching payment was recorded in the last 48 hours. Refused to record it again.',
          });
        }
        const created = await deps.client.createExpense(payload.body);
        deps.metrics.emit({ type: 'write_posted', tool: 'settle_up' });
        await annotate(deps, created.id, `Recorded a payment of ${payload.amount} ${payload.currency} from ${payload.fromName} to ${payload.toName}.`);
        await deps.writeLog.record(String(me.id), {
          fingerprint: pending.fingerprint,
          ...(pending.idempotencyKey ? { idempotencyKey: pending.idempotencyKey } : {}),
          expenseId: created.id,
          createdAt: deps.now().toISOString(),
          description: `Payment ${payload.amount} ${payload.currency}`,
        });
        return ok(`Recorded: ${payload.fromName} paid ${payload.toName} ${payload.amount} ${payload.currency}. Balance updated.`, {
          recorded: true,
          expense_id: created.id,
          from: payload.fromName,
          to: payload.toName,
          amount: payload.amount,
          currency: payload.currency,
          note: 'Recorded as a payment in Splitwise.',
        });
      }

      // Round 1.
      let target: SwUser;
      let outstanding = 0;
      let currency = (args.currency ?? me.default_currency ?? 'USD').toUpperCase();
      const friends = await deps.client.friends();

      if (args.group_id !== undefined) {
        const group = await deps.group(args.group_id);
        const r = resolveMember(group, args.friend, me.id);
        if (!r.ok) return fail(describeResolution(args.friend, r));
        target = r.user;
        const bal = friends.find((f) => f.id === target.id)?.groups.find((g) => g.group_id === args.group_id)?.balance ?? [];
        const picked = bal.find((b) => (args.currency ? b.currency_code === currency : toMinor(b.amount) !== 0));
        if (picked) {
          outstanding = toMinor(picked.amount);
          currency = picked.currency_code;
        }
      } else {
        const r = resolveMember({ members: friends.map((f) => ({ ...f })) }, args.friend, me.id);
        if (!r.ok) return fail(describeResolution(args.friend, r));
        target = r.user;
        const bal = friends.find((f) => f.id === target.id)?.balance ?? [];
        const picked = bal.find((b) => (args.currency ? b.currency_code === currency : toMinor(b.amount) !== 0));
        if (picked) {
          outstanding = toMinor(picked.amount);
          currency = picked.currency_code;
        }
      }

      // `outstanding` is positive when they owe me.
      const owedToMe = outstanding > 0;
      const defaultDirection = owedToMe ? 'they_paid' : 'i_paid';
      const direction = args.amount === undefined ? defaultDirection : args.direction;

      let amountMinor: number;
      if (args.amount !== undefined) {
        try {
          amountMinor = toMinor(args.amount);
        } catch {
          return fail(`"${args.amount}" is not an amount. Use a decimal like "61.00".`);
        }
      } else {
        amountMinor = Math.abs(outstanding);
      }
      if (amountMinor <= 0) return fail(`There is nothing outstanding with ${fullName(target)}. Give an explicit amount if you want to record a payment anyway.`);

      const payer = direction === 'i_paid' ? me : target;
      const receiver = direction === 'i_paid' ? target : me;
      const date = args.date ?? localDate(deps.now());
      const body: SwCreateExpenseByShares = {
        cost: fromMinor(amountMinor),
        description: 'Payment',
        group_id: args.group_id ?? 0,
        currency_code: currency,
        date: `${date}T12:00:00Z`,
        // `payment` is not in the documented create_expense schema, but the
        // shares below produce the correct balance either way: the payer is
        // credited the full amount and the receiver owes it.
        payment: true,
        users__0__user_id: payer.id,
        users__0__paid_share: fromMinor(amountMinor),
        users__0__owed_share: '0.00',
        users__1__user_id: receiver.id,
        users__1__paid_share: '0.00',
        users__1__owed_share: fromMinor(amountMinor),
      };

      const fp = `settle|${args.group_id ?? 0}|${payer.id}|${receiver.id}|${currency}|${amountMinor}|${date}`;
      const already = await deps.writeLog.find(String(me.id), fp, args.idempotency_key);
      if (already) {
        deps.metrics.emit({ type: 'duplicate_blocked', tool: 'settle_up', source: 'write_log' });
        return ok(`Already recorded as #${already.expenseId} within the last 48 hours. Nothing new was created.`, {
          recorded: false,
          expense_id: already.expenseId,
          note: 'Duplicate of a recent payment recorded by this connector. Refused.',
        });
      }

      const fromName = payer.id === me.id ? 'You' : fullName(payer);
      const toName = receiver.id === me.id ? 'you' : fullName(receiver);
      const remaining = Math.abs(outstanding) - amountMinor;
      const after =
        outstanding === 0
          ? ''
          : remaining === 0
            ? ` This closes the balance with ${fullName(target)}.`
            : remaining > 0
              ? ` ${fromMinor(remaining)} ${currency} would still be open.`
              : ` That is ${fromMinor(-remaining)} ${currency} more than is outstanding.`;
      const preview = `Record a payment: ${fromName} paid ${toName} ${fromMinor(amountMinor)} ${currency} on ${date}.${after} This changes what ${fullName(target)} owes. It will carry a comment saying ${SIGNATURE.replace(/\.$/, '')}.`;

      deps.metrics.emit({ type: 'preview_shown', tool: 'settle_up' });
      const payload: SettlePayload = { body, fromName, toName, amount: fromMinor(amountMinor), currency };
      const state = await deps.codec.mint({
        kind: 'settle_up',
        userId: me.id,
        fingerprint: fp,
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
        payload,
      });
      return inputRequired({
        inputRequests: { confirm: inputRequired.elicit({ message: `${preview} Record it?`, requestedSchema: ConfirmSchema }) },
        requestState: state,
      });
    }),
  );

  server.registerTool(
    'nudge',
    {
      title: 'Nudge someone to pay',
      description:
        "Draft a reminder to someone who owes you, in a tone you choose, and post it after the user confirms. Splitwise's own private Remind button is not in its API, so the only channel available is a comment on your most recent shared expense, which everyone on that expense can see. Say so when offering this: chasing someone in front of the group is a different act from a private nudge, and the user should choose it knowingly. Nothing is posted until confirmed.",
      inputSchema: z.object({
        friend: z.string().describe('Member name or id.'),
        group_id: z.number().int().optional().describe('Limit to a group. Otherwise uses your overall balance with them.'),
        tone: z.enum(['gentle', 'plain', 'firm']).default('gentle'),
        message: z.string().max(400).optional().describe('Your own words instead of the drafted message.'),
      }),
      outputSchema: NudgeOutput,
      annotations: WRITE,
    },
    timed(deps.metrics, 'nudge', async (args, ctx) => {
      const denied = missingScope(ctx, 'add');
      if (denied) return denied;
      const me = await deps.me();
      const pending = ctx.mcpReq.requestState<PendingWrite>();

      if (pending && pending.kind === 'nudge') {
        if (pending.userId !== me.id) return fail('This confirmation belongs to a different Splitwise account. Start again.');
        const payload = pending.payload as NudgePayload;
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
        if (!answer || answer.confirm !== true || declined(ctx.mcpReq.inputResponses)) {
          deps.metrics.emit({ type: 'preview_declined', tool: 'nudge' });
          return ok('Cancelled. Nothing was posted.', { posted: false, note: 'Cancelled by the user.' });
        }
        deps.metrics.emit({ type: 'preview_confirmed', tool: 'nudge' });
        const comment = await deps.client.createComment(payload.expenseId, payload.content);
        deps.metrics.emit({ type: 'write_posted', tool: 'nudge' });
        return ok(`Posted the reminder to ${payload.toName} as a comment on expense #${payload.expenseId}.`, {
          posted: true,
          expense_id: payload.expenseId,
          comment_id: comment.id,
          to: payload.toName,
          note: 'Posted as a comment. Everyone on that expense can see it.',
        });
      }

      // Round 1.
      let target: SwUser;
      let amountMinor = 0;
      let currency = me.default_currency ?? 'USD';
      let expenses: SwExpense[];
      let context: string;

      if (args.group_id !== undefined) {
        const group = await deps.group(args.group_id);
        const r = resolveMember(group, args.friend, me.id);
        if (!r.ok) return fail(describeResolution(args.friend, r));
        target = r.user;
        expenses = await deps.client.allExpenses({ group_id: group.id });
        const friends = await deps.client.friends();
        const bal = friends.find((f) => f.id === target.id)?.groups.find((g) => g.group_id === group.id)?.balance ?? [];
        const first = bal.find((b) => toMinor(b.amount) !== 0) ?? bal[0];
        if (first) {
          amountMinor = toMinor(first.amount);
          currency = first.currency_code;
        }
        context = untrusted(group.name, 60);
      } else {
        const friends = await deps.client.friends();
        const r = resolveMember({ members: friends.map((f) => ({ ...f })) }, args.friend, me.id);
        if (!r.ok) return fail(describeResolution(args.friend, r));
        target = r.user;
        const f = friends.find((x) => x.id === target.id)!;
        const first = f.balance.find((b) => toMinor(b.amount) !== 0) ?? f.balance[0];
        if (first) {
          amountMinor = toMinor(first.amount);
          currency = first.currency_code;
        }
        expenses = await deps.client.allExpenses({ friend_id: target.id });
        context = 'our shared expenses';
      }

      if (amountMinor <= 0) {
        return fail(amountMinor === 0 ? `${fullName(target)} does not owe you anything right now.` : `You owe ${fullName(target)}, not the other way round. No nudge sent.`);
      }

      const shared = expenses
        .filter((e) => !e.deleted_at && !e.payment && e.users.some((u) => u.user_id === target.id) && e.users.some((u) => u.user_id === me.id))
        .sort((a, b) => b.date.localeCompare(a.date));
      const anchor = shared[0];
      if (!anchor) return fail(`No shared expense with ${fullName(target)} to comment on.`);

      const days = Math.floor((deps.now().getTime() - new Date(anchor.date).getTime()) / 86_400_000);
      const amount = `${fromMinor(amountMinor)} ${currency}`;
      const first = untrusted(target.first_name, 40);
      const drafts: Record<'gentle' | 'plain' | 'firm', string> = {
        gentle: `Hey ${first}, whenever you get a chance, could you settle the ${amount} for ${context}? No rush. Thanks!`,
        plain: `Hi ${first}, a reminder: you owe ${amount} for ${context}. Could you settle up this week?`,
        firm: `${first}, the ${amount} for ${context} has been open for ${days} days. Please settle it by the end of the week.`,
      };
      const content = untrusted(args.message ?? drafts[args.tone], 400);
      const others = anchor.users.filter((u) => u.user_id !== me.id && u.user_id !== target.id).length;
      const audience =
        others > 0
          ? `${fullName(target)} and ${others} other ${others === 1 ? 'person' : 'people'} on that expense will see it`
          : `only ${fullName(target)} is on that expense, so only they will see it`;
      const preview = [
        `Post this as a comment on "${untrusted(anchor.description, 60)}" (${anchor.date.slice(0, 10)}). ${sentenceCase(audience)}.`,
        others > 0 ? "Splitwise's private reminder is not available through its API, so a public comment is the only way to do this." : '',
        '',
        `"${content}"`,
      ]
        .filter(Boolean)
        .join('\n');

      deps.metrics.emit({ type: 'preview_shown', tool: 'nudge' });
      const payload: NudgePayload = { expenseId: anchor.id, content, toName: fullName(target) };
      const state = await deps.codec.mint({ kind: 'nudge', userId: me.id, fingerprint: `nudge|${target.id}|${anchor.id}`, payload });
      return inputRequired({
        inputRequests: { confirm: inputRequired.elicit({ message: `${preview}\n\nPost it?`, requestedSchema: ConfirmSchema }) },
        requestState: state,
      });
    }),
  );
}
