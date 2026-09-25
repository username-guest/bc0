/**
 * SANDBOX-ONLY loose stubs for third-party packages that aren't installed in the offline
 * environment. They let `tsc` check ALL of our own code under the real strict tsconfig; they
 * are never used by the real build (tsconfig.json doesn't include this file).
 */
declare module 'next' {
  export type Metadata = Record<string, unknown>;
  export type Viewport = Record<string, unknown>;
  export type NextConfig = Record<string, unknown>;
}
declare module 'next/server' {
  export class NextRequest extends Request {
    nextUrl: URL & { clone(): URL };
  }
  export const NextResponse: {
    next(): Response;
    rewrite(url: URL): Response;
    json(body: unknown, init?: ResponseInit): Response;
  };
  export function after(task: () => unknown): void;
}
declare module 'next/navigation' {
  export function notFound(): never;
}
declare module 'next/link' {
  const Link: (props: { href: string; children?: unknown; className?: string }) => JSX.Element;
  export default Link;
}
declare module 'react' {
  export type ReactNode = unknown;
  export type CSSProperties = Record<string, string | number>;
  export interface Context<T> { Provider: (p: { value: T; children?: ReactNode }) => JSX.Element }
  export function createContext<T>(v: T): Context<T>;
  export function useContext<T>(c: Context<T>): T;
  export function useState<T>(init: T | (() => T)): [T, (v: T | ((p: T) => T)) => void];
  export function useEffect(fn: () => void | (() => void), deps?: unknown[]): void;
  export function useMemo<T>(fn: () => T, deps: unknown[]): T;
  export function useCallback<T extends (...a: never[]) => unknown>(fn: T, deps: unknown[]): T;
  export function useRef<T>(init: T | null): { current: T | null };
  const React: { CSSProperties: CSSProperties };
  export default React;
}
declare namespace React {
  type ReactNode = unknown;
  type CSSProperties = Record<string, string | number>;
}
declare namespace JSX {
  type Element = unknown;
  interface ElementChildrenAttribute {
    children: {};
  }
  // Real event/attribute types come from @types/react (not installed here); `any` provides the
  // contextual typing that @types/react would, so handler params aren't flagged as implicit any.
  interface IntrinsicElements {
    [tag: string]: any;
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
}
declare module 'drizzle-orm' {
  export const sql: any;
  export const eq: any;
  export const and: any;
}
declare module 'drizzle-orm/pg-core' {
  export const pgTable: any, uuid: any, text: any, integer: any, boolean: any, jsonb: any, timestamp: any, real: any,
    primaryKey: any, index: any, uniqueIndex: any;
}
declare module 'drizzle-orm/node-postgres' {
  export const drizzle: any;
}
declare module 'drizzle-kit' {
  export function defineConfig(c: unknown): unknown;
}
declare module 'pg' {
  export class Pool {
    constructor(o: unknown);
    query(q: string, p?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  }
}
declare module 'zod' {
  export const z: any;
}
declare module 'vitest' {
  export const describe: any, it: any, test: any, expect: any, beforeAll: any, afterAll: any;
}
declare module 'vitest/config' {
  export function defineConfig(c: unknown): unknown;
}
declare module 'sharp';
declare module 'react-dom/client' {
  export function createRoot(el: Element): { render(node: unknown): void; unmount(): void };
}
