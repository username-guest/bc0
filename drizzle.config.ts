import { defineConfig } from 'drizzle-kit';

/**
 * Schema migrations are GENERATED from src/core/db/schema.ts into ./drizzle (commit them).
 * RLS policies live separately in ./db/policies and are applied by `npm run db:policies`
 * AFTER `db:migrate`, because drizzle-kit only applies journaled files it generated itself.
 * Both steps run as the migration (owner) role — never as the app role.
 */
export default defineConfig({
  schema: './src/core/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
});
