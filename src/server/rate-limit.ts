/**
 * Fixed-window rate limiting (§12 abuse protection for uploads, renders, leads and sign-in).
 *
 * The limiter holds the policy (max per window); a `RateWindowStore` holds the counters:
 *   - MemoryWindowStore   — per process (development, single node).
 *   - Postgres store      — shared by every instance (src/server/repos/drizzle.ts), so limits
 *                           hold across a horizontally scaled deployment (ADR 0010).
 *
 * Failure policy: if the store errors, the request is ALLOWED and the error logged (throttled).
 * Rate limiting is abuse protection, not authorisation — a database blip must not lock every
 * prospect out of the storefront. Authentication itself still fails closed.
 */
export interface RateDecision {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface RateLimiter {
  hit(key: string, now?: number): Promise<RateDecision>;
}

/** Where window counters live. `bump` must be atomic, including across processes. */
export interface RateWindowStore {
  /**
   * Counts one hit on `key`. If the key's current window began `windowMs` or more before `now`,
   * a new window starts at `now` with count 1. Returns the window after this hit.
   */
  bump(key: string, windowMs: number, now: number): Promise<{ count: number; windowStart: number }>;
  /** Deletes windows that started before `before` (maintenance). Returns how many were removed. */
  sweep(before: number): Promise<number>;
}

export class MemoryWindowStore implements RateWindowStore {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly maxKeys: number;

  constructor(maxKeys = 50_000) {
    this.maxKeys = maxKeys;
  }

  async bump(key: string, windowMs: number, now: number) {
    let w = this.windows.get(key);
    if (!w || now - w.start >= windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      // Bound memory under key-spraying: drop windows that have certainly expired.
      if (this.windows.size > this.maxKeys) {
        for (const [k, v] of this.windows) if (now - v.start >= windowMs) this.windows.delete(k);
      }
    }
    w.count++;
    return { count: w.count, windowStart: w.start };
  }

  async sweep(before: number) {
    let n = 0;
    for (const [k, v] of this.windows) {
      if (v.start < before) {
        this.windows.delete(k);
        n++;
      }
    }
    return n;
  }
}

export interface LimiterOptions {
  /** Shared store. Omit for a private in-memory store (the pre-ADR-0010 behaviour). */
  store?: RateWindowStore;
  /** Required with a shared store: namespaces this limiter's keys from other limiters'. */
  name?: string;
  /** Called when the store fails (the request is allowed). Default: throttled console warning. */
  onStoreError?: (e: unknown) => void;
}

export class FixedWindowLimiter implements RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly store: RateWindowStore;
  private readonly prefix: string;
  private readonly onStoreError: (e: unknown) => void;

  constructor(max: number, windowMs: number, opts: LimiterOptions = {}) {
    if (opts.store && !opts.name) throw new Error('A shared rate-limit store needs a limiter name');
    this.max = max;
    this.windowMs = windowMs;
    this.store = opts.store ?? new MemoryWindowStore();
    this.prefix = opts.name ? `${opts.name}:` : '';
    this.onStoreError = opts.onStoreError ?? throttledWarn('[rate-limit] store unavailable, allowing request');
  }

  async hit(key: string, now = Date.now()): Promise<RateDecision> {
    let w: { count: number; windowStart: number };
    try {
      w = await this.store.bump(this.prefix + key, this.windowMs, now);
    } catch (e) {
      this.onStoreError(e);
      return { ok: true, remaining: this.max, retryAfterSec: 0 };
    }
    const ok = w.count <= this.max;
    return {
      ok,
      remaining: Math.max(0, this.max - w.count),
      retryAfterSec: ok ? 0 : Math.max(1, Math.ceil((w.windowStart + this.windowMs - now) / 1000)),
    };
  }
}

/** One warning per minute at most, so a store outage doesn't flood the logs. */
export function throttledWarn(prefix: string, everyMs = 60_000, log: (m: string) => void = (m) => console.warn(m)) {
  let last = -Infinity;
  return (e: unknown) => {
    const now = Date.now();
    if (now - last < everyMs) return;
    last = now;
    log(`${prefix}: ${(e as Error)?.message ?? String(e)}`);
  };
}
