import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  dbCredentials: {
    url: pathToFileURL(resolve(process.env.DB_PATH ?? 'location-tracker.db')).href,
  },
  schema: './src/infrastructure/persistence/schema.ts',
  out: './drizzle',
});
