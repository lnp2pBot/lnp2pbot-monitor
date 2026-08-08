const fs = require('fs');
const path = require('path');
const { logger } = require('./utils');

const PAGE_SIZE = 250;
const ALERT_RETENTION_DAYS = 90;
// Alert the admins after this many consecutive failed passes, at most once
// per throttle window. With the default 10-minute interval the first alert
// fires after ~30 minutes without reconciliation.
const PASS_FAILURE_ALERT_THRESHOLD = 3;
const PASS_FAILURE_ALERT_THROTTLE_MS = 60 * 60 * 1000;

/**
 * Reconciles outgoing Lightning payments made by the bot's node against the
 * bot's database. The node (LND ListPayments) is the source of truth for
 * money leaving the node; every settled outgoing payment must be backed by:
 *
 *   1. An order payout: Order.payout_hash === payment hash, whose hold
 *      invoice (Order.hash) was settled on the node for at least the amount
 *      paid out, or
 *   2. A community earnings withdrawal: PendingPayment with community_id set
 *      and hash === payment hash.
 *
 * Matching is done by payment hash, never by time, so a payout that settles
 * days after the seller released the funds still reconciles correctly.
 * Anything that doesn't match triggers a critical Telegram alert.
 */
class PaymentReconciler {
  /**
   * @param {object} config - Monitor configuration
   * @param {function} sendAlert - async (message) => boolean
   * @param {object} [deps] - Injectable dependencies (used in tests)
   * @param {object} [deps.db] - MongoDB database handle
   * @param {function} [deps.getPayments] - async ({token,limit}) => {payments, next}
   * @param {function} [deps.getInvoice] - async (hash) => invoice | null
   */
  constructor(config, sendAlert, deps = {}) {
    this.config = config;
    this.sendAlert = sendAlert;
    this.db = deps.db || null;
    this.lndGetPayments = deps.getPayments || null;
    this.lndGetInvoice = deps.getInvoice || null;
    this.mongoClient = null;
    this.isRunning = false;
    this.intervalHandle = null;
    this.lastError = null;
    this.consecutivePassFailures = 0;
    this.lastPassFailureAlertAt = 0;
    this.statePath =
      config.RECONCILIATION_STATE_FILE ||
      path.join(process.cwd(), 'data', 'reconciliation-state.json');
    this.state = this.loadState();
  }

  loadState() {
    const defaults = { baselineAt: null, lastIndex: 0, alerted: {} };
    try {
      if (fs.existsSync(this.statePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          // A hand-edited or corrupt baselineAt would parse to NaN and
          // silently disable the baseline filter (every comparison against
          // NaN is false), making the first pass classify the full payment
          // history. Drop it and let run() set a fresh baseline instead.
          let baselineAt = parsed.baselineAt || null;
          if (baselineAt && isNaN(new Date(baselineAt).getTime())) {
            logger.warn('Ignoring invalid baselineAt in reconciliation state', {
              baselineAt,
              statePath: this.statePath,
            });
            baselineAt = null;
          }
          // Merge over defaults: a hand-edited or older-format file must not
          // leave fields like `alerted` undefined and crash every pass.
          return {
            ...defaults,
            ...parsed,
            baselineAt,
            lastIndex: Number(parsed.lastIndex) || 0,
            alerted:
              parsed.alerted && typeof parsed.alerted === 'object'
                ? parsed.alerted
                : {},
          };
        }
      }
    } catch (error) {
      logger.error('Failed to load reconciliation state, starting fresh', {
        error: error.message,
        statePath: this.statePath,
      });
    }
    return defaults;
  }

  saveState() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const tmpPath = this.statePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmpPath, this.statePath);
    } catch (error) {
      logger.error('Failed to save reconciliation state', {
        error: error.message,
        statePath: this.statePath,
      });
    }
  }

  /**
   * Connect to MongoDB and LND (production path; tests inject deps instead)
   */
  async connect() {
    if (!this.db) {
      const { MongoClient } = require('mongodb');
      this.mongoClient = new MongoClient(this.config.MONGO_URI);
      await this.mongoClient.connect();
      this.db = this.mongoClient.db(); // db name comes from the URI
      logger.info('Reconciliation: connected to MongoDB');
    }

    if (!this.lndGetPayments || !this.lndGetInvoice) {
      const {
        authenticatedLndGrpc,
        getPayments,
        getInvoice,
      } = require('lightning');
      const { lnd } = authenticatedLndGrpc({
        cert: this.config.LND_CERT_BASE64 || undefined,
        macaroon: this.config.LND_MACAROON_BASE64,
        socket: this.config.LND_GRPC_HOST,
      });
      this.lndGetPayments = (args) => getPayments({ lnd, ...args });
      this.lndGetInvoice = async (hash) => {
        try {
          return await getInvoice({ lnd, id: hash });
        } catch (error) {
          const message = Array.isArray(error)
            ? String(error[1] || error)
            : String(error);
          if (message.includes('UnableToLocateInvoice')) return null;
          throw error;
        }
      };
      logger.info('Reconciliation: LND client initialized', {
        socket: this.config.LND_GRPC_HOST,
      });
    }
  }

  /**
   * Fetch settled outgoing payments with index greater than state.lastIndex
   *
   * Pagination contract (LND ListPayments via the `lightning` library):
   * - The library always queries with `reversed: true`, i.e. BACKWARDS
   *   pagination: a request without token returns the NEWEST page and each
   *   `next` token walks one page further back in history. Never send a
   *   hand-made offset token: `index_offset` is exclusive and seeks backwards
   *   from it, so `{offset: lastIndex}` would only ever return payments OLDER
   *   than the checkpoint and no new payment would be seen again.
   * - `include_incomplete` stays false, so only SUCCEEDED payments are
   *   returned. In-flight payments are not listed at all and simply show up
   *   in a later pass once they settle; failed payments never moved money.
   *
   * @returns {Promise<Array>} New payments, newest first (as LND returns them)
   */
  async fetchNewPayments() {
    const payments = [];
    let token; // start tokenless: the newest page

    for (;;) {
      const args = token ? { token } : { limit: PAGE_SIZE };
      const res = await this.lndGetPayments(args);
      const page = res.payments || [];

      // Pages walk backwards through history: once a page contains a payment
      // at or below the checkpoint, every further page is older still.
      let reachedCheckpoint = false;
      for (const payment of page) {
        if (payment.index > this.state.lastIndex) {
          payments.push(payment);
        } else {
          reachedCheckpoint = true;
        }
      }

      if (reachedCheckpoint || !res.next || page.length === 0) break;
      token = res.next;
    }
    return payments;
  }

  /**
   * Classify a settled outgoing payment against the bot's database
   * @param {object} payment - LND payment (id, tokens, fee, destination, ...)
   * @returns {Promise<{verdict: 'ok'|'alert', reason: string, problems?: string[], order?: object}>}
   */
  async classifyPayment(payment) {
    const hash = payment.id;

    // 1. Buyer payout recorded on the order
    const order = await this.db
      .collection('orders')
      .findOne({ payout_hash: hash });
    if (order) return this.verifyOrderPayout(payment, order);

    // 2. Community earnings withdrawal (its hash is the withdraw invoice hash)
    const communityPending = await this.db
      .collection('pendingpayments')
      .findOne({ hash, community_id: { $ne: null } });
    if (communityPending) {
      return { verdict: 'ok', reason: 'community_withdrawal' };
    }

    // 3. Fallback for records that predate payout_hash: match by the exact
    //    invoice that was paid
    if (payment.request) {
      const orderByRequest = await this.db.collection('orders').findOne({
        $or: [
          { buyer_invoice_paid: payment.request },
          { buyer_invoice: payment.request },
        ],
      });
      if (orderByRequest) {
        return this.verifyOrderPayout(payment, orderByRequest);
      }

      const pendingByRequest = await this.db
        .collection('pendingpayments')
        .findOne({ payment_request: payment.request });
      if (pendingByRequest) {
        if (pendingByRequest.community_id) {
          return { verdict: 'ok', reason: 'community_withdrawal' };
        }
        const orderFromPending = await this.findOrderById(
          pendingByRequest.order_id
        );
        if (orderFromPending) {
          return this.verifyOrderPayout(payment, orderFromPending);
        }
      }
    }

    return {
      verdict: 'alert',
      reason: 'unmatched',
      problems: [
        'No order payout, retry, or community withdrawal matches this payment',
      ],
    };
  }

  async findOrderById(orderId) {
    if (!orderId) return null;
    try {
      const { ObjectId } = require('mongodb');
      return await this.db
        .collection('orders')
        .findOne({ _id: new ObjectId(String(orderId)) });
    } catch (error) {
      logger.warn('Reconciliation: invalid order id on pending payment', {
        orderId: String(orderId),
        error: error.message,
      });
      return null;
    }
  }

  /**
   * A payment matched an order — verify the money actually came in first:
   * the hold invoice must exist on the node, be settled, and have received
   * at least what was paid out.
   */
  async verifyOrderPayout(payment, order) {
    const problems = [];

    if (payment.tokens !== order.amount) {
      problems.push(
        `Paid ${payment.tokens} sats but order.amount is ${order.amount} sats`
      );
    }

    if (!order.hash) {
      problems.push('Order has no hold invoice hash (no incoming payment)');
    } else {
      const invoice = await this.lndGetInvoice(order.hash);
      if (!invoice) {
        problems.push(`Hold invoice ${order.hash} not found on the node`);
      } else if (!invoice.is_confirmed) {
        problems.push(
          `Hold invoice ${order.hash} was never settled (held: ${!!invoice.is_held})`
        );
      } else if ((invoice.received || 0) < payment.tokens) {
        problems.push(
          `Hold invoice received ${invoice.received || 0} sats but ` +
            `${payment.tokens} sats were paid out`
        );
      }
    }

    if (problems.length > 0) {
      return { verdict: 'alert', reason: 'order_mismatch', problems, order };
    }
    return { verdict: 'ok', reason: 'order_payout', order };
  }

  /**
   * Build the Telegram alert message for a suspicious payment
   */
  buildAlertMessage(payment, result) {
    const lines = [
      '🚨 CRITICAL: Outgoing payment without matching incoming payment!',
      '',
      `Amount: ${payment.tokens} sats (routing fee: ${payment.fee || 0} sats)`,
      `Destination: ${payment.destination || 'unknown'}`,
      `Payment hash: ${payment.id}`,
      `Confirmed at: ${payment.confirmed_at || 'unknown'}`,
    ];
    if (payment.request) lines.push(`Invoice: ${payment.request}`);
    if (result.order) {
      lines.push(
        `Matched order: ${result.order._id} (status: ${result.order.status})`
      );
    }
    lines.push('', `Reason: ${result.reason}`);
    for (const problem of result.problems || []) {
      lines.push(`- ${problem}`);
    }
    return lines.join('\n');
  }

  pruneAlertHistory() {
    const cutoff = Date.now() - ALERT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const [hash, ts] of Object.entries(this.state.alerted)) {
      if (ts < cutoff) delete this.state.alerted[hash];
    }
  }

  /**
   * One reconciliation pass: fetch new settled payments and classify each
   * @returns {Promise<{scanned: number, alerts: number}>}
   */
  async run() {
    if (this.isRunning) {
      logger.debug('Reconciliation already running, skipping this pass');
      return { scanned: 0, alerts: 0 };
    }
    this.isRunning = true;
    try {
      if (!this.state.baselineAt) {
        this.state.baselineAt =
          this.config.RECONCILIATION_START_DATE || new Date().toISOString();
        logger.info('Reconciliation baseline set', {
          baselineAt: this.state.baselineAt,
        });
      }
      const baseline = new Date(this.state.baselineAt).getTime();

      const payments = await this.fetchNewPayments();
      let alerts = 0;
      let scanned = 0;
      // Defense in depth: the LND call only returns settled payments
      // (include_incomplete stays false), but keep the unconfirmed guard so
      // that a payment observed in flight can never move the checkpoint past
      // itself. The same protection covers payments whose alert delivery
      // failed: they stay at or below the checkpoint and are retried.
      let highestSeen = this.state.lastIndex;
      let lowestUnresolved = Infinity;

      for (const payment of payments) {
        if (payment.index > highestSeen) highestSeen = payment.index;
        if (!payment.is_confirmed) {
          lowestUnresolved = Math.min(lowestUnresolved, payment.index);
          continue;
        }
        const confirmedAt = new Date(
          payment.confirmed_at || payment.created_at
        ).getTime();
        if (confirmedAt < baseline) continue;
        if (this.state.alerted[payment.id]) continue;

        scanned++;
        const result = await this.classifyPayment(payment);
        if (result.verdict === 'alert') {
          alerts++;
          logger.error('Reconciliation: suspicious outgoing payment', {
            hash: payment.id,
            tokens: payment.tokens,
            destination: payment.destination,
            reason: result.reason,
            problems: result.problems,
          });
          const sent = await this.sendAlert(
            this.buildAlertMessage(payment, result)
          );
          if (sent) this.state.alerted[payment.id] = Date.now();
          else lowestUnresolved = Math.min(lowestUnresolved, payment.index);
        } else {
          logger.info('Reconciliation: payment verified', {
            hash: payment.id,
            tokens: payment.tokens,
            reason: result.reason,
          });
        }
      }

      this.state.lastIndex = Math.min(highestSeen, lowestUnresolved - 1);
      this.pruneAlertHistory();
      this.saveState();
      logger.info('Reconciliation pass finished', {
        newPayments: payments.length,
        scanned,
        alerts,
        lastIndex: this.state.lastIndex,
      });
      return { scanned, alerts };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Run one pass without throwing: failures are recorded in lastError and,
   * once they persist, reported to the admins. A reconciler that cannot run
   * is silently providing no protection, so persistent failure must alert.
   */
  async runSafely() {
    try {
      const result = await this.run();
      this.consecutivePassFailures = 0;
      this.lastError = null;
      return result;
    } catch (error) {
      this.consecutivePassFailures++;
      this.lastError = `Reconciliation pass failed: ${error.message}`;
      logger.error('Reconciliation pass failed', {
        error: error.message,
        stack: error.stack,
        consecutiveFailures: this.consecutivePassFailures,
      });

      const throttled =
        Date.now() - this.lastPassFailureAlertAt <
        PASS_FAILURE_ALERT_THROTTLE_MS;
      if (
        this.consecutivePassFailures >= PASS_FAILURE_ALERT_THRESHOLD &&
        !throttled
      ) {
        const sent = await this.sendAlert(
          `🚨 CRITICAL: payment reconciliation has failed ${this.consecutivePassFailures} consecutive passes: ${error.message}. Outgoing payments are NOT being verified.`
        ).catch(() => false);
        if (sent) this.lastPassFailureAlertAt = Date.now();
      }
      return { scanned: 0, alerts: 0 };
    }
  }

  /**
   * Connect and start periodic reconciliation
   */
  async start() {
    await this.connect();
    const intervalMs = this.config.RECONCILIATION_INTERVAL * 60 * 1000;

    await this.runSafely();
    this.intervalHandle = setInterval(() => this.runSafely(), intervalMs);

    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());

    logger.info('Payment reconciliation started', {
      interval: this.config.RECONCILIATION_INTERVAL + ' minutes',
      baselineAt: this.state.baselineAt,
    });
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.mongoClient) {
      this.mongoClient.close().catch(() => {});
      this.mongoClient = null;
    }
  }

  getStatus() {
    return {
      enabled: true,
      baselineAt: this.state.baselineAt,
      lastPaymentIndex: this.state.lastIndex,
      alertedPayments: Object.keys(this.state.alerted).length,
      isRunning: this.isRunning,
      lastError: this.lastError,
      consecutivePassFailures: this.consecutivePassFailures,
    };
  }
}

module.exports = PaymentReconciler;
