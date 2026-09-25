/**
 * Webhook CrmProvider: POSTs each lead as JSON to the tenant's endpoint (Zapier, Make, a CRM's
 * inbound hook, or their own server). ADR 0007, hardened in ADR 0008.
 *
 * - Signed: `X-BrandCanvas-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` with the
 *   tenant's secret, so receivers can verify origin and reject replays.
 * - SSRF-guarded at two levels: the URL must be https with no credentials and not name an
 *   internal host (cheap, gives a clear message in the settings form), and at connect time every
 *   resolved address must be public. The guard IS the socket lookup, so the checked address is
 *   the connected address (no DNS-rebinding window).
 * - Never follows redirects (a 3xx is an error), 5 s timeout, response body capped and ignored.
 */
import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { guardedLookup, isBlockedAddress } from '@/server/net/address-guard';
import { isIP } from 'node:net';
import type { CrmProvider, LeadPayload } from './index';

/** Internal NAMES. IP literals (in any spelling the URL parser normalises) go to isBlockedAddress. */
const BLOCKED_HOST = [/^localhost$/i, /\.localhost$/i, /\.internal$/i, /\.local$/i, /^metadata\.google\.internal$/i];

export function webhookUrlProblem(raw: string, allowInsecure = false): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'https:' && !(allowInsecure && u.protocol === 'http:')) return 'must use https';
  if (u.username || u.password) return 'must not contain credentials';
  if (allowInsecure) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) ? isBlockedAddress(host) : BLOCKED_HOST.some((re) => re.test(host))) {
    return 'points at a private or internal address';
  }
  // Names that resolve to private addresses are refused at connect time (address-guard).
  return null;
}

export function signWebhook(body: string, secret: string, unixTime: number): string {
  const v1 = createHmac('sha256', secret).update(`${unixTime}.${body}`).digest('hex');
  return `t=${unixTime},v1=${v1}`;
}

export interface WebhookOptions {
  timeoutMs?: number;
  /**
   * Tests only: allow http:// and skip the address guard (so a local test server is reachable).
   * Production config never sets it.
   */
  allowInsecure?: boolean;
  /** Tests only: substitute DNS (the guard still applies unless allowInsecure). */
  resolver?: Parameters<typeof guardedLookup>[0];
}

export class WebhookCrmProvider implements CrmProvider {
  private readonly url: URL;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly insecure: boolean;
  private readonly lookup: ReturnType<typeof guardedLookup> | undefined;

  constructor(url: string, secret: string, opts: WebhookOptions = {}) {
    const problem = webhookUrlProblem(url, opts.allowInsecure ?? false);
    if (problem) throw new Error(`Webhook URL ${problem}`);
    this.url = new URL(url);
    this.secret = secret;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.insecure = opts.allowInsecure ?? false;
    this.lookup = this.insecure ? undefined : guardedLookup(opts.resolver);
  }

  async route(lead: LeadPayload): Promise<{ id: string; routedTo: string }> {
    await this.send({ type: 'lead.created', lead });
    return { id: lead.leadId ?? 'unknown', routedTo: this.url.host };
  }

  /** Admin "send test": a signed `ping` event receivers can recognise and ignore. */
  async ping(tenantId: string): Promise<void> {
    await this.send({ type: 'ping', tenantId, sentAt: new Date().toISOString() });
  }

  private async send(event: Record<string, unknown>): Promise<void> {
    const status = await this.post(JSON.stringify(event));
    if (status >= 300 && status < 400) throw new Error(`Webhook responded ${status} (redirects are not followed)`);
    if (status < 200 || status >= 300) throw new Error(`Webhook responded ${status}`);
  }

  private post(body: string): Promise<number> {
    const u = this.url;
    const mod = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          protocol: u.protocol,
          hostname: u.hostname.replace(/^\[|\]$/g, ''),
          port: u.port || undefined,
          path: `${u.pathname}${u.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'user-agent': 'BrandCanvas-Webhook/1',
            'x-brandcanvas-signature': signWebhook(body, this.secret, Math.floor(Date.now() / 1000)),
          },
          ...(this.lookup ? { lookup: this.lookup as unknown as http.RequestOptions['lookup'] } : {}),
          agent: false, // no pooled sockets: every delivery re-resolves and re-checks
          timeout: this.timeoutMs,
        },
        (res) => {
          // Drain (bounded) so the socket closes; the body is not used.
          let seen = 0;
          res.on('data', (c: Buffer) => {
            seen += c.length;
            if (seen > 64 * 1024) res.destroy();
          });
          res.on('end', () => resolve(res.statusCode ?? 0));
          res.on('close', () => resolve(res.statusCode ?? 0));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`${u.host} did not answer within ${this.timeoutMs / 1000} s`)));
      req.on('error', (e: NodeJS.ErrnoException) => reject(readableNetError(e, u.host)));
      req.end(body);
    });
  }
}

/** Network errors as an admin will read them in the lead timeline. */
function readableNetError(e: NodeJS.ErrnoException, host: string): Error {
  const why: Record<string, string> = {
    ECONNREFUSED: 'refused the connection',
    ECONNRESET: 'dropped the connection',
    ENOTFOUND: 'could not be found (check the address)',
    EAI_AGAIN: 'could not be looked up right now',
    ETIMEDOUT: 'did not answer in time',
    EHOSTUNREACH: 'is unreachable',
    CERT_HAS_EXPIRED: 'has an expired HTTPS certificate',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'uses a self-signed HTTPS certificate',
    ERR_TLS_CERT_ALTNAME_INVALID: "has an HTTPS certificate for a different name",
  };
  const reason = e.code ? why[e.code] : undefined;
  return reason ? new Error(`${host} ${reason} (${e.code})`) : e;
}
