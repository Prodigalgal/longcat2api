/**
 * Account pool concurrency + queue (inspired by mimo2api request-coordinator).
 * Limits parallel use of the same LongCat cookie account.
 */

function intEnv(name, def, lo, hi) {
  const n = Number(process.env[name] ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export class AccountCoordinator {
  constructor(opts = {}) {
    this.maxPerAccount = intEnv(
      'LONGCAT2API_ACCOUNT_MAX_CONCURRENCY',
      opts.maxPerAccount ?? 1,
      1,
      32
    );
    this.queueLimit = intEnv(
      'LONGCAT2API_ACCOUNT_QUEUE_LIMIT',
      opts.queueLimit ?? 200,
      1,
      10000
    );
    this.queueTimeoutMs = intEnv(
      'LONGCAT2API_ACCOUNT_QUEUE_TIMEOUT_MS',
      opts.queueTimeoutMs ?? 120000,
      1000,
      3600000
    );
    this.#active = new Map();
    this.#waiters = [];
    this.#cursor = 0;
    this.#closed = false;
  }

  #active;
  #waiters;
  #cursor;
  #closed;

  /**
   * @param {object[]} accounts raw account rows
   * @param {AbortSignal} [signal]
   */
  async acquireAny(accounts, signal) {
    if (this.#closed) {
      const e = new Error('account coordinator is shutting down');
      e.status = 503;
      e.code = 'account_coordinator_closed';
      throw e;
    }
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const candidates = uniqueById(accounts);
    if (!candidates.length) {
      const e = new Error(
        'no valid logged-in account; import longcat.chat Cookie (passport_token_key) first'
      );
      e.status = 503;
      e.code = 'no_account';
      throw e;
    }
    const immediate = this.#tryAcquire(candidates);
    if (immediate) return immediate;
    if (this.#waiters.length >= this.queueLimit) {
      const e = new Error('all accounts busy and local request queue is full');
      e.status = 429;
      e.code = 'account_queue_full';
      throw e;
    }

    return new Promise((resolve, reject) => {
      let timer;
      const waiter = {
        accounts: candidates,
        resolve,
        reject,
        settled: false,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
        },
      };
      const fail = (err) => {
        if (waiter.settled) return;
        waiter.settled = true;
        waiter.cleanup();
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(err);
      };
      const onAbort = () => fail(signal.reason || new Error('aborted'));
      timer = setTimeout(() => {
        const e = new Error('timed out waiting for an available account');
        e.status = 503;
        e.code = 'account_queue_timeout';
        fail(e);
      }, this.queueTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  acquire(account, signal) {
    return this.acquireAny([account], signal);
  }

  status() {
    return {
      active: [...this.#active.values()].reduce((s, n) => s + n, 0),
      queued: this.#waiters.length,
      busy_accounts: this.#active.size,
      max_per_account: this.maxPerAccount,
      queue_limit: this.queueLimit,
      queue_timeout_ms: this.queueTimeoutMs,
    };
  }

  close() {
    this.#closed = true;
    const e = new Error('account coordinator is shutting down');
    e.status = 503;
    e.code = 'account_coordinator_closed';
    for (const w of this.#waiters.splice(0)) {
      if (w.settled) continue;
      w.settled = true;
      w.cleanup();
      w.reject(e);
    }
  }

  #tryAcquire(accounts) {
    const available = accounts.filter(
      (a) => (this.#active.get(a.id) || 0) < this.maxPerAccount
    );
    if (!available.length) return undefined;
    const lowest = Math.min(...available.map((a) => this.#active.get(a.id) || 0));
    const least = available.filter((a) => (this.#active.get(a.id) || 0) === lowest);
    const account = least[this.#cursor % least.length];
    this.#cursor += 1;
    this.#active.set(account.id, (this.#active.get(account.id) || 0) + 1);
    let released = false;
    return {
      account,
      release: () => {
        if (released) return;
        released = true;
        const next = (this.#active.get(account.id) || 1) - 1;
        if (next > 0) this.#active.set(account.id, next);
        else this.#active.delete(account.id);
        this.#dispatch();
      },
    };
  }

  #dispatch() {
    if (!this.#waiters.length) return;
    for (let i = 0; i < this.#waiters.length; i++) {
      const w = this.#waiters[i];
      const lease = this.#tryAcquire(w.accounts);
      if (!lease) continue;
      this.#waiters.splice(i, 1);
      if (w.settled) {
        lease.release();
        continue;
      }
      w.settled = true;
      w.cleanup();
      w.resolve(lease);
      return;
    }
  }
}

function uniqueById(accounts) {
  const map = new Map();
  for (const a of accounts || []) {
    if (a?.id && !map.has(a.id)) map.set(a.id, a);
  }
  return [...map.values()];
}

/** Singleton used by OpenAI routes */
export const accountCoordinator = new AccountCoordinator();
