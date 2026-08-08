const fs = require('fs');
const os = require('os');
const path = require('path');
const PaymentReconciler = require('../src/reconciliation');

const HOLD_HASH = 'a'.repeat(64);
const PAYOUT_HASH = 'b'.repeat(64);
const COMMUNITY_HASH = 'c'.repeat(64);
const ROGUE_HASH = 'd'.repeat(64);

const tempDirs = [];

const baseConfig = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciliation-test-'));
  tempDirs.push(dir);
  return {
    RECONCILIATION_INTERVAL: 10,
    RECONCILIATION_START_DATE: '2026-01-01T00:00:00.000Z',
    RECONCILIATION_STATE_FILE: path.join(dir, 'state.json'),
  };
};

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const makePayment = (overrides = {}) => ({
  id: PAYOUT_HASH,
  index: 1,
  tokens: 100000,
  fee: 3,
  destination: '03deadbeef',
  request: 'lnbc1buyerinvoice',
  is_confirmed: true,
  confirmed_at: '2026-06-01T12:00:00.000Z',
  created_at: '2026-06-01T11:59:00.000Z',
  ...overrides,
});

const makeOrder = (overrides = {}) => ({
  _id: 'order1',
  amount: 100000,
  fee: 600,
  hash: HOLD_HASH,
  payout_hash: PAYOUT_HASH,
  status: 'SUCCESS',
  ...overrides,
});

/**
 * Minimal in-memory stand-in for the two Mongo collections the reconciler
 * queries. Each collection gets a findOne(query) resolved against fixtures.
 */
const makeDb = ({ orders = [], pendingPayments = [] } = {}) => {
  const matches = (doc, query) => {
    for (const [key, value] of Object.entries(query)) {
      if (key === '$or') {
        if (!value.some((sub) => matches(doc, sub))) return false;
      } else if (
        value !== null &&
        typeof value === 'object' &&
        '$ne' in value
      ) {
        if (doc[key] === value.$ne || doc[key] === undefined) return false;
      } else if (doc[key] !== value) {
        return false;
      }
    }
    return true;
  };
  const collections = {
    orders,
    pendingpayments: pendingPayments,
  };
  return {
    collection: (name) => ({
      findOne: async (query) =>
        (collections[name] || []).find((doc) => matches(doc, query)) || null,
    }),
  };
};

const makeReconciler = ({
  payments = [],
  orders = [],
  pendingPayments = [],
  invoices = {},
  config = baseConfig(),
} = {}) => {
  const sendAlert = jest.fn().mockResolvedValue(true);
  const reconciler = new PaymentReconciler(config, sendAlert, {
    db: makeDb({ orders, pendingPayments }),
    getPayments: jest.fn().mockResolvedValue({ payments, next: null }),
    getInvoice: jest.fn(async (hash) => invoices[hash] || null),
  });
  return { reconciler, sendAlert };
};

const settledHoldInvoice = (received = 100600) => ({
  is_confirmed: true,
  is_held: false,
  received,
});

describe('PaymentReconciler.classifyPayment', () => {
  test('accepts a payout whose order has a settled hold invoice', async () => {
    const { reconciler } = makeReconciler({
      orders: [makeOrder()],
      invoices: { [HOLD_HASH]: settledHoldInvoice() },
    });

    const result = await reconciler.classifyPayment(makePayment());

    expect(result.verdict).toBe('ok');
    expect(result.reason).toBe('order_payout');
  });

  test('alerts when the matched order hold invoice was never settled', async () => {
    const { reconciler } = makeReconciler({
      orders: [makeOrder()],
      invoices: {
        [HOLD_HASH]: { is_confirmed: false, is_held: true, received: 0 },
      },
    });

    const result = await reconciler.classifyPayment(makePayment());

    expect(result.verdict).toBe('alert');
    expect(result.reason).toBe('order_mismatch');
    expect(result.problems.join(' ')).toContain('never settled');
  });

  test('alerts when the hold invoice does not exist on the node', async () => {
    const { reconciler } = makeReconciler({
      orders: [makeOrder()],
      invoices: {},
    });

    const result = await reconciler.classifyPayment(makePayment());

    expect(result.verdict).toBe('alert');
    expect(result.problems.join(' ')).toContain('not found on the node');
  });

  test('alerts when paid amount does not match the order amount', async () => {
    const { reconciler } = makeReconciler({
      orders: [makeOrder({ amount: 50000 })],
      invoices: { [HOLD_HASH]: settledHoldInvoice() },
    });

    const result = await reconciler.classifyPayment(
      makePayment({ tokens: 100000 })
    );

    expect(result.verdict).toBe('alert');
    expect(result.problems.join(' ')).toContain('order.amount is 50000');
  });

  test('alerts when the hold invoice received less than what was paid out', async () => {
    const { reconciler } = makeReconciler({
      orders: [makeOrder()],
      invoices: { [HOLD_HASH]: settledHoldInvoice(1000) },
    });

    const result = await reconciler.classifyPayment(makePayment());

    expect(result.verdict).toBe('alert');
    expect(result.problems.join(' ')).toContain('received 1000 sats');
  });

  test('accepts a community earnings withdrawal matched by hash', async () => {
    const { reconciler } = makeReconciler({
      pendingPayments: [
        {
          hash: COMMUNITY_HASH,
          community_id: 'community1',
          paid: true,
          payment_request: 'lnbc1communityinvoice',
        },
      ],
    });

    const result = await reconciler.classifyPayment(
      makePayment({ id: COMMUNITY_HASH, request: 'lnbc1communityinvoice' })
    );

    expect(result.verdict).toBe('ok');
    expect(result.reason).toBe('community_withdrawal');
  });

  test('falls back to matching the paid invoice for orders without payout_hash', async () => {
    const { reconciler } = makeReconciler({
      orders: [
        makeOrder({ payout_hash: undefined, buyer_invoice: 'lnbc1legacy' }),
      ],
      invoices: { [HOLD_HASH]: settledHoldInvoice() },
    });

    const result = await reconciler.classifyPayment(
      makePayment({ id: ROGUE_HASH, request: 'lnbc1legacy' })
    );

    expect(result.verdict).toBe('ok');
    expect(result.reason).toBe('order_payout');
  });

  test('alerts on a payment with no matching order or withdrawal', async () => {
    const { reconciler } = makeReconciler({
      orders: [makeOrder()],
      invoices: { [HOLD_HASH]: settledHoldInvoice() },
    });

    const result = await reconciler.classifyPayment(
      makePayment({ id: ROGUE_HASH, request: 'lnbc1rogue' })
    );

    expect(result.verdict).toBe('alert');
    expect(result.reason).toBe('unmatched');
  });
});

describe('PaymentReconciler.run', () => {
  test('sends a telegram alert with amount, destination, invoice and hash', async () => {
    const payment = makePayment({ id: ROGUE_HASH, request: 'lnbc1rogue' });
    const { reconciler, sendAlert } = makeReconciler({ payments: [payment] });

    const { alerts } = await reconciler.run();

    expect(alerts).toBe(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const message = sendAlert.mock.calls[0][0];
    expect(message).toContain('100000 sats');
    expect(message).toContain('03deadbeef');
    expect(message).toContain(ROGUE_HASH);
    expect(message).toContain('lnbc1rogue');
  });

  test('does not alert twice for the same payment hash', async () => {
    const payment = makePayment({ id: ROGUE_HASH });
    const config = baseConfig();
    const { reconciler, sendAlert } = makeReconciler({
      payments: [payment],
      config,
    });

    await reconciler.run();
    // Second pass sees the same payment again (e.g. index rollback/lookback)
    reconciler.state.lastIndex = 0;
    await reconciler.run();

    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  test('ignores payments confirmed before the baseline date', async () => {
    const payment = makePayment({
      id: ROGUE_HASH,
      confirmed_at: '2020-01-01T00:00:00.000Z',
    });
    const { reconciler, sendAlert } = makeReconciler({ payments: [payment] });

    const { scanned } = await reconciler.run();

    expect(scanned).toBe(0);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  test('does not advance the checkpoint past an in-flight payment', async () => {
    // LND assigns the index at initiation: if the checkpoint moved past an
    // unconfirmed payment, it would never be examined after settling.
    const payment = makePayment({
      id: ROGUE_HASH,
      is_confirmed: false,
      index: 7,
    });
    const { reconciler, sendAlert } = makeReconciler({ payments: [payment] });

    await reconciler.run();

    expect(sendAlert).not.toHaveBeenCalled();
    expect(reconciler.state.lastIndex).toBeLessThan(7);
  });

  test('re-examines an in-flight payment once it settles', async () => {
    const getPayments = jest
      .fn()
      .mockResolvedValueOnce({
        payments: [
          makePayment({ id: ROGUE_HASH, is_confirmed: false, index: 7 }),
        ],
        next: null,
      })
      .mockImplementation(async ({ token }) => {
        // Second pass must ask for an offset below the in-flight index
        const offset = token ? JSON.parse(token).offset : 0;
        const settled = makePayment({
          id: ROGUE_HASH,
          is_confirmed: true,
          index: 7,
        });
        return { payments: settled.index > offset ? [settled] : [], next: null };
      });
    const sendAlert = jest.fn().mockResolvedValue(true);
    const reconciler = new PaymentReconciler(baseConfig(), sendAlert, {
      db: makeDb(),
      getPayments,
      getInvoice: jest.fn(),
    });

    await reconciler.run();
    expect(sendAlert).not.toHaveBeenCalled();

    await reconciler.run();
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(reconciler.state.lastIndex).toBe(7);
  });

  test('verified payments do not trigger alerts', async () => {
    const { reconciler, sendAlert } = makeReconciler({
      payments: [makePayment()],
      orders: [makeOrder()],
      invoices: { [HOLD_HASH]: settledHoldInvoice() },
    });

    const { scanned, alerts } = await reconciler.run();

    expect(scanned).toBe(1);
    expect(alerts).toBe(0);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  test('persists state across instances', async () => {
    const config = baseConfig();
    const payment = makePayment({ id: ROGUE_HASH, index: 42 });
    const { reconciler } = makeReconciler({ payments: [payment], config });

    await reconciler.run();

    const second = new PaymentReconciler(config, jest.fn(), {
      db: makeDb(),
      getPayments: jest.fn().mockResolvedValue({ payments: [], next: null }),
      getInvoice: jest.fn(),
    });
    expect(second.state.lastIndex).toBe(42);
    expect(second.state.alerted[ROGUE_HASH]).toBeDefined();
  });

  test('does not mark a payment as alerted if the telegram send fails', async () => {
    const payment = makePayment({ id: ROGUE_HASH });
    const config = baseConfig();
    const sendAlert = jest.fn().mockResolvedValue(false);
    const reconciler = new PaymentReconciler(config, sendAlert, {
      db: makeDb(),
      getPayments: jest.fn().mockResolvedValue({ payments: [payment] }),
      getInvoice: jest.fn(),
    });

    await reconciler.run();

    expect(reconciler.state.alerted[ROGUE_HASH]).toBeUndefined();
    // The checkpoint must not advance past it either, so it is retried
    expect(reconciler.state.lastIndex).toBeLessThan(payment.index);
  });
});
