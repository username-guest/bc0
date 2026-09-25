import { describe, it, expect } from 'vitest';
import { S3StorageProvider, signV4 } from './s3-storage';

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

describe('SigV4', () => {
  it('matches the AWS documentation example (GET object with Range)', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    const { headers, canonicalRequestHash } = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      payloadHash: EMPTY,
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: SECRET,
      region: 'us-east-1',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(canonicalRequestHash).toBe('7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972');
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

/** In-memory S3 behind fetch: records every request so tests can see what went over the wire. */
function fakeS3(script: (Response | Error)[] = []) {
  const objects = new Map<string, { data: Uint8Array; type: string }>();
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const f = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = init.headers as Record<string, string>;
    calls.push({ method: init.method ?? 'GET', url: url.href, headers });
    const next = script.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    if (!headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=AK/')) return new Response('<Code>AccessDenied</Code>', { status: 403 });
    const k = url.pathname;
    if (init.method === 'PUT') {
      objects.set(k, { data: new Uint8Array(init.body as Uint8Array), type: headers['content-type'] ?? '' });
      return new Response(null, { status: 200 });
    }
    if (init.method === 'DELETE') {
      objects.delete(k);
      return new Response(null, { status: 204 });
    }
    const o = objects.get(k);
    return o ? new Response(o.data as unknown as BodyInit, { status: 200, headers: { 'content-type': o.type } }) : new Response('<Code>NoSuchKey</Code>', { status: 404 });
  }) as typeof fetch;
  return { f, objects, calls };
}

const make = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof S3StorageProvider>[0]> = {}) =>
  new S3StorageProvider({ bucket: 'assets', region: 'auto', accessKeyId: 'AK', secretAccessKey: SECRET, endpoint: 'http://minio.local:9000', fetch: f, sleep: async () => {}, ...extra });

describe('S3 storage provider', () => {
  it('round-trips bytes and content type; missing is null; deleting twice is fine', async () => {
    const s3 = fakeS3();
    const p = make(s3.f);
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const ref = await p.put('logos/abc/clean.png', bytes, 'image/png', TENANT_A);
    expect(ref).toMatchObject({ id: 'logos/abc/clean.png', bytes: 7, url: `/files/${TENANT_A}/logos/abc/clean.png` });
    const got = await p.get('logos/abc/clean.png', TENANT_A);
    expect(got?.contentType).toBe('image/png');
    expect(Array.from(got!.data)).toEqual(Array.from(bytes));
    expect(await p.get('logos/missing.png', TENANT_A)).toBeNull();
    await p.delete('logos/abc/clean.png', TENANT_A);
    await p.delete('logos/abc/clean.png', TENANT_A);
    expect(await p.get('logos/abc/clean.png', TENANT_A)).toBeNull();
  });

  it('stores each tenant under its own prefix, so one tenant cannot read another', async () => {
    const s3 = fakeS3();
    const p = make(s3.f);
    await p.put('proofs/x.png', new Uint8Array([1]), 'image/png', TENANT_A);
    expect(s3.calls[0]!.url).toBe(`http://minio.local:9000/assets/${TENANT_A}/proofs/x.png`);
    expect(await p.get('proofs/x.png', TENANT_B)).toBeNull();
  });

  it('rejects unsafe keys and bad tenant ids before any request is made', async () => {
    const s3 = fakeS3();
    const p = make(s3.f);
    for (const key of ['../x', '/abs', 'a//b', 'a/../../b', '.hidden', 'a\\b', '']) {
      await expect(p.get(key, TENANT_A)).rejects.toThrow(/Unsafe storage key/);
    }
    await expect(p.put('ok.png', new Uint8Array([1]), 'image/png', `${TENANT_A}/../${TENANT_B}`)).rejects.toThrow(/tenant/);
    expect(s3.calls).toHaveLength(0);
  });

  it('uses virtual-hosted URLs for AWS and path-style for custom endpoints', async () => {
    const aws = fakeS3([new Response(null, { status: 200 })]);
    await new S3StorageProvider({ bucket: 'assets', region: 'eu-west-1', accessKeyId: 'AK', secretAccessKey: SECRET, fetch: aws.f }).put('a.png', new Uint8Array([1]), 'image/png', TENANT_A);
    expect(aws.calls[0]!.url).toBe(`https://assets.s3.eu-west-1.amazonaws.com/${TENANT_A}/a.png`);
    expect(aws.calls[0]!.headers.authorization).toMatch(/\/eu-west-1\/s3\/aws4_request,SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/);
  });

  it('signs the body hash and content type on upload', async () => {
    const s3 = fakeS3();
    await make(s3.f).put('a.txt', new TextEncoder().encode('hello'), 'text/plain', TENANT_A);
    const h = s3.calls[0]!.headers;
    expect(h['x-amz-content-sha256']).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(h['content-type']).toBe('text/plain');
    expect(h.host).toBeUndefined(); // fetch derives Host from the URL
  });

  it('retries 5xx, 429 and network errors, re-signing each attempt', async () => {
    let t = Date.UTC(2030, 0, 1, 0, 0, 0);
    const s3 = fakeS3([new Response(null, { status: 503 }), new Error('ECONNRESET')]);
    const p = make(s3.f, { now: () => new Date((t += 1000)) });
    await p.put('a.png', new Uint8Array([1]), 'image/png', TENANT_A);
    expect(s3.calls).toHaveLength(3);
    expect(new Set(s3.calls.map((c) => c.headers['x-amz-date'])).size).toBe(3);
  });

  it('gives up after the retry budget and reports the status', async () => {
    const s3 = fakeS3([new Response(null, { status: 500 }), new Response(null, { status: 500 }), new Response(null, { status: 500 })]);
    await expect(make(s3.f).get('a.png', TENANT_A)).rejects.toThrow(/500/);
    expect(s3.calls).toHaveLength(3);
  });

  it('does not retry an authorisation failure, and never leaks the secret', async () => {
    const s3 = fakeS3([new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 })]);
    let msg = '';
    try {
      await make(s3.f).get('a.png', TENANT_A);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe('S3 GET failed with 403 (SignatureDoesNotMatch)');
    expect(msg.includes(SECRET)).toBe(false);
    expect(s3.calls).toHaveLength(1);
  });

  it('requires credentials and a bucket', () => {
    expect(() => new S3StorageProvider({ bucket: '', region: 'auto', accessKeyId: 'AK', secretAccessKey: 'x' })).toThrow(/bucket/);
    expect(() => new S3StorageProvider({ bucket: 'b', region: 'auto', accessKeyId: '', secretAccessKey: 'x' })).toThrow(/accessKeyId/);
  });
});
