import config from "$config";
import { existsSync } from "fs";
import net from "net";

// Patch net.Socket.prototype.connect to prevent Bun from crashing when
// connecting to a non-existent unix socket. Bun's net.createConnection
// throws ENOENT in a way that bypasses all JS error handlers.
// Instead, we check if the socket file exists and emit a proper error event.
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args: any[]) {
  const sockPath = typeof args[0] === "string" ? args[0] : args[0]?.path;
  if (typeof sockPath === "string" && sockPath.startsWith("/") && !existsSync(sockPath)) {
    process.nextTick(() => {
      this.emit(
        "error",
        Object.assign(new Error(`connect ENOENT ${sockPath}`), {
          code: "ENOENT",
          errno: -2,
          syscall: "connect",
          address: sockPath,
        }),
      );
    });
    return this;
  }
  return origConnect.apply(this, args);
};

const mod = (await import("@asoltys/clightning-client")).default;
const { LightningClient } = mod as { LightningClient: any };

class LightningUnavailableError extends Error {
  code = "LIGHTNING_UNAVAILABLE" as const;
  constructor(msg: string) {
    super(msg);
    this.name = "LightningUnavailableError";
  }
}

function isUnavailable(e: any) {
  const code = e?.code ?? e?.errno;
  return code === "ENOENT" || code === 2 || code === "ECONNREFUSED";
}

function isSocketDied(e: any) {
  const code = e?.code ?? e?.errno;
  return (
    code === "EPIPE" ||
    code === "ECONNRESET" ||
    code === "ENOENT" ||
    code === 2 ||
    // A timed-out RPC (see RPC_TIMEOUT below) means the socket is open but cl
    // stopped responding (zombie/half-open). Treat it as dead so the client is
    // dropped and the next call reconnects — without restarting the process.
    code === "ETIMEDOUT"
  );
}

// Wall-clock cap for short-lived RPCs. A unix-domain socket has no TCP
// keepalive, so a hung cl would otherwise leave the await pending forever
// (the "stuck spinner past /pay/bob, no error" symptom). 30s matches the
// health-check RPC_TIMEOUT in lib/health.ts.
const RPC_TIMEOUT = 30_000;

// Methods that MUST NOT get a client-side timeout:
//  - waitanyinvoice/waitinvoice/waitsendpay/waitblockheight: long-polls that
//    are designed to block until something happens.
//  - pay/xpay/sendpay/keysend: in-flight payments. Rejecting the caller early
//    while the HTLC may still settle is exactly the leaked-debit hazard the
//    sendLightning guards exist to prevent — let these run to completion.
//  - fetchinvoice/sendinvoice/offer: bolt12 flows that round-trip to a remote
//    node over the network and can legitimately take a long time.
const NO_TIMEOUT = new Set([
  "waitanyinvoice",
  "waitinvoice",
  "waitsendpay",
  "waitblockheight",
  "pay",
  "xpay",
  "sendpay",
  "keysend",
  "fetchinvoice",
  "sendinvoice",
  "offer",
]);

class RpcTimeoutError extends Error {
  code = "ETIMEDOUT" as const;
  constructor(method: string, ms: number) {
    super(`Lightning RPC ${method} timed out after ${ms}ms`);
    this.name = "RpcTimeoutError";
  }
}

function lightningProxy(rpcPath: string) {
  let client: any = null;

  let nextTryAt = 0;
  let backoff = 250;
  const maxBackoff = 5000;

  const deathCbs = new Set<(reason?: string) => void>();

  // Fully tear down a dead client. Just doing `client = null` orphans the old
  // LightningClient: the @asoltys/clightning-client library keeps its internal
  // reconnect() loop running on the (dead) socket forever — spamming
  // `connect ENOENT …/lightning-rpc` and leaking a socket + timer on EVERY cl
  // restart. So stop its reconnect loop, destroy the socket, and drop listeners.
  // Then notify subscribers (the invoice listener) so they can recycle at once
  // rather than waiting on the 5-minute stall watchdog. `notify=false` for a
  // deliberate reset() where the caller already owns the re-arm.
  function dropClient(reason?: string, notify = true) {
    const dead = client;
    client = null;
    if (dead) {
      try {
        if (dead.reconnectTimeout) { clearTimeout(dead.reconnectTimeout); dead.reconnectTimeout = null; }
        dead.reconnect = () => {}; // neuter any pending 'error'/'end' handler
        dead.rl?.close?.();
        dead.client?.removeAllListeners?.();
        dead.client?.destroy?.();
        dead.removeAllListeners?.();
      } catch (_) {}
    }
    if (notify) for (const cb of deathCbs) { try { cb(reason); } catch (_) {} }
  }

  function ensure() {
    if (client) return client;

    const now = Date.now();
    if (now < nextTryAt) {
      throw new LightningUnavailableError(`Lightning not ready at ${rpcPath}`);
    }

    if (!existsSync(rpcPath)) {
      nextTryAt = Date.now() + backoff;
      backoff = Math.min(maxBackoff, Math.floor(backoff * 1.8));
      throw new LightningUnavailableError(
        `Lightning RPC socket not found at ${rpcPath}`
      );
    }

    try {
      const c = new LightningClient(rpcPath);
      client = c;
      // Prevent unhandled 'error' events from crashing the process. Guard on
      // `c === client` so a stale client's late error can't tear down a newer,
      // healthy one that already replaced it.
      c.on("error", (e: any) => {
        if (c === client && isSocketDied(e)) dropClient(e?.code ?? e?.errno);
      });
      backoff = 250;
      nextTryAt = 0;
      return client;
    } catch (e: any) {
      nextTryAt = Date.now() + backoff;
      backoff = Math.min(maxBackoff, Math.floor(backoff * 1.8));

      if (isUnavailable(e)) {
        throw new LightningUnavailableError(
          `Lightning RPC unavailable at ${rpcPath} (${e?.code ?? e?.errno ?? "error"})`
        );
      }
      throw e;
    }
  }

  return new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (prop === "toString") return () => "[LightningProxy]";
        if (prop === Symbol.toStringTag) return "LightningProxy";

        // Force the underlying socket to be dropped so the next call reconnects.
        // Used by the lightning-listener watchdog to recover a zombie long-poll
        // (waitanyinvoice blocked on a dead socket while cl is actually alive —
        // the per-call timeout can't catch it because long-polls are exempt).
        if (prop === "reset") {
          return () => {
            const had = !!client;
            dropClient("reset", false); // caller (watchdog) owns the re-arm
            return had;
          };
        }

        // Subscribe to socket-death so a consumer (the invoice listener) can
        // recover the instant the connection dies, instead of polling/waiting.
        // Returns an unsubscribe fn. Handled before the generic RPC dispatch so
        // "onDrop" is never sent to cl as a method.
        if (prop === "onDrop") {
          return (cb: (reason?: string) => void) => {
            deathCbs.add(cb);
            return () => deathCbs.delete(cb);
          };
        }

        return async (...args: any[]) => {
          const c = ensure();
          const v = c[prop as any];

          if (typeof v !== "function") return v;

          const method = String(prop);
          try {
            const call = v.apply(c, args);
            if (NO_TIMEOUT.has(method)) return await call;

            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new RpcTimeoutError(method, RPC_TIMEOUT)),
                RPC_TIMEOUT,
              );
            });
            try {
              return await Promise.race([call, timeout]);
            } finally {
              clearTimeout(timer);
            }
          } catch (e: any) {
            // ETIMEDOUT (from RpcTimeoutError) is included in isSocketDied, so a
            // hung RPC drops the client and the next call reconnects.
            if (isSocketDied(e)) dropClient(e?.code ?? e?.errno);
            throw e;
          }
        };
      },
    }
  );
}

// Main proxy for short-lived RPC calls (getinfo, invoice, decode, etc.)
const ln = lightningProxy(config.lightning);
export default ln;

// Dedicated proxy for long-polling (waitanyinvoice) — uses its own socket
// so it doesn't block the main connection
export const lnListen = lightningProxy(config.lightningListen || config.lightning);

export const lnb = lightningProxy(config.lightningb);
export { LightningUnavailableError };
