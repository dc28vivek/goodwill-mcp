import { describe, expect, it } from 'vitest';
import { explainBalance } from '../src/domain/explain.js';
import { LISBON_EXPENSES, ME, PRIYA, SAM, expense } from './fixtures/lisbon.js';

describe('explainBalance', () => {
  it('lists the expenses behind what Priya owes Vivek', () => {
    const [eur] = explainBalance(ME.id, PRIYA.id, LISBON_EXPENSES);
    expect(eur?.currency).toBe('EUR');
    expect(eur?.net).toBe(6100);
    expect(eur?.contributions.map((c) => c.description)).toEqual(['Dinner at Cervejaria', 'Airbnb']);
  });
  it('nets a payment against expenses for Sam', () => {
    const [eur] = explainBalance(ME.id, SAM.id, LISBON_EXPENSES);
    // 28 + 33 + 8 owed, minus 49 paid back = 20
    expect(eur?.net).toBe(2000);
    const payment = eur?.contributions.find((c) => c.kind === 'payment');
    expect(payment?.amount).toBe(-4900);
  });
  it('is antisymmetric', () => {
    const [mine] = explainBalance(ME.id, PRIYA.id, LISBON_EXPENSES);
    const [theirs] = explainBalance(PRIYA.id, ME.id, LISBON_EXPENSES);
    expect(theirs?.net).toBe(-(mine?.net ?? 0));
  });
  it('skips deleted expenses', () => {
    const deleted = LISBON_EXPENSES.map((e) => ({ ...e, deleted_at: '2026-09-07T00:00:00Z' }));
    expect(explainBalance(ME.id, PRIYA.id, deleted)).toEqual([]);
  });
});

describe('statement shape', () => {
  it('separates what was charged from what has been settled', () => {
    const [eur] = explainBalance(ME.id, SAM.id, LISBON_EXPENSES);
    // Sam was charged 28 + 33 + 8 = 69, and has paid back 49, leaving 20.
    expect(eur?.charged).toBe(6900);
    expect(eur?.settled).toBe(-4900);
    expect(eur?.net).toBe(2000);
    expect(eur?.expenseCount).toBe(3);
    expect(eur?.paymentCount).toBe(1);
  });
  it('net always equals charged plus settled', () => {
    for (const cp of [PRIYA, SAM]) {
      for (const b of explainBalance(ME.id, cp.id, LISBON_EXPENSES)) {
        expect(b.net).toBe(b.charged + b.settled);
      }
    }
  });
  it('reports zero settled when nobody has paid anything back', () => {
    const [eur] = explainBalance(ME.id, PRIYA.id, LISBON_EXPENSES);
    expect(eur?.settled).toBe(0);
    expect(eur?.paymentCount).toBe(0);
    expect(eur?.charged).toBe(6100);
  });
});

describe('only since the last settled point', () => {
  const settled = (date: string, amount: string) =>
    expense({ description: 'Payment', cost: amount, payment: true, date, users: [
      { user: { id: PRIYA.id, first_name: PRIYA.first_name, last_name: PRIYA.last_name }, user_id: PRIYA.id, paid_share: amount, owed_share: '0', net_balance: amount },
      { user: { id: ME.id, first_name: ME.first_name, last_name: ME.last_name }, user_id: ME.id, paid_share: '0', owed_share: amount, net_balance: `-${amount}` },
    ] });
  const charge = (date: string, amount: string, description: string) =>
    expense({ description, cost: amount, date, users: [
      { user: { id: ME.id, first_name: ME.first_name, last_name: ME.last_name }, user_id: ME.id, paid_share: amount, owed_share: '0', net_balance: amount },
      { user: { id: PRIYA.id, first_name: PRIYA.first_name, last_name: PRIYA.last_name }, user_id: PRIYA.id, paid_share: '0', owed_share: amount, net_balance: `-${amount}` },
    ] });

  it('leaves out everything before the balance last hit zero', () => {
    const history = [
      charge('2024-01-10T12:00:00Z', '100.00', 'Old dinner'),
      settled('2024-02-01T12:00:00Z', '100.00'),
      charge('2026-09-01T12:00:00Z', '40.00', 'Recent lunch'),
    ];
    const [eur] = explainBalance(ME.id, PRIYA.id, history);
    expect(eur?.net).toBe(4000);
    expect(eur?.charged).toBe(4000);
    expect(eur?.expenseCount).toBe(1);
    expect(eur?.closedCount).toBe(2);
    expect(eur?.settledOn).toBe('2024-02-01T12:00:00Z');
    expect(eur?.contributions.map((c) => c.description)).toEqual(['Recent lunch']);
  });

  it('shows the whole history when it was never settled', () => {
    const [eur] = explainBalance(ME.id, PRIYA.id, LISBON_EXPENSES);
    expect(eur?.settledOn).toBeNull();
    expect(eur?.closedCount).toBe(0);
    expect(eur?.charged).toBe(6100);
  });

  it('uses the most recent zero when there have been several', () => {
    const history = [
      charge('2024-01-10T12:00:00Z', '10.00', 'First'),
      settled('2024-01-20T12:00:00Z', '10.00'),
      charge('2025-01-10T12:00:00Z', '20.00', 'Second'),
      settled('2025-01-20T12:00:00Z', '20.00'),
      charge('2026-01-10T12:00:00Z', '30.00', 'Third'),
    ];
    const [eur] = explainBalance(ME.id, PRIYA.id, history);
    expect(eur?.closedCount).toBe(4);
    expect(eur?.contributions.map((c) => c.description)).toEqual(['Third']);
  });

  it('handles a payment that creates the debt rather than closing one', () => {
    const [eur] = explainBalance(ME.id, PRIYA.id, [settled('2026-09-01T12:00:00Z', '45.28')]);
    expect(eur?.charged).toBe(0);
    expect(eur?.settled).toBe(-4528);
    expect(eur?.net).toBe(-4528);
  });
});

describe('choosing where the window opens', () => {
  const pay = (date: string, amount: string) =>
    expense({ description: 'Payment', cost: amount, payment: true, date, users: [
      { user: { id: PRIYA.id, first_name: PRIYA.first_name, last_name: PRIYA.last_name }, user_id: PRIYA.id, paid_share: amount, owed_share: '0', net_balance: amount },
      { user: { id: ME.id, first_name: ME.first_name, last_name: ME.last_name }, user_id: ME.id, paid_share: '0', owed_share: amount, net_balance: `-${amount}` },
    ] });
  const charge = (date: string, amount: string, description: string) =>
    expense({ description, cost: amount, date, users: [
      { user: { id: ME.id, first_name: ME.first_name, last_name: ME.last_name }, user_id: ME.id, paid_share: amount, owed_share: '0', net_balance: amount },
      { user: { id: PRIYA.id, first_name: PRIYA.first_name, last_name: PRIYA.last_name }, user_id: PRIYA.id, paid_share: '0', owed_share: amount, net_balance: `-${amount}` },
    ] });

  // Settled clean, then charges, then a partial payment, then another charge.
  const history = [
    charge('2024-01-10T12:00:00Z', '100.00', 'Old dinner'),
    pay('2024-02-01T12:00:00Z', '100.00'),
    charge('2026-06-01T12:00:00Z', '50.00', 'Flights'),
    charge('2026-07-01T12:00:00Z', '30.00', 'Hotel'),
    pay('2026-08-01T12:00:00Z', '20.00'),
    charge('2026-09-01T12:00:00Z', '10.00', 'Lunch'),
  ];

  it('defaults to the last full settlement and carries nothing forward', () => {
    const [b] = explainBalance(ME.id, PRIYA.id, history);
    expect(b?.since).toBe('last_settled');
    expect(b?.broughtForward).toBe(0);
    expect(b?.charged).toBe(9000);
    expect(b?.settled).toBe(-2000);
    expect(b?.net).toBe(7000);
    expect(b?.contributions).toHaveLength(4);
  });

  it('can open after the last payment, carrying the unpaid remainder forward', () => {
    const [b] = explainBalance(ME.id, PRIYA.id, history, 'last_payment');
    expect(b?.since).toBe('last_payment');
    // 50 + 30 charged, 20 paid, leaving 60 owed when the window opens.
    expect(b?.broughtForward).toBe(6000);
    expect(b?.charged).toBe(1000);
    expect(b?.paymentCount).toBe(0);
    expect(b?.net).toBe(7000);
    expect(b?.contributions.map((c) => c.description)).toEqual(['Lunch']);
  });

  it('can open from a date', () => {
    const [b] = explainBalance(ME.id, PRIYA.id, history, { after: '2026-06-30' });
    expect(b?.since).toBe('date');
    expect(b?.broughtForward).toBe(5000);
    expect(b?.charged).toBe(4000);
    expect(b?.net).toBe(7000);
  });

  it('can show the whole history', () => {
    const [b] = explainBalance(ME.id, PRIYA.id, history, 'all');
    expect(b?.since).toBe('all');
    expect(b?.broughtForward).toBe(0);
    expect(b?.contributions).toHaveLength(6);
    expect(b?.net).toBe(7000);
  });

  it('reports the same true balance whichever window is chosen', () => {
    for (const mode of ['last_settled', 'last_payment', 'all', { after: '2026-06-30' }] as const) {
      const [b] = explainBalance(ME.id, PRIYA.id, history, mode);
      expect(b?.net).toBe(7000);
      expect(b?.net).toBe((b?.broughtForward ?? 0) + (b?.charged ?? 0) + (b?.settled ?? 0));
    }
  });
});

describe('an expense and a payment filed on the same day', () => {
  // The real case: a $2,000 payment and a $20.62 expense both dated Sep 6.
  // Sorting on `date` alone left them tied, so "what was added since the last
  // payment" had no defensible answer and the model inferred the order from the
  // activity feed. `created_at` decides it in code.
  const sameDay = (createdAt: string, amount: string, description: string, payment = false) =>
    expense({
      description,
      cost: amount,
      payment,
      date: '2026-09-06T12:00:00Z',
      created_at: createdAt,
      users: payment
        ? [
            { user: { id: PRIYA.id, first_name: PRIYA.first_name, last_name: PRIYA.last_name }, user_id: PRIYA.id, paid_share: amount, owed_share: '0', net_balance: amount },
            { user: { id: ME.id, first_name: ME.first_name, last_name: ME.last_name }, user_id: ME.id, paid_share: '0', owed_share: amount, net_balance: `-${amount}` },
          ]
        : [
            { user: { id: ME.id, first_name: ME.first_name, last_name: ME.last_name }, user_id: ME.id, paid_share: amount, owed_share: '0', net_balance: amount },
            { user: { id: PRIYA.id, first_name: PRIYA.first_name, last_name: PRIYA.last_name }, user_id: PRIYA.id, paid_share: '0', owed_share: amount, net_balance: `-${amount}` },
          ],
    });

  // Arrays arrive newest first, the way get_expenses returns them. That
  // matters: toSorted is stable, so a fixture already in the right order hides
  // the bug completely. The first version of these tests passed against the
  // broken code for exactly that reason.
  it('counts an expense entered after the payment', () => {
    const history = [
      sameDay('2026-09-06T11:00:00Z', '20.62', 'Entered after the payment'),
      sameDay('2026-09-06T10:00:00Z', '100.00', 'Payment', true),
      sameDay('2026-09-06T09:00:00Z', '100.00', 'Old charge'),
    ];
    const [eur] = explainBalance(ME.id, PRIYA.id, history, 'last_payment');
    expect(eur?.charged).toBe(2062);
    expect(eur?.contributions.map((c) => c.description)).toEqual(['Entered after the payment']);
  });

  it('leaves out an expense entered before the payment, because it was already covered', () => {
    const history = [
      sameDay('2026-09-06T10:00:00Z', '20.62', 'Payment', true),
      sameDay('2026-09-06T09:00:00Z', '20.62', 'Entered before the payment'),
    ];
    const [eur] = explainBalance(ME.id, PRIYA.id, history, 'last_payment');
    expect(eur?.charged).toBe(0);
    expect(eur?.contributions).toHaveLength(0);
    expect(eur?.net).toBe(0);
  });

  it('orders the window itself by entry time, not just by day', () => {
    const history = [
      sameDay('2026-09-06T09:00:00Z', '2.00', 'Second entered'),
      sameDay('2026-09-06T08:00:00Z', '1.00', 'First entered'),
      sameDay('2026-09-06T10:00:00Z', '3.00', 'Third entered'),
    ];
    const [eur] = explainBalance(ME.id, PRIYA.id, history, 'all');
    // Newest first in the listing.
    expect(eur?.contributions.map((c) => c.description)).toEqual(['Third entered', 'Second entered', 'First entered']);
  });
});
