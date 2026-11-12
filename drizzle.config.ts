import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/infrastructure/persistence/schema.ts',
  out: './drizzle',
  // Only `drizzle-kit studio` connects; `generate` works from the schema alone.
  // Same default as `DB_PATH` in src/config.ts. Studio connects through
  // @libsql/client (a dev dependency), which needs the `file:` scheme.
  dbCredentials: { url: `file:${process.env.DB_PATH ?? 'location-tracker.db'}` },
});
