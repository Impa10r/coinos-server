// Which registered routes has nothing actually called?
//
// Static analysis can't answer this: grepping the UI for a path misses URLs
// built dynamically (that approach reported /preimages and /zaps as unused
// when the UI hits both heavily), and it can't see external callers at all —
// wallets, the mint, mosquitto, webhooks.
//
// Nor does `sort | uniq -c | tail` on the request log: that ranks paths that
// WERE hit, so a route nothing ever calls is absent from the output entirely.
// The question has to be asked the other way round — take every route this
// server registers and subtract the ones the log has seen.
//
// Two things to hold in mind about the answer:
//
//   1. The request logger skips a list of paths (see lib/app.ts) and all GET
//      /users*. Those can never appear, so they're reported separately rather
//      than as unused — calling them dead would be exactly wrong.
//   2. It only covers the log's window. A quarterly admin endpoint looks dead
//      in a week of logs. Treat the output as "worth investigating", not
//      "safe to delete".
//
// Read-only.
//
// Usage:
//   docker exec -it app bun scripts/route-usage.ts
//   docker exec -it app bun scripts/route-usage.ts /home/bun/app/req

import { existsSync, readFileSync } from "fs";

const LOG = process.argv[2] || "/home/bun/app/req";
const INDEX = "index.ts";

// Mirrors lib/app.ts's request-logging filter.
const IGNORED_PREFIXES = [
  "/ws", "/me", "/confirm", "/public", "/rates", "/challenge",
  "/rate", "/lnurlp", "/subscriptions", "/accounts", "/contacts",
];
const ignoredByLogger = (method: string, path: string) =>
  IGNORED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) ||
  (method === "GET" && (path === "/users" || path.startsWith("/users/")));

if (!existsSync(LOG)) {
  console.error(`No request log at ${LOG}. Pass its path as an argument.`);
  process.exit(1);
}

const routes: { method: string; path: string; re: RegExp }[] = [];
for (const m of readFileSync(INDEX, "utf8").matchAll(/app\.(get|post|put|delete|all)\(\s*"([^"]+)"/g)) {
  const path = m[2];
  // ":param" matches one segment; "*" matches the rest.
  const pattern = path
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:[A-Za-z0-9_]+/g, "[^/]+")
    .replace(/\*/g, ".*");
  routes.push({ method: m[1].toUpperCase(), path, re: new RegExp(`^${pattern}/?$`) });
}

// Collect observed paths. The log is JSON-per-line but may be truncated mid
// write, so pull the url field textually rather than parsing each line.
const seen = new Map<string, number>();
let lines = 0;
for (const line of readFileSync(LOG, "utf8").split("\n")) {
  if (!line) continue;
  lines++;
  const m = line.match(/"url":"([^"]*)"/);
  if (!m) continue;
  const url = m[1].split("?")[0];
  seen.set(url, (seen.get(url) || 0) + 1);
}

const hits = (re: RegExp) => {
  let n = 0;
  for (const [url, count] of seen) if (re.test(url)) n += count;
  return n;
};

const unused: typeof routes = [];
const invisible: typeof routes = [];
const used: { path: string; method: string; n: number }[] = [];

for (const r of routes) {
  if (ignoredByLogger(r.method, r.path)) {
    invisible.push(r);
    continue;
  }
  const n = hits(r.re);
  if (n === 0) unused.push(r);
  else used.push({ path: r.path, method: r.method, n });
}

console.log(`${lines} logged requests, ${seen.size} distinct paths, ${routes.length} routes\n`);

console.log(`${unused.length} route(s) with NO request in this log:`);
for (const r of unused) console.log(`  ${r.method.padEnd(6)} ${r.path}`);

console.log(`\n${invisible.length} route(s) the logger never records (lib/app.ts filter) — status unknown:`);
for (const r of invisible) console.log(`  ${r.method.padEnd(6)} ${r.path}`);

used.sort((a, b) => a.n - b.n);
console.log(`\n10 least-used routes that DID see traffic:`);
for (const u of used.slice(0, 10))
  console.log(`  ${String(u.n).padStart(6)}  ${u.method.padEnd(6)} ${u.path}`);

console.log(
  "\nThis log is a window, not all time — a rarely-used admin endpoint looks\n" +
    "dead in a week. Confirm before removing anything.",
);
process.exit(0);
