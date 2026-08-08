const fs = require('fs');
const path = require('path');
const { logger } = require('./utils');

const PAGE_SIZE = 250;
const ALERT_RETENTION_DAYS = 90;
// State lives in the bot's MongoDB (survives ephemeral filesystems and
// redeploys); the JSON file is kept as a fallback for read-only credentials.
const STATE_COLLECTION = 'monitor_reconciliation_state';
const STATE_DOC_ID = 'reconciliation';
// Stop paginating once a whole page predates the baseline by this margin.
// The margin covers payments created before the baseline that settle after
// it: without a cutoff the first pass walks the node's entire payment
// history and can exhaust memory on small instances.
const BASELINE_CUTOFF_MARGIN_MS = 24 * 60 * 60 * 1000;
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
    this.remoteStateAvailable = false;
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

  /**
   * Validate and merge a raw state object (file or mongo) over defaults
   * @returns {object|null} Normalized state, or null if unusable
   */
  normalizeState(parsed) {
    const defaults = { baselineAt: null, lastIndex: 0, alerted: {} };
    if (!parsed || typeof parsed !== 'object') return null;
    // A hand-edited or corrupt baselineAt would parse to NaN and silently
    // disable the baseline filter (every comparison against NaN is false),
    // making the first pass classify the full payment history. Drop it and
    // let run() set a fresh baseline instead.
    let baselineAt = parsed.baselineAt || null;
    if (baselineAt && isNaN(new Date(baselineAt).getTime())) {
      logger.warn('Ignoring invalid baselineAt in reconciliation state', {
        baselineAt,
      });
      baselineAt = null;
    }
    // Merge over defaults: a hand-edited or older-format record must not
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

  loadState() {
    const defaults = { baselineAt: null, lastIndex: 0, alerted: {} };
    try {
      if (fs.existsSync(this.statePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        const normalized = this.normalizeState(parsed);
        if (normalized) return normalized;
      }
    } catch (error) {
      logger.error('Failed to load reconciliation state, starting fresh', {
        error: error.message,
        statePath: this.statePath,
      });
    }
    return defaults;
  }

  /**
   * Adopt the state stored in MongoDB. The local file lives on an ephemeral
   * filesystem on PaaS deploys, so the database copy is authoritative —
   * unless the file has a higher checkpoint (e.g. mongo writes were down for
   * a while); then the file wins. Alert history is merged either way so a
   * payment is never re-alerted.
   */
  async loadRemoteState() {
    try {
      const doc = await this.db
        .collection(STATE_COLLECTION)
        .findOne({ _id: STATE_DOC_ID });
      this.remoteStateAvailable = true;
      // Drop Mongo bookkeeping fields so they never leak into this.state
      // (and from there back into the JSON file).
      const stateFields = doc ? { ...doc } : null;
      if (stateFields) {
        delete stateFields._id;
        delete stateFields.updatedAt;
      }
      const remote = this.normalizeState(stateFields);
      if (!remote) return;
      const local = this.state;
      const chosen = remote.lastIndex >= local.lastIndex ? remote : local;
      this.state = {
        ...chosen,
        baselineAt: chosen.baselineAt || remote.baselineAt || local.baselineAt,
        alerted: { ...local.alerted, ...remote.alerted },
      };
      logger.info('Reconciliation state loaded from MongoDB', {
        lastIndex: this.state.lastIndex,
        baselineAt: this.state.baselineAt,
      });
    } catch (error) {
      this.remoteStateAvailable = false;
      logger.warn(
        'Reconciliation state not readable from MongoDB, using file only',
        { error: error.message }
      );
    }
  }

  async saveState() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const tmpPath = this.statePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmpPath, this.statePath);
    } catch (error) {
      logger.error('Failed to save reconciliation state file', {
        error: error.message,
        statePath: this.statePath,
      });
    }

    if (!this.remoteStateAvailable) return;
    try {
      await this.db
        .collection(STATE_COLLECTION)
        .updateOne(
          { _id: STATE_DOC_ID },
          { $set: { ...this.state, updatedAt: new Date() } },
          { upsert: true }
        );
    } catch (error) {
      // Read-only credentials land here on the first save: keep running on
      // the file fallback and stop retrying until the next restart.
      this.remoteStateAvailable = false;
      logger.error(
        'Failed to save reconciliation state to MongoDB, using file only',
        { error: error.message }
      );
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
    await this.loadRemoteState();

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
   * Stream settled outgoing payments with index greater than state.lastIndex
   * to the handler, one page at a time. Payments are never accumulated: a
   * first pass over a node with years of history must run in constant memory.
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
   * @param {function} handler - async (payment) => void, newest first
   * @param {number} cutoffMs - stop paging when a whole page resolved before
   *   this epoch-ms timestamp (0 disables the cutoff)
   */
  async forEachNewPayment(handler, cutoffMs) {
    let token; // start tokenless: the newest page

    for (;;) {
      const args = token ? { token } : { limit: PAGE_SIZE };
      const res = await this.lndGetPayments(args);
      const page = res.payments || [];

      // Pages walk backwards through history: once a page contains a payment
      // at or below the checkpoint, every further page is older still.
      let reachedCheckpoint = false;
      let newestResolvedAt = 0;
      for (const payment of page) {
        if (payment.index > this.state.lastIndex) {
          await handler(payment);
        } else {
          reachedCheckpoint = true;
        }
        const resolvedAt = new Date(
          payment.confirmed_at || payment.created_at
        ).getTime();
        if (resolvedAt > newestResolvedAt) newestResolvedAt = resolvedAt;
      }

      if (reachedCheckpoint || !res.next || page.length === 0) break;
      // Baseline cutoff: when even the newest payment of this page resolved
      // before the cutoff, deeper (older) pages cannot contain anything
      // classifiable — stop instead of walking the full history.
      if (cutoffMs && newestResolvedAt && newestResolvedAt < cutoffMs) break;
      token = res.next;
    }
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

      // Defense in depth: the LND call only returns settled payments
      // (include_incomplete stays false), but keep the unconfirmed guard so
      // that a payment observed in flight can never move the checkpoint past
      // itself. The same protection covers payments whose alert delivery
      // failed: they stay at or below the checkpoint and are retried.
      const pass = {
        baseline,
        newPayments: 0,
        scanned: 0,
        alerts: 0,
        highestSeen: this.state.lastIndex,
        lowestUnresolved: Infinity,
      };

      await this.forEachNewPayment(
        (payment) => this.processPayment(payment, pass),
        baseline - BASELINE_CUTOFF_MARGIN_MS
      );

      this.state.lastIndex = Math.min(
        pass.highestSeen,
        pass.lowestUnresolved - 1
      );
      this.pruneAlertHistory();
      await this.saveState();
      logger.info('Reconciliation pass finished', {
        newPayments: pass.newPayments,
        scanned: pass.scanned,
        alerts: pass.alerts,
        lastIndex: this.state.lastIndex,
      });
      return { scanned: pass.scanned, alerts: pass.alerts };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Classify a single streamed payment and update the pass counters
   * @param {object} payment - LND payment
   * @param {object} pass - Mutable per-pass counters (see run())
   */
  async processPayment(payment, pass) {
    pass.newPayments++;
    if (payment.index > pass.highestSeen) pass.highestSeen = payment.index;
    if (!payment.is_confirmed) {
      pass.lowestUnresolved = Math.min(pass.lowestUnresolved, payment.index);
      return;
    }
    const confirmedAt = new Date(
      payment.confirmed_at || payment.created_at
    ).getTime();
    if (confirmedAt < pass.baseline) return;
    if (this.state.alerted[payment.id]) return;

    pass.scanned++;
    const result = await this.classifyPayment(payment);
    if (result.verdict === 'alert') {
      pass.alerts++;
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
      else
        pass.lowestUnresolved = Math.min(pass.lowestUnresolved, payment.index);
    } else {
      logger.info('Reconciliation: payment verified', {
        hash: payment.id,
        tokens: payment.tokens,
        reason: result.reason,
      });
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
      stateStorage: this.remoteStateAvailable ? 'mongodb' : 'file',
      lastError: this.lastError,
      consecutivePassFailures: this.consecutivePassFailures,
    };
  }
}

module.exports = PaymentReconciler;
