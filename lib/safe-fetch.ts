// SSRF-resistant fetch for user-supplied URLs (lnurl / lightning-address
// resolution in routes/lnurl.ts). Rejects any host that resolves to a
// loopback, private, link-local, CGNAT, or cloud-metadata address.
//
// Resolves and validates the host BEFORE connecting, then connects directly
// to that exact validated IP (Host header + TLS servername overridden back to
// the original hostname so routing/SNI still work) — so there is no
// resolve-then-connect gap for a low-TTL DNS-rebinding attacker to slip an
// internal address into. Redirects are followed manually and each hop is
// re-validated the same way. Scheme is restricted to http(s); 8s timeout;
// 2MB streamed-body cap.
//
// NOTE: this deliberately does NOT use Node's `lookup` option on
// http(s).request to pin the connection — that seemed like the more obvious
// implementation, but Bun's http(s).request has a bug where a custom `lookup`
// breaks the underlying connection (confirmed: plain net.connect and
// tls.connect both work fine with the same lookup function; only
// http(s).request's own connection path fails, reproducibly, agent or not).
// Resolving up front and connecting straight to the IP sidesteps it entirely
// and is (Bun bug aside) the same security property either way.
//
// .onion hosts skip resolution/validation entirely: Tor's socks5h routing
// resolves them on the proxy side, never through Node's own DNS, so there is
// no local hostname to validate — and a caller-supplied SOCKS5 proxy agent
// (see extraOpts below) takes over connection establishment itself.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 8000;

const blockedV4 = (ip: string): boolean => {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10 (incl. tailscale)
  if (a >= 224) return true; // multicast / reserved
  return false;
};

const isBlockedIp = (ip: string): boolean => {
  if (net.isIPv4(ip)) return blockedV4(ip);
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true; // loopback / unspecified
    const mapped = low.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return blockedV4(mapped[1]); // IPv4-mapped
    if (/^fe[89ab]/.test(low)) return true; // fe80::/10 link-local
    const head = low.split(":")[0];
    if (head.startsWith("fc") || head.startsWith("fd")) return true; // fc00::/7 ULA
    return false;
  }
  return true; // not a recognizable IP -> block
};

// Resolve a hostname and validate every returned address (not just the first
// — an attacker returning [public, private] and hoping the stack picks the
// private one is exactly the bypass this guards against), then return the
// first address to actually connect to. An IP literal is validated directly.
const resolveAndValidate = (hostname: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const literal = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 literal brackets
    if (net.isIP(literal)) {
      if (isBlockedIp(literal)) return reject(new Error(`blocked host ${literal}`));
      return resolve(literal);
    }
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return reject(err);
      if (!addrs?.length) return reject(new Error(`cannot resolve ${hostname}`));
      const bad = addrs.find((a) => isBlockedIp(a.address));
      if (bad) return reject(new Error(`blocked host ${hostname} -> ${bad.address}`));
      resolve(addrs[0].address);
    });
  });

const fetchOnce = async (
  url: string,
  redirectsLeft: number,
  extraOpts: Record<string, any> = {},
): Promise<any> => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error("unsupported scheme");

  const isOnion = u.hostname.toLowerCase().endsWith(".onion");
  const mod = u.protocol === "https:" ? https : http;

  // extraOpts carries a caller-supplied proxy agent (SOCKS5/Tor) through to
  // the underlying request — used for .onion targets, without every caller
  // needing to know the SSRF-guard internals. Accept either a single Agent
  // or the got-style { http, https } pair (routes/lnurl.ts's existing call
  // shape) and resolve it to the one matching this request's protocol.
  const { agent: rawAgent, ...restOpts } = extraOpts;
  const agent =
    rawAgent && typeof rawAgent === "object" && ("http" in rawAgent || "https" in rawAgent)
      ? mod === https
        ? rawAgent.https
        : rawAgent.http
      : rawAgent;

  // Not resolvable locally at all for .onion — hand the hostname through
  // as-is and let the proxy agent (required for this to actually connect)
  // resolve and route it on the Tor side.
  const host = isOnion ? u.hostname : await resolveAndValidate(u.hostname);
  const port = u.port ? Number(u.port) : mod === https ? 443 : 80;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        host,
        port,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: { accept: "application/json", host: u.hostname },
        ...(mod === https ? { servername: u.hostname } : {}),
        ...(agent ? { agent } : {}),
        ...restOpts,
      },
      (res) => {
        const status = res.statusCode || 0;

        // manual redirect handling — re-resolve + re-validate each hop
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain
          if (redirectsLeft <= 0) return reject(new Error("too many redirects"));
          let next: string;
          try {
            next = new URL(res.headers.location, url).toString();
          } catch {
            return reject(new Error("bad redirect target"));
          }
          return resolve(fetchOnce(next, redirectsLeft - 1, extraOpts));
        }

        let len = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          len += c.length;
          if (len > MAX_BYTES) {
            req.destroy();
            reject(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("invalid json response"));
          }
        });
      },
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
};

// Fetch a user-supplied URL with SSRF protection and return the parsed JSON
// body. Throws on a bad scheme/URL or a host that resolves into a blocked
// range. `extraOpts` is merged into the request — used to pass a SOCKS5/Tor
// proxy agent through for .onion targets (see fetchOnce above), without every
// caller needing to know the SSRF-guard internals.
export const safeGot = async (url: string, extraOpts: Record<string, any> = {}): Promise<any> =>
  fetchOnce(url, MAX_REDIRECTS, extraOpts);
