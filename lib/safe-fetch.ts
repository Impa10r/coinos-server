// SSRF-resistant fetch for user-supplied URLs (lnurl / lightning-address
// resolution in routes/lnurl.ts). Rejects any host that resolves to a
// loopback, private, link-local, CGNAT, or cloud-metadata address.
//
// Unlike a resolve-then-fetch guard (which re-resolves DNS when it actually
// connects, leaving a DNS-rebinding TOCTOU window), this pins the socket to the
// exact IP it validated: the connection's DNS lookup IS the validation, in one
// callback, so a low-TTL rebind cannot swap in an internal IP after the check.
// Redirects are followed manually and each hop is re-validated the same way.
// Scheme is restricted to http(s); 8s timeout; 2MB streamed-body cap.
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

// A drop-in for the Node dns.lookup used by http(s).request: resolves the host,
// rejects the whole connection if ANY resolved address is blocked (so an
// attacker can't return [public, private] and hope the stack picks the private
// one), and otherwise hands the socket the first allowed address. Because the
// address returned here is the one the socket connects to, there is no
// resolve/connect gap for a rebind to slip through.
const pinnedLookup = (
  hostname: string,
  options: any,
  cb: (err: Error | null, address?: any, family?: number) => void,
): void => {
  // hostname may be an IP literal (redirect to a raw IP) — validate directly.
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) return cb(new Error(`blocked host ${hostname}`));
    const fam = net.isIPv6(hostname) ? 6 : 4;
    return cb(null, options?.all ? [{ address: hostname, family: fam }] : hostname, fam);
  }
  dns.lookup(hostname, { all: true }, (err, addrs: any[]) => {
    if (err) return cb(err);
    if (!addrs?.length) return cb(new Error(`cannot resolve ${hostname}`));
    const bad = addrs.find((a) => isBlockedIp(a.address));
    if (bad) return cb(new Error(`blocked host ${hostname} -> ${bad.address}`));
    const a = addrs[0];
    if (options?.all) cb(null, [{ address: a.address, family: a.family }]);
    else cb(null, a.address, a.family);
  });
};

const fetchOnce = (url: string, redirectsLeft: number): Promise<any> =>
  new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { return reject(new Error("invalid url")); }
    if (u.protocol !== "http:" && u.protocol !== "https:")
      return reject(new Error("unsupported scheme"));

    // CRITICAL: Node skips the custom `lookup` when the URL host is already an
    // IP literal, so pinnedLookup alone would not see a raw-IP SSRF target.
    // Validate any literal host up front (strip IPv6 brackets first).
    const literal = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(literal) && isBlockedIp(literal))
      return reject(new Error(`blocked host ${literal}`));

    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method: "GET", lookup: pinnedLookup as any, headers: { accept: "application/json" } },
      (res) => {
        const status = res.statusCode || 0;

        // manual redirect handling — re-validate each hop via pinnedLookup
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain
          if (redirectsLeft <= 0) return reject(new Error("too many redirects"));
          let next: string;
          try { next = new URL(res.headers.location, url).toString(); }
          catch { return reject(new Error("bad redirect target")); }
          return resolve(fetchOnce(next, redirectsLeft - 1));
        }

        let len = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          len += c.length;
          if (len > MAX_BYTES) { req.destroy(); reject(new Error("response too large")); return; }
          chunks.push(c);
        });
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { reject(new Error("invalid json response")); }
        });
      },
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });

// Fetch a user-supplied URL with SSRF protection and return the parsed JSON
// body. Throws on a bad scheme/URL or a host that resolves into a blocked range.
export const safeGot = async (url: string): Promise<any> => fetchOnce(url, MAX_REDIRECTS);
