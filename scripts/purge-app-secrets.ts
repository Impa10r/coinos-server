// Strip the persisted NWC client secret from every app:<pubkey> record in
// both the primary store and the archive fallback. Authorized cleanup only
// — destructive. Defaults to dry-run.
//
// Deploy and restart the app with the routes/users.ts fix (updateApp no
// longer writes app.secret) BEFORE running this with --confirm — otherwise
// any connection created or edited while this runs can put a secret right
// back, and the archive pass may re-copy it from a get/set fallback.
//
// Usage:
//   bun scripts/purge-app-secrets.ts            # dry-run
//   bun scripts/purge-app-secrets.ts --confirm  # actually strip
//
// Run inside the app container so it picks up $lib/db config:
//   docker exec -it app bun scripts/purge-app-secrets.ts --confirm

import { archive, db, g, ga, s, sa } from "$lib/db";

const dryRun = !process.argv.includes("--confirm");

async function purge(
  label: string,
  client: typeof db,
  get: (k: string) => Promise<any>,
  set: (k: string, v: any) => any,
) {
  let scanned = 0;
  let withSecret = 0;
  let stripped = 0;

  for await (const batch of client.scanIterator({ MATCH: "app:*" })) {
    for (const key of batch as unknown as string[]) {
      scanned++;
      let app: any;
      try {
        app = await get(key);
      } catch (e: any) {
        console.error(`  [${label}] FAILED to read ${key}: ${e.message}`);
        continue;
      }
      if (!app || typeof app !== "object" || !app.secret) continue;

      withSecret++;
      console.log(`  [${label}] ${key} pubkey=${app.pubkey ?? "?"}`);

      if (!dryRun) {
        delete app.secret;
        try {
          await set(key, app);
          stripped++;
        } catch (e: any) {
          console.error(`  [${label}] FAILED to write ${key}: ${e.message}`);
        }
      }
    }
  }

  console.log(
    `[${label}] scanned=${scanned} withSecret=${withSecret} stripped=${dryRun ? "(dry-run)" : stripped}`,
  );
}

console.log("=== db (primary) ===");
await purge("db", db, g, s);

console.log("\n=== arc (archive) ===");
await purge("arc", archive, ga, sa);

if (dryRun) {
  console.log("\nDRY RUN — nothing written. Re-run with --confirm to strip secrets.");
}

process.exit(0);
