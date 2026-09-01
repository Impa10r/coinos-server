import config from "$config";
import { g, gf } from "$lib/db";
import locales from "$lib/locales/index";
import net from "node:net";

const { URL } = process.env;

export const fail = (msg) => {
  throw new Error(msg);
};

// Best-effort real client IP: Cloudflare's header when the request came
// through the edge, x-forwarded-for's first hop when behind some other
// proxy, then the raw per-request socket address index.ts attaches as
// c.env.ip (the fallback that actually works for traffic reaching the
// origin directly, bypassing Cloudflare — cf-connecting-ip is simply absent
// on that traffic, not spoofed or malformed).
export const getClientIp = (c): string | undefined =>
  c.req.header("cf-connecting-ip") ||
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
  (c.env as any)?.ip ||
  undefined;

// Expand any legal IPv6 textual form (compressed `::`, embedded IPv4 tail,
// zone id) to its 8 hextets, lowercased with leading zeros stripped.
const expandIPv6 = (ip: string): string[] | null => {
  let s = ip.split("%")[0];

  const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${s.slice(0, -v4[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${(
      (o[2] << 8) |
      o[3]
    ).toString(16)}`;
  }

  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const tail = parts.length === 2 ? (parts[1] ? parts[1].split(":").filter(Boolean) : []) : null;

  const groups =
    tail === null ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];

  if (groups.length !== 8) return null;
  return groups.map((h) => h.replace(/^0+(?=.)/, "").toLowerCase());
};

// Normalize a source IP to the unit we actually ban.
//
// IPv4 bans the single address. IPv6 bans the /64: a residential IPv6 client
// rotates its address WITHIN its own /64 constantly (RFC 4941 privacy
// extensions — typically at least daily, often per outbound connection), so a
// /128 ban stops roughly one request and the same household is straight back
// on a fresh unbanned address, while `cf:banned` fills with dead one-shot
// entries. A /64 is a single end site by design (RFC 6177 — subscribers get a
// /64 at minimum, usually /56 or /48), so banning it doesn't reach past the
// one subscriber the /128 belonged to.
//
// Returns null for anything that isn't a parseable IP, so callers can skip.
export const banKey = (ip: string): string | null => {
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return null;

  // An IPv4-mapped address (::ffff:1.2.3.4 — what a dual-stack socket reports
  // for an IPv4 client) is an IPv4 client, not an IPv6 one. Taking its /64
  // would yield ::/64, which contains EVERY IPv4-mapped address — one ban
  // would lock out all IPv4 traffic. Ban the real address instead.
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return net.isIPv4(mapped[1]) ? mapped[1] : null;

  const groups = expandIPv6(ip);
  if (!groups) return null;

  const prefix = groups.slice(0, 4);
  // All-zero prefix is ::/64 — loopback, unspecified, and the mapped range.
  // Never bannable; refuse rather than blackhole them.
  if (prefix.every((h) => h === "0")) return null;

  while (prefix.length > 1 && prefix[prefix.length - 1] === "0") prefix.pop();
  return `${prefix.join(":")}::/64`;
};

export const nada = () => {};

export const sleep = (n) => new Promise((r) => setTimeout(r, n));
export const wait = async (f, s = 300, n = 50) => {
  let i = 0;
  while (!(await f()) && i < s) (await sleep(n)) && i++;
  if (i >= s) fail("timeout");
  return f();
};

export const prod = process.env.NODE_ENV === "production";

export const bail = (c, msg) => c.json(msg, 500);

export const SATS = 100000000;
export const sats = (n) => Math.round(n * SATS);
export const btc = (n) => parseFloat((n / SATS).toFixed(8));
export const fiat = (n, r) => (n * r) / SATS;

export const uniq = (a, k) => [...new Map(a.map((x) => [k(x), x])).values()];
export const pick = (O, K) =>
  K.reduce((o, k) => (typeof O[k] !== "undefined" && (o[k] = O[k]), o), {});

export const bip21 = (address, { amount, memo, tip, type }) => {
  if (!(amount || memo)) return address;

  const network = { liquid: "liquidnetwork", bitcoin: "bitcoin" }[type];
  const url = new URLSearchParams();

  if (amount) {
    url.append("amount", btc(amount + tip).toFixed(8));
    if (type === "liquid") url.append("assetid", config.liquid.btc);
  }

  if (memo) url.append("message", memo);

  return `${network}:${address}?${url.toString()}`;
};

export const getAccount = async (id) => {
  return g(`account:${id}`);
};

export const getUser = async (username, fields = undefined) => {
  if (username === "undefined") fail("invalid user");
  const k = username?.replace(/\s/g, "").toLowerCase();
  let user = await g(`user:${k}`);
  if (typeof user === "string") user = await g(`user:${user}`);

  return fields && user ? pick(user, fields) : user;
};

export const getInvoice = async (hash) => {
  let iid = await gf(`invoice:${hash}`);
  if (iid?.id) iid = iid.id;
  else if (iid?.hash) iid = iid.hash;
  return await gf(`invoice:${iid}`);
};

export const getPayment = async (id) => {
  let p = await gf(`payment:${id}`);
  if (typeof p === "string") p = await gf(`payment:${p}`);
  return p;
};

export const f = (s, currency) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  })
    .format(s)
    .replace("CA", "");

export function formatReceipt(items, currency) {
  function wrapText(text, maxWidth) {
    const words = text.split(" ");
    const lines = [];
    let currentLine = "";
    for (const word of words) {
      if (currentLine.length + word.length + 1 > maxWidth) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine += (currentLine.length > 0 ? " " : "") + word;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  }

  function calculateColumnWidths(items) {
    let maxQuantityLength = 0;
    let maxPriceLength = 0;

    for (const item of items) {
      const quantityLength = String(item.quantity).length;
      if (quantityLength > maxQuantityLength) {
        maxQuantityLength = quantityLength;
      }

      const priceLength = f(item.price * item.quantity, currency).length;
      if (priceLength > maxPriceLength) {
        maxPriceLength = priceLength;
      }
    }

    // Add padding to the widths for aesthetic spacing
    return {
      quantityColumnWidth: maxQuantityLength + 1, // Space after quantity
      priceColumnWidth: maxPriceLength + 1, // Space before price
    };
  }
  const maxLineWidth = 32;
  const { quantityColumnWidth, priceColumnWidth } = calculateColumnWidths(items);
  const nameColumnWidth = maxLineWidth - quantityColumnWidth - priceColumnWidth;

  return items
    .map((item) => {
      const quantityStr = String(item.quantity).padEnd(quantityColumnWidth);
      const priceStr = f(item.price * item.quantity, currency).padStart(priceColumnWidth);
      const nameLines = wrapText(item.name, nameColumnWidth);

      // Construct the full line(s) with the first line including the price
      const fullLines = [`${quantityStr}${nameLines[0].padEnd(nameColumnWidth)}${priceStr}`];
      // Add any additional name lines, properly indented
      for (let i = 1; i < nameLines.length; i++) {
        fullLines.push(" ".repeat(quantityColumnWidth) + nameLines[i]);
      }

      return fullLines.join("\n");
    })
    .join("\n");
}

export const t = ({ language = "en" }) => locales[language];

export const time = (() => {
  let count = 0;
  let started = false;
  return (s = "") => {
    if (!started) {
      console.time("");
      started = true;
    }
    console.timeLog("", ++count, s);
  };
})();

export const fmt = (sats) =>
  `⚡️${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(sats)}`;

export const link = (id) => `${URL}/payment/${id}`;

export const fields = [
  "about",
  "anon",
  "banner",
  "banner",
  "currency",
  "display",
  "id",
  "hidepay",
  "lud16",
  "memoPrompt",
  // a v3-migrated account: the names registrar owns this name for receiving
  "migrated",
  "npub",
  "picture",
  "prompt",
  "pubkey",
  "username",
  "website",
];
