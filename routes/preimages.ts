import { createHash } from "node:crypto";
import { db } from "$lib/db";
import { bail, fail } from "$lib/utils";

// Merchants pre-load payment preimages here, then have buyers create invoices
// with usePreimage: true — each such invoice consumes the next queued preimage
// so its payment hash is sha256(preimage). Once paid, the preimage is exposed
// on the invoice record, letting a static storefront sell decryption secrets
// with no backend of its own.

const MAX_QUEUE = 1000;
const key = (uid) => `${uid}:preimages`;
const sha256 = (hex: string) => createHash("sha256").update(hex, "hex").digest("hex");

export default {
  async add(c) {
    try {
      const { preimages } = await c.req.json();
      if (!Array.isArray(preimages) || !preimages.length)
        fail("preimages array required");
      if (
        !preimages.every(
          (p) => typeof p === "string" && /^[0-9a-f]{64}$/i.test(p),
        )
      )
        fail("preimages must be 64-character hex strings");

      const user = c.get("user");
      const k = key(user.id);
      const existing = (await db.lRange(k, 0, -1)) as unknown as string[];
      const seen = new Set(existing);
      const fresh: string[] = [];
      for (let p of preimages) {
        p = p.toLowerCase();
        if (seen.has(p)) continue;
        seen.add(p);
        fresh.push(p);
      }

      if (existing.length + fresh.length > MAX_QUEUE)
        fail(`queue limited to ${MAX_QUEUE} preimages`);
      if (fresh.length) await db.rPush(k, fresh);

      return c.json({
        queued: existing.length + fresh.length,
        added: fresh.map((preimage) => ({ preimage, hash: sha256(preimage) })),
      });
    } catch (e) {
      return bail(c, e.message);
    }
  },

  async list(c) {
    try {
      const user = c.get("user");
      const preimages = (await db.lRange(key(user.id), 0, -1)) as unknown as string[];
      return c.json({
        queued: preimages.length,
        preimages: preimages.map((preimage) => ({
          preimage,
          hash: sha256(preimage),
        })),
      });
    } catch (e) {
      return bail(c, e.message);
    }
  },

  async clear(c) {
    try {
      const user = c.get("user");
      await db.del(key(user.id));
      return c.json({ queued: 0 });
    } catch (e) {
      return bail(c, e.message);
    }
  },
};
