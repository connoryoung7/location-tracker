import type { SQL, TransactionSQL } from 'bun';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The Postgres transaction open in the current async context, shared by every
 * Postgres repository. `withUserLock` opens one to hold the user's advisory
 * lock, and repositories called inside it join that transaction instead of
 * taking another pool connection. So a lock holder never waits on the pool for
 * a second connection, which would deadlock once every connection is held by
 * a lock, and its writes commit or roll back together with the lock.
 */
const active = new AsyncLocalStorage<{ pool: SQL; transaction: TransactionSQL }>();

/** Runs `work` with `transaction`, opened on `pool`, as the active transaction. */
export function runInTransaction<T>(pool: SQL, transaction: TransactionSQL, work: () => T): T {
  return active.run({ pool, transaction }, work);
}

/**
 * The open transaction on `pool`, if there is one. A transaction on a
 * different pool is never joined, since it is a different database connection.
 */
export function activeTransaction(pool: SQL): TransactionSQL | undefined {
  const current = active.getStore();
  return current?.pool === pool ? current.transaction : undefined;
}

/** Where a repository on `pool` should send a query: the open transaction, or the pool. */
export function connectionFor(pool: SQL): SQL {
  return activeTransaction(pool) ?? pool;
}
