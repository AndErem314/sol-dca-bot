#!/usr/bin/env node
/**
 * Broker abstraction: paper (simulated fills, real prices) and
 * live (Jupiter Trigger v1 on free lite-api tier — endpoints verified live Oct 2026).
 *
 * v1 contract (discovered empirically from API validation errors + probes):
 *   POST /trigger/v1/createOrder
 *     { inputMint, outputMint, maker, payer,
 *       params: { makingAmount, takingAmount, slipBps, startAt(ms), expiredAt(unix SECONDS, string) } }
 *     -> { requestId, order, transaction(base64 VersionedTransaction) }
 *   POST /trigger/v1/execute { signedTransaction(base64), requestId } -> { signature, status }
 *   GET  /trigger/v1/orderHistory?user=&...   (200)
 *   GET  /trigger/v1/openOrders?user=&...     (200)
 *   POST /trigger/v1/cancelOrder { maker, order } -> unsigned withdrawal tx (then confirm)
 */
const { config } = require('./config');

// ─── Paper broker ────────────────────────────────────────────────

class PaperBroker {
  constructor(logger) {
    this.logger = logger;
    this.orders = new Map(); // id -> order
    this.nextId = 1;
    this.stats = { buysFilled: 0, sellsFilled: 0, cancelOps: 0, volumeQuote: 0 };
  }

  /**
   * Place a simulated limit order. Fills are checked in match(price).
   * side 'buy'  = spend quote, receive base at price <= limit triggers fill
   * side 'sell' = spend base, receive quote at price >= limit triggers fill
   */
  async place({ side, quoteAmount, baseAmount, limitPrice }) {
    const id = `paper-${this.nextId++}`;
    const order = { id, side, quoteAmount, baseAmount, limitPrice, status: 'open', createdAt: Date.now() };
    this.orders.set(id, order);
    this.logger.info(`[PAPER] ${side.toUpperCase()} ${quoteAmount.toFixed(2)}… limit ${limitPrice.toFixed(6)} → ${id}`);
    return { success: true, orderId: id };
  }

  /** Advance the simulation at a market price; returns array of fill events. */
  match(price) {
    const fills = [];
    for (const o of this.orders.values()) {
      if (o.status !== 'open') continue;
      const hit = o.side === 'buy' ? price <= o.limitPrice : price >= o.limitPrice;
      if (!hit) continue;
      o.status = 'filled';
      o.filledAt = Date.now();
      if (o.side === 'buy') {
        this.stats.buysFilled++;
        this.stats.volumeQuote += o.quoteAmount;
      } else {
        this.stats.sellsFilled++;
      }
      fills.push({
        orderId: o.id, side: o.side,
        filledPrice: o.limitPrice,           // limit orders fill AT limit (conservative)
        baseAmount: o.baseAmount,            // expected output for buys / input for sells
        quoteAmount: o.quoteAmount,
      });
      this.logger.info(`[PAPER] fill: ${o.side} ${o.id} @ ${o.limitPrice.toFixed(6)}`);
    }
    return fills;
  }

  async status(orderId) {
    const o = this.orders.get(orderId);
    if (!o) return { filled: false, unknown: true };
    return { filled: o.status === 'filled', state: o.status };
  }

  async cancel(orderId) {
    const o = this.orders.get(orderId);
    if (!o || o.status !== 'open') return false;
    o.status = 'cancelled';
    this.stats.cancelOps++;
    return true;
  }
}

// ─── Live broker: Jupiter Trigger v1 ─────────────────────────────

class JupiterBroker {
  constructor(logger, wallet, connection) {
    this.logger = logger;
    this.wallet = wallet;
    this.connection = connection;
    this.base = config.jupiterLiteBase;
  }

  async _post(path, body) {
    const resp = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data?.success === false) {
      const msg = data?.error?.issues
        ? JSON.stringify(data.error.issues).slice(0, 200)
        : (data?.error || data?.message || `HTTP ${resp.status}`);
      throw new Error(`Jupiter ${path}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return data;
  }

  /**
   * Create + execute a trigger order.
   * side 'buy': input=quote mint, output=base mint (making=quote atomic, taking=base atomic)
   * side 'sell': reversed.
   */
  async place({ side, makingAtomic, takingAtomic, isSell }) {
    const { VERSIONED } = { VERSIONED: true };
    const { VersionedTransaction } = require('@solana/web3.js');
    const inputMint = isSell ? config.baseMint : config.quoteMint;
    const outputMint = isSell ? config.quoteMint : config.baseMint;
    const maker = this.wallet.publicKey.toString();

    const created = await this._post('/trigger/v1/createOrder', {
      inputMint, outputMint, maker, payer: maker,
      params: {
        makingAmount: String(makingAtomic),
        takingAmount: String(takingAtomic),
        slipBps: config.slippageBps,
        startAt: Date.now(),
        expiredAt: String(Math.floor(Date.now() / 1000) + config.orderTtlSeconds), // unix SECONDS
      },
    });
    if (!created.requestId || !created.transaction) {
      throw new Error(`createOrder bad response: ${JSON.stringify(created).slice(0, 160)}`);
    }

    const tx = VersionedTransaction.deserialize(Buffer.from(created.transaction, 'base64'));
    tx.sign([this.wallet]);
    const signedTransaction = Buffer.from(tx.serialize()).toString('base64');

    const exec = await this._post('/trigger/v1/execute', {
      signedTransaction, requestId: created.requestId,
    });
    if (exec.status && exec.status !== 'Success') {
      throw new Error(`execute failed: ${exec.error || JSON.stringify(exec).slice(0, 160)}`);
    }
    this.logger.info(`[LIVE] ${side} order ${created.order} tx ${exec.signature}`);
    return { success: true, orderId: created.order, signature: exec.signature };
  }

  async getOpenOrders() {
    try {
      const resp = await fetch(
        `${this.base}/trigger/v1/openOrders?user=${this.wallet.publicKey.toString()}`,
        { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return [];
      const data = await resp.json();
      return Array.isArray(data) ? data : (data.orders || []);
    } catch { return []; }
  }

  async status(orderId) {
    // Order appears in history (past) as filled/cancelled; absent from active = terminal.
    try {
      const resp = await fetch(
        `${this.base}/trigger/v1/getTriggerOrders?user=${this.wallet.publicKey.toString()}&orderStatus=history`,
        { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return null;
      const data = await resp.json();
      const o = (data.orders || []).find(x => x.id === orderId || x.orderId === orderId);
      if (!o) return null;
      const st = (o.orderState || o.state || '').toLowerCase();
      return { filled: st === 'filled', state: st, raw: o };
    } catch { return null; }
  }

  async cancel(orderId) {
    try {
      const d = await this._post('/trigger/v1/cancelOrder', {
        maker: this.wallet.publicKey.toString(), order: orderId,
      });
      // v1 cancel returns an unsigned withdrawal transaction to sign + send
      if (d.transaction) {
        const { VersionedTransaction } = require('@solana/web3.js');
        const tx = VersionedTransaction.deserialize(Buffer.from(d.transaction, 'base64'));
        tx.sign([this.wallet]);
        const sig = await this.connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 2 });
        this.logger.info(`[LIVE] cancelled ${orderId}, withdrawal tx ${sig}`);
      }
      return true;
    } catch (e) {
      this.logger.error(`[LIVE] cancel ${orderId} failed: ${e.message}`);
      return false;
    }
  }
}

module.exports = { PaperBroker, JupiterBroker };
