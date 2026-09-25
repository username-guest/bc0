/**
 * Resend (https://resend.com) transactional email over its HTTP API. ADR 0008.
 * Verified here only against a stub server (request shape, auth header, error handling);
 * not yet against the live service.
 */
import type { EmailMessage, EmailProvider } from './index';

export class ResendEmailProvider implements EmailProvider {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly endpoint: string;
  constructor(apiKey: string, from: string, endpoint = 'https://api.resend.com/emails') {
    this.apiKey = apiKey;
    this.from = from;
    this.endpoint = endpoint;
  }
  async send(msg: EmailMessage): Promise<void> {
    const r = await fetch(this.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, text: msg.text }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Email provider responded ${r.status}`);
  }
}
