
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## Architecture

Here are the file structure for the codebase and the different standards that are encouraged when building the application. All the application code is found in the `src` folder with the exception of `index.ts` which lives in the root project folder.

Within the `src` folder:
- `application`
- `domain`: the domain models that are used within the different applications. They should be shared across the `application` and `repository` folders, also known as layers.
- `entrypoints`: different applications within the project (e.g., a RESTful HTTP API, an MQTT server, a background worker, etc.)
- `infrastructure`: 
- `repository`: any class that handles storage, whether it be persistent or in-memory. All the methods of of a `repository` class should either accept and/or return a type/class that is found in the `domain` folder.
  - `<domain model>-repository`: this folder is all the repository classes for different kinds of storage layers. The classes within this folder should inherit a class within the codebase.


## APIs

- Use `express` for the HTTP server.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```
