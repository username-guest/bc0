/**
 * Encryption at rest for tenant secrets (webhook signing secrets today). ADR 0008.
 *
 * AES-256-GCM with a random 96-bit IV per value. The tenant id is bound in as additional
 * authenticated data, so a ciphertext copied into another tenant's settings fails to decrypt
 * instead of leaking. Format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url), so keys can be
 * rotated: decrypt looks the key up by id, encrypt always uses the current key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretBox {
  seal(plaintext: string, tenantId: string): string;
  open(sealed: string, tenantId: string): string;
}

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

/**
 * `keys` maps key id → 32-byte key; `current` is the id used to seal.
 * Parse from env with `parseKeyring` (`id1:base64key,id2:base64key`, first is current).
 */
export function createSecretBox(keys: ReadonlyMap<string, Buffer>, current: string): SecretBox {
  for (const [id, k] of keys) {
    if (k.length !== 32) throw new SecretBoxError(`Key ${id} must be 32 bytes`);
    if (!/^[a-z0-9_-]{1,16}$/i.test(id)) throw new SecretBoxError(`Bad key id ${id}`);
  }
  if (!keys.has(current)) throw new SecretBoxError(`Current key ${current} not in keyring`);
  return {
    seal(plaintext, tenantId) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', keys.get(current)!, iv);
      c.setAAD(Buffer.from(`tenant:${tenantId}`));
      const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
      return ['v1', current, b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
    },
    open(sealed, tenantId) {
      const parts = sealed.split('.');
      if (parts.length !== 5 || parts[0] !== 'v1') throw new SecretBoxError('Unrecognised sealed value');
      const key = keys.get(parts[1]!);
      if (!key) throw new SecretBoxError(`Unknown key id ${parts[1]}`);
      try {
        const d = createDecipheriv('aes-256-gcm', key, unb64(parts[2]!));
        d.setAAD(Buffer.from(`tenant:${tenantId}`));
        d.setAuthTag(unb64(parts[3]!));
        return Buffer.concat([d.update(unb64(parts[4]!)), d.final()]).toString('utf8');
      } catch {
        throw new SecretBoxError('Secret failed authentication (wrong tenant, key or corrupted value)');
      }
    },
  };
}

export function parseKeyring(spec: string): { keys: Map<string, Buffer>; current: string } {
  const keys = new Map<string, Buffer>();
  let current = '';
  for (const entry of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(':');
    if (i < 1) throw new SecretBoxError('SETTINGS_ENCRYPTION_KEYS entries must be id:base64key');
    const id = entry.slice(0, i);
    keys.set(id, Buffer.from(entry.slice(i + 1), 'base64'));
    if (!current) current = id;
  }
  if (!current) throw new SecretBoxError('SETTINGS_ENCRYPTION_KEYS is empty');
  return { keys, current };
}

/** Dev/test keyring. Never used when NODE_ENV=production (env validation requires real keys). */
export function devSecretBox(): SecretBox {
  return createSecretBox(new Map([['dev', Buffer.alloc(32, 7)]]), 'dev');
}
