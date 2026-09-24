import config from "$config";
import { db, g } from "$lib/db";
import ln from "$lib/ln";
import { warn } from "$lib/logging";
import { getMlsUsers } from "$lib/mls";
import { EX, get, getCount, getNostrUser, getProfile, publish, q, serverPubkey } from "$lib/nostr";
import { parseContent } from "$lib/notes";

// How many DISTINCT pubkeys one request may resolve profiles for, and they are
// resolved CONCURRENTLY. An uncached profile misses redis, misses the local
// relay, then opens a websocket to every configured external relay (7 here) and
// waits up to RELAY_TIMEOUT. Done sequentially that is cap x 5s of held request
// time; done concurrently the whole request is bounded by a single timeout
// instead. The cap is what bounds outbound fan-out (cap x 7 sockets); the
// concurrency is what bounds latency. Names beyond the cap are omitted and the
// client renders the npub, which beats a request that hangs for a minute.
const MAX_PROFILE_LOOKUPS = 8;

// Resolve a deduped, capped set of pubkeys at once. Returns a Map, missing
// entries meaning "not resolved" rather than "no such profile".
const resolveProfiles = async (pubkeys: string[]) => {
  const wanted = [...new Set(pubkeys.filter(Boolean))].slice(0, MAX_PROFILE_LOOKUPS);
  const results = await Promise.all(
    wanted.map(async (pk) => [pk, (await getProfile(pk).catch(() => null)) ?? null] as const),
  );
  return new Map(results);
};
import { scan } from "$lib/strfry";
import { bail, fail, fields, getUser } from "$lib/utils";
import got from "got";
import type { Event } from "nostr-tools";
import { decode } from "nostr-tools/nip19";

import { getZapEndpoint, makeZapRequest } from "nostr-tools/nip57";

// Amount and payer of a zap receipt. NIP-57 kind 9735: amount comes from
// decoding the paid bolt11, payer from the embedded 9734 zap request in the
// description tag. NIP-177 kind 9736 (BOLT12 zaps): amount is an explicit
// msat tag, and the receipt is payer-published with the signed 9737 intent in
// the description tag.
const parseZap = async (ev) => {
  const { kind, tags, pubkey } = ev;
  const description = tags.find((t) => t[0] === "description")?.[1];

  let payer;
  try {
    payer = JSON.parse(description).pubkey;
  } catch {}
  payer ||= pubkey;

  let amount = 0;
  if (kind === 9736) {
    const msat = Number.parseInt(tags.find((t) => t[0] === "amount")?.[1]);
    if (msat > 0) amount = Math.round(msat / 1000);
  } else {
    try {
      const bolt11 = tags.find((t) => t[0] === "bolt11")?.[1];
      const { amount_msat } = await ln.decode(bolt11);
      if (amount_msat) amount = Math.round(amount_msat / 1000);
    } catch {}
  }

  return { amount, pubkey: payer };
};

export default {
  async mlsUsers(c) {
    try {
      return c.json(await getMlsUsers());
    } catch (e) {
      return bail(c, e);
    }
  },

  async event(c) {
    try {
      let id = c.req.param("id");
      const full = c.req.url.endsWith("full");

      if (id.startsWith("nevent")) id = decode(id).data.id;
      if (id.startsWith("note")) id = decode(id).data;

      const k = `event:${id}${full ? ":full" : ""}`;
      let event = await g(k);
      if (event) return c.json(event);

      event = await get({ ids: [id] });
      if (!full) return c.json(event);
      // Only the `full` path is tightened: it goes on to parse the event, and
      // parseContent(undefined) threw. The plain path's existing 200-with-null
      // is left alone rather than changed underneath its callers.
      if (!event) return bail(c, "event not found", 404);

      const parts = parseContent(event);

      let pubkeys = parts
        .filter(({ type }) => type.includes("nprofile") || type.includes("npub"))
        .map(({ value }) => value.pubkey);

      const zapEvents = await scan({ kinds: [9735, 9736], "#e": [id] });
      const zaps = [];
      for (const zapEvent of zapEvents) {
        zaps.push(await parseZap(zapEvent));
      }

      pubkeys.push(event.pubkey);
      pubkeys.push(...zaps.map((z) => z.pubkey).filter((p) => p));
      pubkeys = [...new Set(pubkeys)];
      const profiles = await scan({ kinds: [0], authors: pubkeys });
      const found = profiles.map((p) => p.pubkey);
      const missing = pubkeys.filter((p) => !found.includes(p));

      const missingProfiles = (
        await q({
          kinds: [0],
          authors: missing,
        })
      )
        .reduce((a, b) => {
          a.set(b.pubkey, b.created_at > (a.get(b.pubkey)?.created_at || 0) ? b : a.get(b.pubkey));
          return a;
        }, new Map())
        .values();

      profiles.push(...missingProfiles);

      event.parts = parts;
      event.names = profiles.reduce((a, b) => {
        const { content } = b;
        const { name } = JSON.parse(content);
        a[b.pubkey] = name;
        return a;
      }, {});

      event.author = profiles.find((p) => p.pubkey === event.pubkey);

      event.zaps = zaps
        .filter((z) => z.amount > 0)
        .map(({ amount, pubkey }) => ({
          amount,
          user: profiles.find((p) => p.pubkey === pubkey),
        }));

      await db.set(k, JSON.stringify(event), { EX });

      return c.json(event);
    } catch (e) {
      warn("event failed", e.message);
      return bail(c, e);
    }
  },

  async parse(c) {
    const body = await c.req.json();
    const { event } = body;
    const parts = parseContent(event);
    const names = {};

    // Deduped and capped. This endpoint is unauthenticated and the content is
    // the caller's, so the loop used to run once per npub they chose to
    // include, with no ceiling. An uncached pubkey is not a cheap lookup: it
    // misses redis, misses the local relay, and then opens a websocket to
    // EVERY configured external relay (7 on this deployment). Measured at
    // ~2.1s and 7 outbound connections per uncached npub, so a note carrying a
    // few hundred random npubs was minutes of held request time and thousands
    // of outbound sockets, from one unauthenticated POST.
    //
    // Deduping matters on its own: getProfile caches, so repeats were already
    // cheap, and the expensive case is exactly the distinct-random one.
    const profiles = await resolveProfiles(
      parts
        .filter(({ type }) => type.includes("nprofile") || type.includes("npub"))
        .map(({ value }) => value.pubkey),
    );

    // An unresolved pubkey yields null, not a throw — a single unknown npub in
    // a parsed note used to 500 the whole request by destructuring it.
    for (const [pubkey, profile] of profiles) names[pubkey] = profile?.name;

    return c.json({ parts, names });
  },

  async thread(c) {
    try {
      const id = c.req.param("id");

      const event = await get({ ids: [id] });
      // An unknown id resolves to undefined, and reading .tags off it threw a
      // TypeError that bail() reported as a 500. A thread nobody has is a 404.
      if (!event) return bail(c, "thread not found", 404);

      const rootId = event.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1];

      let root;
      if (rootId) root = await get({ ids: [rootId] });
      else root = event;

      const thread = [root, ...(await q({ kinds: [1], "#e": [root.id] }))];

      // Same unbounded fan-out as parse(), squared: one getProfile per event
      // for its author, plus one per npub inside each event's content, over a
      // thread whose length the caller does not control but an attacker can
      // grow by replying to their own note. Each uncached pubkey opens a
      // websocket to every configured external relay. One budget for the whole
      // request, deduped, so a long thread degrades to fewer resolved names
      // rather than to minutes of held connections.
      // Parse first so every pubkey the thread needs is known, then resolve
      // them all in one capped concurrent batch. The previous shape was a
      // getProfile per event for its author PLUS one per npub inside each
      // event's body, awaited one at a time — a fan-out the caller grows just
      // by replying to their own note, each uncached hit opening a websocket to
      // every configured relay.
      for (const t of thread) {
        const e = t as any;
        e.parts = parseContent(e);
        e.names = {};
      }

      const profiles = await resolveProfiles([
        ...thread.map((t: any) => t.pubkey),
        ...thread.flatMap((t: any) =>
          t.parts
            .filter(({ type }) => type.includes("nprofile") || type.includes("npub"))
            .map(({ value }) => value.pubkey),
        ),
      ]);

      for (const t of thread) {
        const e = t as any;
        e.author = profiles.get(e.pubkey) ?? null;
        for (const { type, value } of e.parts) {
          if (type.includes("nprofile") || type.includes("npub"))
            e.names[value.pubkey] = profiles.get(value.pubkey)?.name;
        }
      }

      return c.json(thread);
    } catch (e) {
      warn("thread failed", e.message);
      return bail(c, e);
    }
  },

  async zaps(c) {
    try {
      let id = c.req.param("id");
      if (id.startsWith("nevent")) id = decode(id).data.id;
      if (id.startsWith("note")) id = decode(id).data;
      // q() scans the local strfry and falls back to primal (the old code
      // called a `sync` helper that never existed and threw ReferenceError
      // whenever the local relay had no receipts)
      const filter = { kinds: [9735, 9736], "#e": [id] };
      const events = await q(filter);
      if (!events.length) return c.json([]);

      const zaps = [];
      for (const zapEvent of events) {
        const { amount, pubkey } = await parseZap(zapEvent);

        let user;
        if (pubkey) {
          try {
            user = await getNostrUser(pubkey);
            zaps.push({ amount, user });
          } catch {}
        }
      }

      return c.json(zaps.filter((z) => z.amount > 0));
    } catch (e) {
      warn("zaps failed", e.message);
      return bail(c, e);
    }
  },

  async publish(c) {
    try {
      const body = await c.req.json();
      const { event } = body;
      const user = c.get("user");
      const { pubkey } = user;

      await publish(event);

      if (event.kind === 3) {
        db.del(`${pubkey}:follows`);
        db.del(`${pubkey}:follows:n`);
      }

      return c.json({});
    } catch (e) {
      warn("publish failed", e.message);
      return bail(c, e);
    }
  },

  async events(c) {
    const pubkey = c.req.param("pubkey");
    try {
      const events = await q({ kinds: [1], authors: [pubkey], limit: 20 });

      for (const v of events) {
        const e = v as any;
        e.author = await getProfile(e.pubkey);
        e.parts = parseContent(e);
        e.names = {};
        for (const { type, value } of e.parts) {
          if (type.includes("nprofile") || type.includes("npub")) {
            const { name } = (await getProfile(value.pubkey)) ?? ({} as any);
            e.names[value.pubkey] = name;
          }
        }
      }

      return c.json(events);
    } catch (e) {
      warn("events failed", e.message);
      return bail(c, e);
    }
  },

  async follows(c) {
    const pubkey = c.req.param("pubkey");
    const limit = parseInt(c.req.query("limit") || "20");
    const offset = parseInt(c.req.query("offset") || "0");
    const pubkeysOnly = c.req.query("pubkeysOnly");
    try {
      const k = `${pubkey}:follows${pubkeysOnly ? ":pubkeys" : ""}`;
      let follows = await g(k);
      if (follows?.length) return c.json(follows);

      const event = await get({ authors: [pubkey], kinds: [3] });
      if (!event) return c.json([]);

      let pubkeys = event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]);

      follows = [];
      if (pubkeysOnly) follows = pubkeys;
      else {
        pubkeys = pubkeys.slice(offset, offset + limit);
        follows = (
          await Promise.allSettled(
            pubkeys.map(async (pubkey) => ({
              ...(await getProfile(pubkey)),
              pubkey,
            })),
          )
        )
          .filter((r) => r.status === "fulfilled")
          .map((r) => r.value);
      }

      await db.set(k, JSON.stringify(follows), { EX });

      return c.json(follows);
    } catch (e) {
      warn("follows fail", e.message);
      return bail(c, e);
    }
  },

  async followers(c) {
    const pubkey = c.req.param("pubkey");
    const limit = parseInt(c.req.query("limit") || "20");
    const offset = parseInt(c.req.query("offset") || "0");
    try {
      let followers = await g(`${pubkey}:followers`);
      if (followers?.length) return c.json(followers);

      const events = await q({ kinds: [3], "#p": [pubkey], limit });
      if (!events.length) return c.json([]);

      const pubkeys = events.map((e) => e.pubkey).slice(offset, offset + limit);
      followers = (
        await Promise.allSettled(
          pubkeys.map(async (pubkey) => ({
            ...(await getProfile(pubkey)),
            pubkey,
          })),
        )
      )
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value);

      await db.set(`${pubkey}:followers`, JSON.stringify(followers), { EX });

      return c.json(followers);
    } catch (e) {
      warn("followers failed", e.message);
      return bail(c, e);
    }
  },

  async count(c) {
    try {
      const pubkey = c.req.param("pubkey");
      return c.json(await getCount(pubkey));
    } catch (e) {
      warn("count failed", e.message);
      return bail(c, e);
    }
  },

  async identities(c) {
    const name = c.req.query("name");
    let names = {};
    if (name) {
      // v3 registrar first: a claimed name's NIP-05 belongs to its wallet key.
      // Legacy accounts answer as before when the registrar doesn't know it.
      //
      // Opt-in on NAMES_URL, matching routes/lnurl.ts. This used to default to
      // names.coinos.io, so an instance with no v3 migration — no NAMES_URL
      // set anywhere — still called out to a third-party registrar on every
      // NIP-05 lookup, and would answer for its OWN user with whatever pubkey
      // that registrar returned for the name. lnurl.ts deliberately carries no
      // default for exactly this reason; this was the one spot that did.
      if (process.env.NAMES_URL) {
        try {
          const r = await fetch(
            `${process.env.NAMES_URL}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
            { signal: AbortSignal.timeout(3000) },
          );
          if (r.ok) {
            const j = await r.json();
            if (j?.names?.[name]) return c.json({ names: { [name]: j.names[name] } });
          }
        } catch {}
      }
      const u = await getUser(name, fields);
      if (!u) return c.json({ names: {} }); // unknown name: empty per NIP-05, not a 500
      names = { [name]: u.pubkey };
    } else {
      const records = await db.sMembers("nip5");
      for (const s of records) {
        const [name, pubkey] = (s as string).split(":");
        names[name] = pubkey;
      }
    }

    return c.json({ names });
  },

  async info(c) {
    return c.json({ pubkey: serverPubkey });
  },

  async profile(c) {
    // Had no try/catch: decode() throws on anything that is not a valid
    // npub/nprofile, and the throw escaped to app.onError as an unhandled
    // 500 — so a typo in a url was logged as a server fault. It is bad input.
    const profile = c.req.param("profile");
    let pubkey: string | undefined;
    let relays: string[] | undefined;
    try {
      // decode() returns a different shape per type: an nprofile carries
      // { pubkey, relays }, but an npub's data is the bare hex pubkey STRING.
      // The old code destructured { pubkey, relays } from both, so every npub
      // yielded pubkey === undefined, and getProfile(undefined) quietly
      // returned an anon placeholder and cached it under "profile:undefined".
      // So this route has never worked for an npub; it only looked like it did.
      const { type, data } = decode(profile) as { type: string; data: any };
      if (type === "npub") pubkey = data as string;
      else if (type === "nprofile") ({ pubkey, relays } = data);
      else return bail(c, "invalid profile", 400);
    } catch {
      return bail(c, "invalid profile", 400);
    }
    if (!pubkey) return bail(c, "invalid profile", 400);

    const recipient = await (getProfile as any)(pubkey, relays);
    if (!recipient) return bail(c, "profile not found", 404);
    recipient.relays = relays;
    return c.json(recipient);
  },

  async zapRequest(c) {
    try {
      const body = await c.req.json();
      const { amount, id } = body;
      const target = await get({ ids: [id] });
      if (!target) return bail(c, "event not found", 404);
      const { pubkey } = target;
      const event = await (makeZapRequest as any)({
        profile: pubkey,
        event: id,
        amount: amount * 1000,
        relays: config.relays,
        comment: "",
      });

      return c.json(event);
    } catch (e) {
      warn("zapRequest failed", e.message);
    }
  },

  async zap(c) {
    try {
      const body = await c.req.json();
      const { event } = body;
      const amount = event.tags.find((t) => t[0] === "amount")[1];
      const pubkey = event.tags.find((t) => t[0] === "p")[1];
      const content = JSON.stringify(await getProfile(pubkey));
      const callback = await getZapEndpoint({ content } as Event);
      if (!callback || callback === "null") fail("Lightning address not found", 404);

      const encodedEvent = encodeURI(JSON.stringify(event));
      const url = `${callback}?amount=${amount}&nostr=${encodedEvent}`;
      const json = await got(url).json();

      return c.json(json);
    } catch (e) {
      warn("zap failed", e.message);
      return bail(c, e);
    }
  },
};
