# patches

## `@asoltys%2Fclightning-client@0.2.0.patch`

Fixes the reconnect logic in `@asoltys/clightning-client` (v0.2.0) so a dropped
cl RPC connection actually recovers.

**Bug:** `reconnect()` called `this.client.connect()` on the *same* socket that
had already emitted `error`/`close`. A destroyed socket can't be reconnected, so
after a `cl` restart the client wedged, looping `connect ENOENT …/lightning-rpc`
forever — spamming logs and leaking a socket+timer each time — and never
recovered. (If `connect()` threw, `reconnectTimeout` was also left set, which
permanently blocked every future `reconnect()`.)

**Fix:** factor the socket+readline+handlers setup into `_setup()` which builds a
**fresh** socket each (re)connection and renews `clientConnectionPromise` (so
`call()` blocks until the reconnect is live). `reconnect()` now clears its guard
*before* reconnecting and retries on failure.

This is defense-in-depth: the app already neutralises the broken loop in
`lib/ln.ts` (`dropClient()` tears the dead client down and the proxy makes a fresh
`LightningClient`). This patch fixes the library itself for any path that relies
on its own reconnect.

### How this patch was generated

A hand-written git-diff patch applied cleanly via `git apply` but was
*mis-applied* by bun's own patcher during `bun install` (it duplicated lines
instead of replacing them) — the two tools' patch parsers aren't interchangeable
for this hunk shape. The reliable path is `bun patch`'s own workflow, which
diffs the actual edited file rather than replaying a hand-written patch:

```sh
bun patch @asoltys/clightning-client
# edit node_modules/@asoltys/clightning-client/index.js directly (or apply a
# verified-correct patch with `git apply` from inside that directory)
bun patch --commit node_modules/@asoltys/clightning-client
```

That writes bun's own `patches/@asoltys%2Fclightning-client@0.2.0.patch` and the
`patchedDependencies` entry in `package.json`, and is what's committed here.
`bun install` re-applies it (by re-diffing/copying, not by re-running a patch
parser) on every fresh install.
