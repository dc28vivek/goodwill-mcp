import type { SwComment, SwExpense, SwFriend, SwGroup, SwUser } from '../../src/splitwise/types.js';
import { LISBON, LISBON_EXPENSES, ME, PRIYA, SAM } from './lisbon.js';

/**
 * A fake of the Splitwise REST API good enough for the connector's calls.
 * Records every write so tests can assert on request bodies.
 */
export interface FakeState {
  me: SwUser & { default_currency: string; locale: string };
  groups: SwGroup[];
  friends: SwFriend[];
  expenses: SwExpense[];
  comments: SwComment[];
  writes: { path: string; body: unknown }[];
  nextId: number;
}

export function makeState(): FakeState {
  const friends: SwFriend[] = [
    { ...PRIYA, groups: [{ group_id: 100, balance: [{ currency_code: 'EUR', amount: '61.00' }] }], balance: [{ currency_code: 'EUR', amount: '61.00' }], updated_at: '2026-09-05T19:05:00Z' },
    { ...SAM, groups: [{ group_id: 100, balance: [{ currency_code: 'EUR', amount: '20.00' }] }], balance: [{ currency_code: 'EUR', amount: '20.00' }], updated_at: '2026-09-06T09:00:00Z' },
  ];
  const group: SwGroup = {
    ...LISBON,
    members: LISBON.members.map((m) => ({
      ...m,
      balance: m.id === 1 ? [{ currency_code: 'EUR', amount: '81.00' }] : m.id === 2 ? [{ currency_code: 'EUR', amount: '-61.00' }] : m.id === 3 ? [{ currency_code: 'EUR', amount: '-20.00' }] : [{ currency_code: 'EUR', amount: '0.00' }],
    })),
  };
  return {
    me: { ...ME, default_currency: 'EUR', locale: 'en' },
    groups: [group],
    friends,
    expenses: LISBON_EXPENSES.map((e) => ({ ...e })),
    comments: [],
    writes: [],
    nextId: 5000,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function fakeFetch(state: FakeState): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname.replace('/api/v3.0', '');
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== 'Bearer test-token') return json({ error: 'Invalid API request: you are not logged in' }, 401);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (path === '/get_current_user') return json({ user: state.me });
    if (path === '/get_groups') return json({ groups: state.groups });
    if (path.startsWith('/get_group/')) {
      const id = Number(path.split('/').pop());
      const g = state.groups.find((x) => x.id === id);
      return g ? json({ group: g }) : json({ errors: { base: ['Invalid API Request: record not found'] } }, 404);
    }
    if (path === '/get_friends') return json({ friends: state.friends });
    if (path === '/get_expenses') {
      const gid = url.searchParams.get('group_id');
      const fid = url.searchParams.get('friend_id');
      const after = url.searchParams.get('dated_after');
      const before = url.searchParams.get('dated_before');
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      let list = state.expenses;
      if (gid) list = list.filter((e) => e.group_id === Number(gid));
      if (fid) list = list.filter((e) => e.users.some((u) => u.user_id === Number(fid)));
      if (after) list = list.filter((e) => e.date >= after);
      if (before) list = list.filter((e) => e.date <= before);
      return json({ expenses: list.slice(offset, offset + limit) });
    }
    if (path.startsWith('/get_expense/')) {
      const id = Number(path.split('/').pop());
      const found = state.expenses.find((e) => e.id === id);
      if (!found) return json({ errors: { base: ['Invalid API Request: record not found'] } }, 404);
      const comments = state.comments.filter((c) => c.relation_id === id);
      return json({ expense: { ...found, comments, comments_count: comments.length } });
    }
    if (path === '/create_expense') {
      state.writes.push({ path, body });
      const users: SwExpense['users'] = [];
      for (let i = 0; ; i += 1) {
        const uid = body[`users__${i}__user_id`];
        if (uid === undefined) break;
        const paid = String(body[`users__${i}__paid_share`]);
        const owed = String(body[`users__${i}__owed_share`]);
        const u = state.groups[0]!.members.find((m) => m.id === Number(uid))!;
        users.push({ user: { id: u.id, first_name: u.first_name, last_name: u.last_name }, user_id: u.id, paid_share: paid, owed_share: owed, net_balance: (Number(paid) - Number(owed)).toFixed(2) });
      }
      state.nextId += 1;
      const created: SwExpense = {
        id: state.nextId,
        group_id: Number(body.group_id),
        friendship_id: null,
        description: String(body.description),
        details: null,
        cost: String(body.cost),
        currency_code: String(body.currency_code ?? 'EUR'),
        date: String(body.date),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
        payment: false,
        repeats: false,
        category: { id: Number(body.category_id ?? 18), name: 'General' },
        created_by: state.me,
        users,
        repayments: [],
      };
      state.expenses.push(created);
      return json({ expenses: [created], errors: {} });
    }
    if (path === '/create_comment') {
      state.writes.push({ path, body });
      state.nextId += 1;
      const c: SwComment = {
        id: state.nextId,
        content: String(body.content),
        comment_type: 'User',
        relation_type: 'ExpenseComment',
        relation_id: Number(body.expense_id),
        created_at: new Date().toISOString(),
        deleted_at: null,
        user: { id: state.me.id, first_name: state.me.first_name, last_name: state.me.last_name },
      };
      state.comments.push(c);
      return json({ comment: c });
    }
    if (path === '/create_group') {
      state.writes.push({ path, body });
      state.nextId += 1;
      const members: SwGroup['members'] = [{ ...state.me, balance: [] }];
      for (let i = 0; ; i += 1) {
        const uid = body[`users__${i}__user_id`];
        const email = body[`users__${i}__email`];
        if (uid === undefined && email === undefined) break;
        if (uid !== undefined) {
          const known = state.groups[0]!.members.find((m) => m.id === Number(uid));
          if (known) members.push({ ...known, balance: [] });
        } else {
          state.nextId += 1;
          members.push({ id: state.nextId, first_name: String(body[`users__${i}__first_name`] ?? 'Friend'), last_name: String(body[`users__${i}__last_name`] ?? ''), email: String(email), registration_status: 'invited', balance: [] });
        }
      }
      const created: SwGroup = { id: state.nextId + 1000, name: String(body.name), group_type: (body.group_type as SwGroup['group_type']) ?? 'other', updated_at: new Date().toISOString(), simplify_by_default: Boolean(body.simplify_by_default), members, original_debts: [], simplified_debts: [] };
      state.groups.push(created);
      return json({ group: created });
    }
    if (path === '/add_user_to_group') {
      state.writes.push({ path, body });
      const g = state.groups.find((x) => x.id === Number(body.group_id));
      if (!g) return json({ success: false, errors: { base: ['group not found'] } });
      let user;
      if (body.user_id !== undefined) {
        user = state.groups[0]!.members.find((m) => m.id === Number(body.user_id)) ?? { id: Number(body.user_id), first_name: 'Someone', last_name: null };
      } else {
        state.nextId += 1;
        user = { id: state.nextId, first_name: String(body.first_name), last_name: String(body.last_name), email: String(body.email), registration_status: 'invited' as const };
      }
      g.members.push({ ...user, balance: [] });
      return json({ success: true, user });
    }
    if (path === '/get_categories') return json({ categories: [{ id: 1, name: 'Utilities', subcategories: [{ id: 5, name: 'Electricity' }] }, { id: 25, name: 'Food and drink', subcategories: [{ id: 13, name: 'Dining out' }] }] });
    if (path === '/get_currencies') return json({ currencies: [{ currency_code: 'EUR', unit: '€' }, { currency_code: 'USD', unit: '$' }, { currency_code: 'INR', unit: '₹' }] });
    return json({ errors: { base: [`Unknown path ${path}`] } }, 404);
  }) as typeof fetch;
}
