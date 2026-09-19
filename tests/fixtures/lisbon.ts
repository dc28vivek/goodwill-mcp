import type { SwExpense, SwGroup, SwUser } from '../../src/splitwise/types.js';

export const ME: SwUser = { id: 1, first_name: 'Vivek', last_name: 'D' };
export const PRIYA: SwUser = { id: 2, first_name: 'Priya', last_name: 'S' };
export const SAM: SwUser = { id: 3, first_name: 'Sam', last_name: 'K' };
export const ALEX_A: SwUser = { id: 4, first_name: 'Alex', last_name: 'Ahuja' };
export const ALEX_B: SwUser = { id: 5, first_name: 'Alex', last_name: 'Brown' };

const members = [ME, PRIYA, SAM, ALEX_A, ALEX_B];

export const LISBON: SwGroup = {
  id: 100,
  name: 'Lisbon',
  group_type: 'trip',
  updated_at: '2026-09-10T10:00:00Z',
  simplify_by_default: true,
  members: members.map((m) => ({ ...m, balance: [] })),
  original_debts: [],
  simplified_debts: [
    { from: 2, to: 1, amount: '61.00', currency_code: 'EUR' },
    { from: 3, to: 1, amount: '20.00', currency_code: 'EUR' },
  ],
};

function share(user: SwUser, paid: string, owed: string) {
  const net = ((Number(paid) - Number(owed))).toFixed(2);
  return { user: { id: user.id, first_name: user.first_name, last_name: user.last_name }, user_id: user.id, paid_share: paid, owed_share: owed, net_balance: net };
}

let nextId = 1000;
export function expense(partial: Partial<SwExpense> & { description: string; cost: string; users: SwExpense['users'] }): SwExpense {
  nextId += 1;
  return {
    id: nextId,
    group_id: 100,
    friendship_id: null,
    details: null,
    currency_code: 'EUR',
    date: '2026-09-05T19:00:00Z',
    created_at: '2026-09-05T19:05:00Z',
    updated_at: '2026-09-05T19:05:00Z',
    deleted_at: null,
    payment: false,
    repeats: false,
    category: { id: 13, name: 'Dining out' },
    created_by: ME,
    repayments: [],
    ...partial,
  };
}

/** Three expenses. Vivek paid all. Priya and Sam owe. */
export const LISBON_EXPENSES: SwExpense[] = [
  expense({
    description: 'Dinner at Cervejaria',
    cost: '84.00',
    date: '2026-09-05T19:00:00Z',
    users: [share(ME, '84.00', '28.00'), share(PRIYA, '0', '28.00'), share(SAM, '0', '28.00')],
  }),
  expense({
    description: 'Airbnb',
    cost: '99.00',
    date: '2026-09-04T12:00:00Z',
    category: { id: 6, name: 'Rent' },
    users: [share(ME, '99.00', '33.00'), share(PRIYA, '0', '33.00'), share(SAM, '0', '33.00')],
  }),
  expense({
    description: 'Taxi from airport',
    cost: '16.00',
    date: '2026-09-04T09:00:00Z',
    category: { id: 31, name: 'Taxi' },
    users: [share(ME, '16.00', '8.00'), share(SAM, '0', '8.00')],
  }),
  // Sam paid Vivek back some money.
  expense({
    description: 'Payment',
    cost: '49.00',
    payment: true,
    date: '2026-09-06T09:00:00Z',
    users: [share(SAM, '49.00', '0'), share(ME, '0', '49.00')],
  }),
];
