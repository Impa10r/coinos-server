import { beforeEach, describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import users from "$routes/users";

// nostrAuth was the only login path with no second-factor gate: it accepted a
// `twofa` field and discarded it (`twofa: _twofa`), so an account that had
// turned 2FA on could be entered with a nostr signature alone. The nostr key
// is a separate, lower-assurance credential, usually held in a browser
// extension — not what a second factor is meant to be second to.
//
// coinos-ui already had a branch for a 401 whose body starts with "2fa" on
// this exact endpoint, so the client was written against a check the server
// never made.

const ID = "12121212-1212-1212-1212-121212121212";
const CHALLENGE = "chal-1";
const OTPSECRET = "JBSWY3DPEHPK3PXP";

const kv = () => (globalThis as any).__testStore.kvStore;

const ctx = (body: any) =>
  ({
    req: { json: async () => body, header: () => undefined },
    get: () => undefined,
    json: (payload: any, status?: number) => ({ payload, status: status ?? 200 }),
  }) as any;

const signedLogin = () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [["challenge", CHALLENGE]],
    },
    sk,
  );
  return { pk, event };
};

const seed = (pk: string, twofa: boolean) => {
  kv()[`user:${ID}`] = JSON.stringify({
    id: ID,
    username: "nostrite",
    pubkey: pk,
    twofa,
    otpsecret: OTPSECRET,
    currency: "USD",
  });
  kv()[`user:${pk}`] = JSON.stringify(ID);
  kv()[`challenge:${CHALLENGE}`] = JSON.stringify(CHALLENGE);
};

describe("nostrAuth applies the second factor", () => {
  beforeEach(() => {
    for (const k of Object.keys(kv())) delete kv()[k];
  });

  test("a valid signature alone is refused when 2FA is on", async () => {
    const { pk, event } = signedLogin();
    seed(pk, true);

    const res = await users.nostrAuth(ctx({ event, challenge: CHALLENGE }));

    expect(res.status).toBe(401);
    // coinos-ui matches on this prefix to drive its code prompt.
    expect(String(res.payload)).toStartWith("2fa");
  });

  test("a wrong code is refused too", async () => {
    const { pk, event } = signedLogin();
    seed(pk, true);

    const res = await users.nostrAuth(ctx({ event, challenge: CHALLENGE, twofa: "000000" }));

    expect(res.status).toBe(401);
  });

  test("an account without 2FA is not asked for a code", async () => {
    const { pk, event } = signedLogin();
    seed(pk, false);

    // It proceeds past the gate and on to issuing a token; the fake context has
    // no real cookie jar, so only assert it was not stopped at the 2FA check.
    const res = await users
      .nostrAuth(ctx({ event, challenge: CHALLENGE }))
      .catch(() => ({ payload: "threw past the gate", status: 0 }));

    expect(String(res.payload)).not.toStartWith("2fa");
  });
});

describe("update() offers no second path to the 2FA flag", () => {
  test("twofa is not in the assignable attribute list", async () => {
    // Asserting a declaration rather than behaviour: `attributes` is a
    // module-local const and update() needs a signed token to reach. The
    // trailing comma distinguishes a list entry from the comment left in its
    // place. disable2fa() gates this state change on a TOTP; the whitelist
    // used to offer the same change with no check at all.
    const src = await Bun.file("routes/users.ts").text();
    const start = src.indexOf("const attributes = [");
    const list = src.slice(start, src.indexOf("];", start));
    expect(list).not.toContain('"twofa",');
  });
});
