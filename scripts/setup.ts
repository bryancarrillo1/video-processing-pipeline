// Idempotent: safe to run on every start. Applies DB migrations and creates both buckets.
import { ensureBuckets, migrate, pool } from "@vpp/core";

const applied = await migrate();
console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Migrations up to date");
await ensureBuckets();
console.log("Buckets ready");
await pool.end();
