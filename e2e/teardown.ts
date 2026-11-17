import pg from "pg";

// Removes the users (and their orgs) the e2e run created; they all use e2e-*@example.test.
export default async function teardown() {
  if (process.env.E2E_KEEP) return; // keep the data to inspect a failure
  const client = new pg.Client({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://orbyt:orbyt@127.0.0.1:5432/orbyt",
  });
  await client.connect();
  try {
    await client.query(`delete from organizations where id in (
      select m.organization_id from organization_members m join users u on u.id = m.user_id
      where u.email like 'e2e-%@example.test')`);
    await client.query(
      `delete from users where email like 'e2e-%@example.test'`,
    );
  } finally {
    await client.end();
  }
}
