'use client';
/**
 * Client-side flag access — PRESENTATION ONLY. The server re-checks every gate on every request
 * (src/server/http/api.ts); hiding a control here is UX, never security (§6).
 */
import { createContext, useContext } from 'react';
import type { publicTenantConfig } from '@/server/tenancy/context';

export type PublicConfig = ReturnType<typeof publicTenantConfig>;

const Ctx = createContext<PublicConfig | null>(null);

export function FlagsProvider({ config, children }: { config: PublicConfig; children: React.ReactNode }) {
  return <Ctx.Provider value={config}>{children}</Ctx.Provider>;
}

export function useTenantConfig(): PublicConfig {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTenantConfig must be used inside <FlagsProvider>');
  return c;
}

export function useFeature(key: string): { enabled: boolean; locked: boolean } {
  return useTenantConfig().flags[key] ?? { enabled: false, locked: true };
}
