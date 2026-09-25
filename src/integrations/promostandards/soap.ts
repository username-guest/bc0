/**
 * SOAP 1.1 transport for PromoStandards services (ADR 0017).
 *
 * Supplier endpoint URLs are typed in by distributors, so requests get the same SSRF protection as
 * CRM webhooks (ADR 0008): https only, no credentials in the URL, no internal names, every
 * resolved address checked at connect time, redirects never followed. Unlike a webhook the body
 * matters here, so it's read, capped at 20 MB, and parsed with the strict reader in ./xml.
 */
import http from 'node:http';
import https from 'node:https';
import { guardedLookup } from '@/server/net/address-guard';
import { webhookUrlProblem } from '@/shared/providers/webhook-crm';
import { child, find, findAll, parseXml, text, type XmlNode } from './xml';

export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

export interface SoapRequest {
  url: string;
  /** SOAPAction header value, e.g. "getProduct". */
  action: string;
  /** The body element(s), already serialised. */
  body: string;
  /** Namespace declarations for the envelope, prefix → URI. */
  namespaces: Record<string, string>;
}

/** Sends a request and returns the raw XML text; injectable so tests need no network. */
export type SoapPost = (url: string, action: string, xml: string) => Promise<{ status: number; body: string }>;

export type SoapErrorKind = 'network' | 'http' | 'fault' | 'service' | 'parse';

export class SoapError extends Error {
  /** 'network' and 'http' may succeed on retry; 'fault' and 'service' need a person. */
  readonly kind: SoapErrorKind;
  readonly code: string | undefined;
  constructor(message: string, kind: SoapErrorKind, code?: string) {
    super(message);
    this.name = 'SoapError';
    this.kind = kind;
    this.code = code;
  }
}

export function endpointProblem(raw: string, allowInsecure = false): string | null {
  return webhookUrlProblem(raw, allowInsecure);
}

export function envelope(req: Pick<SoapRequest, 'body' | 'namespaces'>): string {
  const ns = Object.entries(req.namespaces)
    .map(([p, uri]) => ` xmlns:${p}="${uri}"`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"${ns}><soapenv:Header/><soapenv:Body>${req.body}</soapenv:Body></soapenv:Envelope>`;
}

/**
 * Call a service and return the Body's first element. SOAP faults and PromoStandards
 * ServiceMessages with severity "Error" become SoapError; warnings are returned for the caller.
 */
export async function call(post: SoapPost, req: SoapRequest): Promise<{ body: XmlNode; messages: ServiceMessage[] }> {
  const res = await post(req.url, req.action, envelope(req));
  let doc: XmlNode;
  try {
    doc = parseXml(res.body);
  } catch (e) {
    if (res.status < 200 || res.status >= 300) throw new SoapError(`Supplier answered HTTP ${res.status}`, 'http', String(res.status));
    throw new SoapError(`Supplier sent unreadable XML (${(e as Error).message})`, 'parse');
  }
  const body = child(doc, 'Body');
  const fault = child(body, 'Fault');
  if (fault) {
    const msg = text(fault, 'faultstring') ?? 'SOAP fault';
    throw new SoapError(`Supplier returned a fault: ${msg}`, 'fault', text(fault, 'faultcode'));
  }
  if (res.status < 200 || res.status >= 300) throw new SoapError(`Supplier answered HTTP ${res.status}`, 'http', String(res.status));
  const first = body?.children[0];
  if (!first) throw new SoapError('Supplier sent an empty SOAP body', 'parse');
  const messages = serviceMessages(first);
  const err = messages.find((m) => m.severity === 'Error');
  if (err) throw new SoapError(`${err.description} (code ${err.code})`, 'service', err.code);
  return { body: first, messages };
}

export interface ServiceMessage {
  code: string;
  description: string;
  severity: 'Error' | 'Warning' | 'Information';
}

/** PromoStandards puts errors in a ServiceMessageArray (or, in older services, ErrorMessage). */
export function serviceMessages(n: XmlNode): ServiceMessage[] {
  const out: ServiceMessage[] = [];
  for (const m of findAll(n, 'ServiceMessage')) {
    const sev = text(m, 'severity') ?? 'Error';
    out.push({
      code: text(m, 'code') ?? '',
      description: text(m, 'description') ?? 'Unknown supplier error',
      severity: sev === 'Warning' || sev === 'Information' ? sev : 'Error',
    });
  }
  const legacy = find(n, 'ErrorMessage');
  if (legacy && (text(legacy, 'code') || text(legacy, 'description'))) {
    out.push({ code: text(legacy, 'code') ?? '', description: text(legacy, 'description') ?? 'Unknown supplier error', severity: 'Error' });
  }
  return out;
}

export interface HttpPostOptions {
  timeoutMs?: number;
  /** Tests only: allow http:// and skip the address guard. */
  allowInsecure?: boolean;
  resolver?: Parameters<typeof guardedLookup>[0];
}

/** The real transport: node http(s) with the address guard as the socket lookup. */
export function httpPost(opts: HttpPostOptions = {}): SoapPost {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const insecure = opts.allowInsecure ?? false;
  const lookup = insecure ? undefined : guardedLookup(opts.resolver);
  return (url, action, xml) => {
    const problem = endpointProblem(url, insecure);
    if (problem) return Promise.reject(new SoapError(`Endpoint ${problem}`, 'network'));
    const u = new URL(url);
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
            'content-type': 'text/xml; charset=utf-8',
            'content-length': Buffer.byteLength(xml),
            soapaction: `"${action}"`,
            'user-agent': 'BrandCanvas-PromoStandards/1',
          },
          ...(lookup ? { lookup: lookup as unknown as http.RequestOptions['lookup'] } : {}),
          agent: false,
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            return reject(new SoapError(`Supplier answered ${status} (redirects are not followed)`, 'http', String(status)));
          }
          const chunks: Buffer[] = [];
          let seen = 0;
          res.on('data', (c: Buffer) => {
            seen += c.length;
            if (seen > MAX_RESPONSE_BYTES) {
              res.destroy();
              reject(new SoapError('Supplier response is larger than 20 MB', 'parse'));
            } else chunks.push(c);
          });
          res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', (e) => reject(new SoapError(e.message, 'network')));
        },
      );
      req.on('timeout', () => req.destroy(new Error(`${u.host} did not answer within ${timeoutMs / 1000} s`)));
      req.on('error', (e) => reject(e instanceof SoapError ? e : new SoapError(`${u.host}: ${e.message}`, 'network')));
      req.end(xml);
    });
  };
}
