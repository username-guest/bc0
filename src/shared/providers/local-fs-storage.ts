/**
 * Local-filesystem StorageProvider for development and single-node installs
 * (`STORAGE_DRIVER=local`). Production uses the S3-compatible adapter (same interface).
 *
 * Layout: <root>/<tenantId>/<key>  with a sidecar <key>.meta.json holding the content type.
 * Keys are validated, not sanitised: anything that could escape the tenant directory
 * (.., absolute paths, backslashes, NUL, empty segments) is REJECTED, so a bug upstream can't
 * turn into cross-tenant reads or arbitrary file writes.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetRef, StorageProvider, StoredObject } from './index';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertSafeKey(key: string): void {
  const parts = key.split('/');
  if (!key || parts.length > 8 || parts.some((p) => !SEGMENT.test(p) || p === '..' || p === '.')) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
  }
}

export class LocalFsStorageProvider implements StorageProvider {
  private readonly root: string;
  private readonly publicBase: string;

  constructor(root: string, publicBase = '/files') {
    this.root = path.resolve(root);
    this.publicBase = publicBase;
  }

  private file(key: string, tenantId: string): string {
    if (!TENANT.test(tenantId)) throw new Error('Invalid tenant id');
    assertSafeKey(key);
    const p = path.resolve(this.root, tenantId, ...key.split('/'));
    // Belt and braces: the resolved path must stay inside this tenant's directory.
    if (!p.startsWith(path.join(this.root, tenantId) + path.sep)) throw new Error('Path escapes tenant root');
    return p;
  }

  async put(key: string, data: Uint8Array, contentType: string, tenantId: string): Promise<AssetRef> {
    const f = this.file(key, tenantId);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, data);
    await writeFile(`${f}.meta.json`, JSON.stringify({ contentType }));
    return { id: key, url: await this.getUrl(key, tenantId), contentType, bytes: data.byteLength, tenantId };
  }

  async get(key: string, tenantId: string): Promise<StoredObject | null> {
    const f = this.file(key, tenantId);
    try {
      const [data, meta] = await Promise.all([readFile(f), readFile(`${f}.meta.json`, 'utf8')]);
      return { data: new Uint8Array(data), contentType: (JSON.parse(meta) as { contentType: string }).contentType };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async getUrl(key: string, tenantId: string): Promise<string> {
    this.file(key, tenantId); // validate
    return `${this.publicBase}/${tenantId}/${key}`;
  }

  async delete(key: string, tenantId: string): Promise<void> {
    const f = this.file(key, tenantId);
    await rm(f, { force: true });
    await rm(`${f}.meta.json`, { force: true });
  }
}
