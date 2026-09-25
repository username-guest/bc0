/**
 * S3-compatible StorageProvider (`STORAGE_DRIVER=s3`): AWS S3, Cloudflare R2, MinIO, Backblaze B2…
 * No SDK: requests are signed with AWS Signature Version 4 using node:crypto, and sent with fetch.
 *
 * Same guarantees as the local adapter (ADR 0006):
 *   - Objects live at `<tenantId>/<key>`, and keys are VALIDATED (not sanitised) with the same
 *     rules, so nothing can address another tenant's prefix.
 *   - The bucket stays PRIVATE. The app serves every file through its own tenant-checked routes;
 *     `getUrl` returns that app path, never a public or presigned bucket URL.
 *   - `get` returns null for a missing object; deleting a missing object is not an error.
 *
 * Reliability: every call has a timeout; network errors, 5xx and 429 are retried (all four
 * operations are idempotent). Credentials never appear in errors.
 *
 * Permissions needed on the bucket: s3:GetObject, s3:PutObject, s3:DeleteObject, and
 * s3:ListBucket — without ListBucket, AWS answers 403 instead of 404 for a missing object, which
 * this adapter (correctly) treats as an error rather than "not found".
 */
import { createHash, createHmac } from 'node:crypto';
import type { AssetRef, StorageProvider, StoredObject } from './index';
import { assertSafeKey } from './local-fs-storage';

const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** e.g. https://<account>.r2.cloudflarestorage.com or http://localhost:9000. Omit for AWS. */
  endpoint?: string;
  /** `https://host/bucket/key` instead of `https://bucket.host/key`. Default: true with a custom endpoint. */
  forcePathStyle?: boolean;
  /** Path the app serves files under (same as the local adapter). */
  publicBase?: string;
  timeoutMs?: number;
  retries?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/* ------------------------------------------------------------------ SigV4 */

const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  url: URL;
  /** Headers to sign, besides host / x-amz-date / x-amz-content-sha256 (which are added). */
  headers?: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  now: Date;
}

/**
 * Header-based SigV4 (single chunk). Returns every header to send, including Authorization.
 * Exported so the AWS documentation vector can pin it.
 */
export function signV4(i: SignInput): { headers: Record<string, string>; canonicalRequestHash: string } {
  const amzDate = i.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const day = amzDate.slice(0, 8);
  const service = i.service ?? 's3';
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(i.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: i.url.host,
    'x-amz-content-sha256': i.payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  // S3 paths are not normalised; each segment is encoded, '/' kept.
  const canonicalUri = i.url.pathname.split('/').map((seg) => uriEncode(decodeURIComponent(seg))).join('/');
  const canonicalQuery = [...i.url.searchParams]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [i.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, i.payloadHash].join('\n');
  const canonicalRequestHash = sha256Hex(canonicalRequest);
  const scope = `${day}/${i.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, canonicalRequestHash].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return { headers, canonicalRequestHash };
}

/* -------------------------------------------------------------- Provider */

export class S3StorageError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'S3StorageError';
    this.status = status;
  }
}

export class S3StorageProvider implements StorageProvider {
  private readonly c: Required<Omit<S3Config, 'endpoint' | 'forcePathStyle'>> & { base: URL; pathStyle: boolean };

  constructor(config: S3Config) {
    for (const k of ['bucket', 'region', 'accessKeyId', 'secretAccessKey'] as const) {
      if (!config[k]) throw new Error(`S3 storage: ${k} is required`);
    }
    const base = new URL(config.endpoint ?? `https://s3.${config.region}.amazonaws.com`);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('S3 storage: endpoint must be http(s)');
    this.c = {
      bucket: config.bucket,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      publicBase: config.publicBase ?? '/files',
      timeoutMs: config.timeoutMs ?? 15_000,
      retries: config.retries ?? 2,
      fetch: config.fetch ?? fetch,
      now: config.now ?? (() => new Date()),
      sleep: config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      base,
      pathStyle: config.forcePathStyle ?? !!config.endpoint,
    };
  }

  /** `<tenantId>/<key>`, validated exactly like the local adapter. */
  objectKey(key: string, tenantId: string): string {
    if (!TENANT.test(tenantId)) throw new Error('Invalid tenant id');
    assertSafeKey(key);
    return `${tenantId.toLowerCase()}/${key}`;
  }

  private url(objectKey: string): URL {
    const u = new URL(this.c.base.href);
    const prefix = u.pathname.replace(/\/+$/, '');
    if (this.c.pathStyle) u.pathname = `${prefix}/${this.c.bucket}/${objectKey}`;
    else {
      u.hostname = `${this.c.bucket}.${u.hostname}`;
      u.pathname = `${prefix}/${objectKey}`;
    }
    return u;
  }

  private async send(method: 'GET' | 'PUT' | 'DELETE', objectKey: string, body?: Uint8Array, contentType?: string): Promise<Response> {
    const url = this.url(objectKey);
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.c.retries; attempt++) {
      if (attempt) await this.c.sleep(200 * 3 ** (attempt - 1));
      // Re-signed per attempt: the signature embeds the time.
      const { headers } = signV4({
        method,
        url,
        headers: contentType ? { 'content-type': contentType } : {},
        payloadHash,
        accessKeyId: this.c.accessKeyId,
        secretAccessKey: this.c.secretAccessKey,
        region: this.c.region,
        now: this.c.now(),
      });
      delete headers.host; // fetch sets Host from the URL (identical value)
      try {
        const res = await this.c.fetch(url, {
          method,
          headers,
          ...(body ? { body: body as unknown as BodyInit } : {}),
          signal: AbortSignal.timeout(this.c.timeoutMs),
        });
        if (res.status >= 500 || res.status === 429) {
          lastError = new S3StorageError(`S3 ${method} failed with ${res.status}`, res.status);
          await res.body?.cancel();
          continue;
        }
        return res;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof S3StorageError ? lastError : new S3StorageError(`S3 ${method} failed: ${(lastError as Error)?.message ?? 'network error'}`);
  }

  private async fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1];
    throw new S3StorageError(`S3 ${what} failed with ${res.status}${code ? ` (${code})` : ''}`, res.status);
  }

  async put(key: string, data: Uint8Array, contentType: string, tenantId: string): Promise<AssetRef> {
    const k = this.objectKey(key, tenantId);
    const res = await this.send('PUT', k, data, contentType);
    if (!res.ok) await this.fail(res, 'PUT');
    await res.body?.cancel();
    return { id: key, url: await this.getUrl(key, tenantId), contentType, bytes: data.byteLength, tenantId };
  }

  async get(key: string, tenantId: string): Promise<StoredObject | null> {
    const res = await this.send('GET', this.objectKey(key, tenantId));
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) await this.fail(res, 'GET');
    return { data: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  async getUrl(key: string, tenantId: string): Promise<string> {
    this.objectKey(key, tenantId); // validate
    return `${this.c.publicBase}/${tenantId}/${key}`;
  }

  async delete(key: string, tenantId: string): Promise<void> {
    const res = await this.send('DELETE', this.objectKey(key, tenantId));
    if (!res.ok && res.status !== 404) await this.fail(res, 'DELETE');
    await res.body?.cancel();
  }
}
