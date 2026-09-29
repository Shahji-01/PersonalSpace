import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

export * from './schema';
export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
  return { pool, db: drizzle(pool, { schema }) };
}
export type Database = ReturnType<typeof createDatabase>['db'];
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export async function withUser<T>(
  db: Database,
  userId: string,
  run: (tx: Transaction) => Promise<T>,
  readOnly = false,
): Promise<T> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
      return run(tx);
    },
    readOnly ? { isolationLevel: 'repeatable read', accessMode: 'read only' } : undefined,
  );
}
