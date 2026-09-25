import { describe, it, expect } from 'vitest';
import { cookiesSecure, parseEnv } from '@/core/config/env';

// Every blank line in .env.example, exactly as a shell or dotenv loader delivers it.
const BLANKS = {
  STORAGE_ENDPOINT: '',
  STORAGE_ACCESS_KEY: '',
  STORAGE_SECRET_KEY: '',
  IMAGE_PROVIDER_API_KEY: '',
  SETTINGS_ENCRYPTION_KEYS: '',
  RESEND_API_KEY: '',
};

describe('parseEnv', () => {
  it('treats blank values as unset instead of invalid', () => {
    const env = parseEnv({ ...BLANKS, PUBLIC_BASE_URL: '', DATABASE_URL: '' });
    expect(env.STORAGE_ENDPOINT).toBeUndefined();
    expect(env.PUBLIC_BASE_URL).toBeUndefined();
    expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it('falls back to defaults for blank numbers and switches', () => {
    const env = parseEnv({ MAX_UPLOAD_MB: '', TRUST_PROXY: '', DATA_MODE: '' });
    expect(env.MAX_UPLOAD_MB).toBe(10);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.DATA_MODE).toBe('memory');
  });

  it('still rejects a value that is set and malformed', () => {
    expect(() => parseEnv({ STORAGE_ENDPOINT: 'not a url' })).toThrow();
  });

  it('a blank key never satisfies a requirement', () => {
    expect(() => parseEnv({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: '' })).toThrow(/RESEND_API_KEY/);
    expect(() => parseEnv({ DATA_MODE: 'postgres', DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('S3 storage needs credentials; path-style is optional and parsed', () => {
    expect(() => parseEnv({ STORAGE_DRIVER: 's3', STORAGE_ACCESS_KEY: '', STORAGE_SECRET_KEY: '' })).toThrow(/STORAGE_ACCESS_KEY/);
    const env = parseEnv({ STORAGE_DRIVER: 's3', STORAGE_ACCESS_KEY: 'a', STORAGE_SECRET_KEY: 'b', STORAGE_FORCE_PATH_STYLE: 'false' });
    expect(env.STORAGE_FORCE_PATH_STYLE).toBe(false);
    expect(env.STORAGE_REGION).toBe('us-east-1');
    expect(parseEnv({}).STORAGE_FORCE_PATH_STYLE).toBeUndefined();
  });

  it('keeps real values', () => {
    const env = parseEnv({ STORAGE_ENDPOINT: 'https://s3.example.com', MAX_UPLOAD_MB: '25' });
    expect(env.STORAGE_ENDPOINT).toBe('https://s3.example.com');
    expect(env.MAX_UPLOAD_MB).toBe(25);
  });
});

describe('cookiesSecure (Safari drops Secure cookies on http origins, localhost included)', () => {
  it('follows PUBLIC_BASE_URL when set, whatever NODE_ENV says', () => {
    expect(cookiesSecure({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://localhost:3000' })).toBe(false);
    expect(cookiesSecure({ NODE_ENV: 'development', PUBLIC_BASE_URL: 'https://app.example.com' })).toBe(true);
    expect(cookiesSecure({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://app.example.com' })).toBe(true);
  });
  it('without it, production (tenant hosts over https) is Secure and development is not', () => {
    expect(cookiesSecure({ NODE_ENV: 'production' })).toBe(true);
    expect(cookiesSecure({ NODE_ENV: 'development' })).toBe(false);
  });
});

describe('on Vercel (ADR 0018)', () => {
  const PROD = {
    NODE_ENV: 'production',
    DATA_MODE: 'postgres',
    DATABASE_URL: 'postgres://app@db/bc',
    AUTH_SECRET: 'a'.repeat(40),
    SETTINGS_ENCRYPTION_KEYS: 'k1:' + 'A'.repeat(43) + '=',
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 're_x',
    IMAGE_PROVIDER: 'mock',
    STORAGE_DRIVER: 's3',
    STORAGE_ACCESS_KEY: 'ak',
    STORAGE_SECRET_KEY: 'sk',
    DELIVERY_WORKER: 'off',
    PROOF_WORKER: 'after',
    SUPPLIER_WORKER: 'after',
  };

  it('accepts a serverless configuration', () => {
    const env = parseEnv({ ...PROD, VERCEL: '1' });
    expect(env.PROOF_WORKER).toBe('after');
    expect(env.CRON_SECRET).toBeUndefined();
  });

  it('refuses local disk storage and in-process timers there, and says what to set', () => {
    expect(() => parseEnv({ ...PROD, VERCEL: '1', STORAGE_DRIVER: 'local' })).toThrow(/STORAGE_DRIVER=s3/);
    expect(() => parseEnv({ ...PROD, VERCEL: '1', DELIVERY_WORKER: 'inline' })).toThrow(/DELIVERY_WORKER=off/);
    expect(() => parseEnv({ ...PROOF_INLINE(PROD), VERCEL: '1' })).toThrow(/PROOF_WORKER=after/);
    // The same settings are fine on an ordinary server.
    expect(() => parseEnv({ ...PROD, STORAGE_DRIVER: 'local', DELIVERY_WORKER: 'inline', PROOF_WORKER: 'inline' })).not.toThrow();
  });

  it('insists on a long cron secret when one is set', () => {
    expect(() => parseEnv({ ...PROD, CRON_SECRET: 'short' })).toThrow();
    expect(parseEnv({ ...PROD, CRON_SECRET: 's'.repeat(32) }).CRON_SECRET).toBe('s'.repeat(32));
  });
});

function PROOF_INLINE<T extends Record<string, string>>(e: T) {
  return { ...e, PROOF_WORKER: 'inline' };
}

