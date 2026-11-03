// Idempotent: safe to run on every start. Applies DB migrations, creates both
// buckets, and publishes master manifests for videos processed before M6.
import { backfillManifests, ensureBuckets, migrate, pool } from "@vpp/core";

const applied = await migrate();
console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Migrations up to date");
await ensureBuckets();
console.log("Buckets ready");
const backfilled = await backfillManifests();
if (backfilled) console.log(`Published master manifests for ${backfilled} earlier video(s)`);
await pool.end();
