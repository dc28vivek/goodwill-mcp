import { type McpServer, acceptedContent, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type ExpenseLike, findDuplicates, fingerprint, toExpenseLike } from '../domain/dedupe.js';
import { fromMinor, splitEqual, toMinor } from '../domain/money.js';
import { parseExpenseSentence } from '../domain/parser.js';
import type { Deps, PendingWrite } from '../server/deps.js';
import { GROUP_URL, fail, fullName, joinNames, ok, untrusted } from '../server/format.js';
import { describeResolution, resolveMember } from '../server/resolve.js';
import type { SwCreateExpenseByShares, SwExpense, SwUser } from '../splitwise/types.js';
import { AddExpenseOutput, ConfirmSchema, NudgeOutput } from './schemas.js';

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

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
        'Add a shared expense to a group from a sentence ("dinner 84, I paid, split with everyone") or from explicit fields. Step 1 returns a preview naming everyone whose balance changes and asks for confirmation. Nothing is posted until the user confirms. Checks for likely duplicates first. Equal split only in this version; give participants to limit who shares it.',
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
    async (args, ctx) => {
      const me = await deps.me();
      const pending = ctx.mcpReq.requestState<PendingWrite>();

      // Round 2: the client came back with an answer.
      if (pending && pending.kind === 'add_expense') {
        if (pending.userId !== me.id) return fail('This confirmation belongs to a different Splitwise account. Start again.');
        const payload = pending.payload as AddPayload;
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
        if (!answer || answer.confirm !== true || declined(ctx.mcpReq.inputResponses)) {
          return ok('Cancelled. Nothing was posted.', { posted: false, group_id: args.group_id, note: 'Cancelled by the user.' });
        }
        const existing = await deps.writeLog.find(String(me.id), pending.fingerprint, pending.idempotencyKey);
        if (existing) {
          return ok(`Already posted as expense #${existing.expenseId} ("${existing.description}"). Nothing new was created.`, {
            posted: false,
            expense_id: existing.expenseId,
            group_id: args.group_id,
            note: 'A matching expense was posted in the last 48 hours. Refused to post again.',
          });
        }
        const created = await deps.client.createExpense(payload.body);
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
    },
  );

  server.registerTool(
    'nudge',
    {
      title: 'Nudge someone to pay',
      description:
        'Draft a reminder to someone who owes you, in a tone you choose, and post it as a comment on your most recent shared expense after the user confirms. The comment is visible to everyone on that expense. Nothing is posted until confirmed.',
      inputSchema: z.object({
        friend: z.string().describe('Member name or id.'),
        group_id: z.number().int().optional().describe('Limit to a group. Otherwise uses your overall balance with them.'),
        tone: z.enum(['gentle', 'plain', 'firm']).default('gentle'),
        message: z.string().max(400).optional().describe('Your own words instead of the drafted message.'),
      }),
      outputSchema: NudgeOutput,
      annotations: WRITE,
    },
    async (args, ctx) => {
      const me = await deps.me();
      const pending = ctx.mcpReq.requestState<PendingWrite>();

      if (pending && pending.kind === 'nudge') {
        if (pending.userId !== me.id) return fail('This confirmation belongs to a different Splitwise account. Start again.');
        const payload = pending.payload as NudgePayload;
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
        if (!answer || answer.confirm !== true || declined(ctx.mcpReq.inputResponses)) {
          return ok('Cancelled. Nothing was posted.', { posted: false, note: 'Cancelled by the user.' });
        }
        const comment = await deps.client.createComment(payload.expenseId, payload.content);
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
      const preview = `Post this comment on "${untrusted(anchor.description, 60)}" (${anchor.date.slice(0, 10)}), where ${fullName(target)} and everyone else on that expense will see it:\n\n"${content}"`;

      const payload: NudgePayload = { expenseId: anchor.id, content, toName: fullName(target) };
      const state = await deps.codec.mint({ kind: 'nudge', userId: me.id, fingerprint: `nudge|${target.id}|${anchor.id}`, payload });
      return inputRequired({
        inputRequests: { confirm: inputRequired.elicit({ message: `${preview}\n\nPost it?`, requestedSchema: ConfirmSchema }) },
        requestState: state,
      });
    },
  );
}
