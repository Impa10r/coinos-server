import { mock } from "bun:test";

// Route modules read these at import time (routes/users.ts builds a URL from
// process.env.URL, routes/lnurl.ts splits it), so they have to exist before
// anything imports them or the module throws on load.
process.env.URL ||= "http://localhost:3119";

// This file is loaded before test files via bunfig.toml [test].preload
// Mocks must be set up here to intercept transitive imports

if (process.env.INTEGRATION) {
  // Skip all mocking — use real services
  globalThis.__testStore = { kvStore: {}, listStore: {}, setStore: {} };
} else {
  let kvStore: Record<string, string> = {};
  let listStore: Record<string, string[]> = {};
  let setStore: Record<string, Set<string>> = {};

  globalThis.__testStore = { kvStore, listStore, setStore };

  const makeMulti = () => {
    const ops: Array<() => Promise<any>> = [];
    const chain: any = {
      set: (k: string, v: string) => {
        ops.push(async () => {
          globalThis.__testStore.kvStore[k] = v;
        });
        return chain;
      },
      lPush: (k: string, v: string) => {
        ops.push(async () => {
          const ls = globalThis.__testStore.listStore;
          if (!ls[k]) ls[k] = [];
          ls[k].unshift(v);
        });
        return chain;
      },
      del: (k: string) => {
        ops.push(async () => {
          delete globalThis.__testStore.kvStore[k];
        });
        return chain;
      },
      lRem: (k: string, _count: number, v: string) => {
        ops.push(async () => {
          const ls = globalThis.__testStore.listStore;
          if (ls[k]) {
            const idx = ls[k].indexOf(v);
            if (idx >= 0) ls[k].splice(idx, 1);
          }
        });
        return chain;
      },
      sRem: (k: string, v: string) => {
        ops.push(async () => globalThis.__testStore.setStore[k]?.delete(v));
        return chain;
      },
      exec: async () => {
        for (const op of ops) await op();
        return [];
      },
    };
    return chain;
  };

  mock.module("$lib/db", () => {
    const kv = () => globalThis.__testStore.kvStore;
    const ls = () => globalThis.__testStore.listStore;
    const ss = () => globalThis.__testStore.setStore;
    const g = async (k: string) => {
      const v = kv()[k] ?? null;
      if (v === null) return null;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    };
    const s = (k: string, v: any) => {
      if (k === "user:null" || k === "user:undefined") throw new Error("null user");
      kv()[k] = JSON.stringify(v);
    };
    const gf = async (k: string) => {
      const v = kv()[k] ?? null;
      if (v === null) return null;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    };
    const sa = (k: string, v: any) => {
      globalThis.__testStore.archiveStore ??= {};
      globalThis.__testStore.archiveStore[k] = JSON.stringify(v);
    };
    const ga = async (k: string) => {
      const v = globalThis.__testStore.archiveStore?.[k] ?? null;
      if (v === null) return null;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    };
    return {
      db: {
        get: async (k: string) => kv()[k] ?? null,
        set: async (k: string, v: string, opts?: any) => {
          if (opts?.NX && kv()[k] !== undefined) return null;
          kv()[k] = v;
          return "OK";
        },
        del: async (k: string) => {
          delete kv()[k];
          return 1;
        },
        exists: async (k: string) => (kv()[k] !== undefined ? 1 : 0),
        lPush: async (k: string, v: string) => {
          if (!ls()[k]) ls()[k] = [];
          ls()[k].unshift(v);
          return ls()[k].length;
        },
        lRem: async (k: string, _count: number, v: string) => {
          if (!ls()[k]) return 0;
          const idx = ls()[k].indexOf(v);
          if (idx >= 0) {
            ls()[k].splice(idx, 1);
            return 1;
          }
          return 0;
        },
        lRange: async (k: string, start: number, end: number) => {
          if (!ls()[k]) return [];
          if (end === -1) return ls()[k].slice(start);
          return ls()[k].slice(start, end + 1);
        },
        lPos: async (k: string, v: string) => {
          if (!ls()[k]) return null;
          const idx = ls()[k].indexOf(v);
          return idx >= 0 ? idx : null;
        },
        sAdd: async (k: string, ...vals: string[]) => {
          if (!ss()[k]) ss()[k] = new Set();
          for (const v of vals) ss()[k].add(v);
          return vals.length;
        },
        sRem: async (k: string, v: string) => (ss()[k]?.delete(v) ? 1 : 0),
        sIsMember: async (k: string, v: string) => ss()[k]?.has(v) ?? false,
        sMembers: async (k: string) => (ss()[k] ? [...ss()[k]] : []),
        incrBy: async (k: string, n: number) => {
          const v = Number.parseInt(kv()[k] || "0") + n;
          kv()[k] = String(v);
          return v;
        },
        decrBy: async (k: string, n: number) => {
          const v = Number.parseInt(kv()[k] || "0") - n;
          kv()[k] = String(v);
          return v;
        },
        watch: async () => {},
        multi: makeMulti,
        expire: async () => 1,
        setNX: async (k: string, v: string) => {
          if (kv()[k]) return false;
          kv()[k] = v;
          return true;
        },
        zScore: async () => null,
        zAdd: async () => 1,
        zCard: async () => 0,
        zRemRangeByRank: async () => 0,
        keys: async (pattern: string) => {
          const ss = globalThis.__testStore.setStore;
          const prefix = pattern.replace("*", "");
          return Object.keys(ss).filter((k) => k.startsWith(prefix));
        },
        type: async (k: string) => {
          if (globalThis.__testStore.setStore[k]) return "set";
          if (globalThis.__testStore.listStore[k]) return "list";
          if (globalThis.__testStore.kvStore[k] !== undefined) return "string";
          return "none";
        },
      },
      g,
      s,
      gf,
      gfAll: async (keys: string[]) => Promise.all(keys.map(gf)),
      // Async generator over the kv store, matching lib/db.ts's scan(). Needed
      // by routes/users.ts, which cannot be imported without it.
      scan: async function* (pattern: string) {
        const prefix = pattern.replace("*", "");
        for (const k of Object.keys(kv())) if (k.startsWith(prefix)) yield k;
      },
      sa,
      ga,
      archive: { lRange: async () => [] },
    };
  });

  mock.module("$config", () => ({
    default: {
      bitcoin: {
        host: "localhost",
        wallet: "test",
        user: "u",
        password: "p",
        network: "regtest",
        port: 18443,
      },
      liquid: {
        host: "localhost",
        wallet: "test",
        user: "u",
        password: "p",
        btc: "test-asset",
        port: 7040,
      },
      lightning: "/dev/null",
      fee: { bitcoin: 0.004, liquid: 0.001, lightning: 0.001 },
      ark: { arkPrivateKey: "0000", arkServerUrl: "http://localhost" },
      nostr: "ws://localhost:7777",
      tigerbeetle: { cluster_id: 0n, replica_addresses: ["localhost:3000"] },
      vapid: { pk: "test", sk: "test" },
      support: "test@test.com",
      txWebhookSecret: "test",
    },
  }));

  mock.module("$lib/tb", () => ({
    // Per-account when a test sets __testStore.balances, so a test can tell
    // which account a balance was read from (the frozen-balance check in
    // debit() compares two different accounts). Default unchanged.
    getBalance: mock(async (id: string) =>
      (globalThis as any).__testStore.balances?.[id] ?? 10_000_000,
    ),
    getPending: mock(async () => 0),
    getCredit: mock(async () => 0),
    tbDebit: mock(async () => 0),
    tbCredit: mock(async () => undefined),
    tbRefund: mock(async () => undefined),
    tbReverse: mock(async () => undefined),
    tbConfirm: mock(async () => undefined),
    tbSetBalance: mock(async () => undefined),
    tbSetPending: mock(async () => undefined),
    tbSetCredit: mock(async () => undefined),
    tbFundCredit: mock(async () => undefined),
    tbFundDebit: mock(async () => ({ err: null })),
    getFundBalance: mock(async () => 0),
    createBalanceAccount: mock(async () => {}),
    createCreditAccounts: mock(async () => {}),
    createFundAccount: mock(async () => {}),
    tbMultiplyForMicrosats: mock(async () => 1),
    initTigerBeetle: mock(async () => {}),
  }));

  mock.module("$lib/ln", () => ({
    default: {
      decode: mock(async () => ({ type: "bolt11", amount_msat: 1_000_000, payee: "test-payee" })),
      listpeerchannels: mock(async () => ({ channels: [] })),
      listpays: mock(async () => ({ pays: [] })),
      xpay: mock(async () => ({ amount_sent_msat: 1_000_000, payment_preimage: "preimage-abc" })),
      getinfo: mock(async () => ({ id: "our-node-id" })),
      listinvoices: mock(async () => ({ invoices: [] })),
      listfunds: mock(async () => ({ channels: [] })),
      keysend: mock(async () => ({})),
      fetchinvoice: mock(async () => ({})),
      getroutes: mock(async () => ({ routes: [] })),
      sendinvoice: mock(async () => ({})),
    },
    lnb: {
      decode: mock(async () => ({ type: "bolt11", amount_msat: 1_000_000, payee: "test-payee" })),
      listpeerchannels: mock(async () => ({ channels: [] })),
      listpays: mock(async () => ({ pays: [] })),
      xpay: mock(async () => ({ amount_sent_msat: 1_000_000, payment_preimage: "preimage-abc" })),
      getinfo: mock(async () => ({ id: "our-node-id-b" })),
      listinvoices: mock(async () => ({ invoices: [] })),
      listfunds: mock(async () => ({ channels: [] })),
      keysend: mock(async () => ({})),
    },
    lnListen: {
      waitanyinvoice: mock(async () => {
        throw { code: 904, message: "timed out" };
      }),
    },
  }));

  mock.module("$lib/logging", () => ({
    l: () => {},
    warn: mock(() => {}),
    err: () => {},
    shortError: (msg: any, max = 400): string => {
      let s = typeof msg === "string" ? msg : (msg?.message ?? String(msg));
      return s.length > max ? `${s.slice(0, max)}…` : s;
    },
    line: () => "test:0",
  }));
  mock.module("$lib/notifications", () => ({ notify: () => {}, nwcNotify: () => {} }));
  // A spy that WRAPS the real callWebhook rather than replacing it.
  // forward.test.ts and onchain.test.ts need .mockClear()/.toHaveBeenCalled();
  // webhook-tls.test.ts needs the real HTTP behaviour, because the thing worth
  // testing is that it refuses an untrusted certificate while carrying a
  // merchant's shared secret. Replacing it with a no-op made that untestable.
  //
  // Imported here, after the logging mock above, so the real module binds the
  // mocked logger. It returns early unless the invoice carries a `webhook`
  // url, and no fixture sets one, so nothing reaches the network by accident.
  const { callWebhook: realCallWebhook } = await import("$lib/webhooks");
  mock.module("$lib/webhooks", () => ({ callWebhook: mock(realCallWebhook) }));
  mock.module("$lib/sockets", () => ({
    emit: mock(() => {}),
    sendHeartbeat: () => {},
    broadcast: mock(() => {}),
    websocket: { message: mock(async () => {}), close: mock(() => {}), open: mock(() => {}) },
  }));
  mock.module("$lib/esplora", () => ({
    btcNetwork: { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
    hdVersions: { private: 0x04358394, public: 0x043587cf },
    getAddressTxs: mock(async (address: string) => {
      const txs = globalThis.__testStore.esploraOverride?.addressTxs?.[address];
      return txs || [];
    }),
    getTxStatus: mock(async (txid: string) => {
      const status = globalThis.__testStore.esploraOverride?.txStatus?.[txid];
      return status || { confirmed: false };
    }),
    getAddressUtxos: mock(async () => []),
    getUtxos: mock(async () => []),
    getTxHex: mock(async () => ""),
    getTx: mock(async () => ({})),
    broadcastTx: mock(async () => ({})),
    getFeeEstimates: mock(async () => ({})),
    deriveAddress: mock(() => ({ address: "bcrt1qmock" })),
    deriveAddresses: mock(() => []),
    parseDescriptor: mock(() => ({})),
    findLastUsedIndex: mock(async () => -1),
  }));
  mock.module("$lib/nostr", () => ({
    handleZap: async () => {},
    publish: async () => {},
    serverPubkey: "m",
    serverPubkey2: "m",
    serverSecret: "m",
    serverSecret2: "m",
    EX: 60 * 60 * 24,
    anon: (pubkey: string) => ({ pubkey, name: "Anonymous" }),
    get: mock(async () => null),
    getCount: mock(async () => 0),
    getNostrUser: mock(async () => null),
    getProfile: mock(async () => null),
    getRelays: mock(async () => []),
    q: mock(async () => []),
    encryptionSchemes: mock(async () => ["nip44_v2"]),
    decryptPayload: mock(async (payload: string) => payload),
    encryptPayload: mock(async (payload: string) => payload),
  }));
  mock.module("$lib/ark", () => ({
    getArkAddress: async () => "ark-addr",
    sendArk: async () => "ark-txid",
    getArkBalance: async () => 0,
    verifyArkVtxo: async () => true,
  }));
  mock.module("$lib/ecash", () => ({
    request: async () => ({}),
    get: mock(async () => ({})),
    claim: mock(async () => ({})),
    mint: mock(async () => ({})),
    check: mock(async () => ({})),
    init: mock(async () => ({})),
  }));
  mock.module("$lib/lightning", () => ({
    replay: async () => ({}),
    fixBolt12: () => {},
    listenForLightning: () => {},
    ensureListenerAlive: mock(async () => {}),
    getLightningListenerStatus: mock(() => ({ phase: "idle", phaseStartedAt: Date.now() })),
  }));
  mock.module("$lib/mail", () => ({
    mail: async () => {},
    alert: async () => {},
    templates: {},
  }));
  mock.module("$lib/api", () => ({
    default: { bitcoin: "http://localhost", liquid: "http://localhost" },
  }));
  mock.module("$lib/store", () => ({ default: { rates: { USD: 50000 } } }));
  mock.module("@coinos/rpc", () => ({
    default: () =>
      new Proxy(
        {},
        {
          get:
            (_target, prop) =>
            async (...args: any[]) => {
              const override = globalThis.__testStore.rpcOverride;
              if (override && typeof override[prop] === "function") {
                return override[prop](...args);
              }
              return {};
            },
        },
      ),
  }));

  // Spread from the REAL module rather than re-implementing it. fail() and
  // bail() were hand-copied here, and drifted the moment lib/utils.ts changed:
  // fail() started tagging a refusal with a status and bail() started reading
  // it off the error, while this mock still threw a bare Error and answered a
  // flat 500 — so every test on a refusal path asserted the mock's behaviour,
  // not the app's. (The comment on bail below records the same drift happening
  // once already, during the Fastify->Hono migration.) Only the entries that
  // genuinely need the test store are overridden, and they come after the
  // spread so they still win.
  const realUtils = await import("$lib/utils");
  mock.module("$lib/utils", () => {
    const SATS = 100_000_000;
    const kv = () => globalThis.__testStore.kvStore;
    return {
      ...realUtils,
      SATS,
      btc: (n: number) => Number.parseFloat((n / SATS).toFixed(8)),
      fmt: (n: number) => String(n),
      formatReceipt: () => {},
      getInvoice: async (hash: string) => {
        const raw = kv()[`invoice:${hash}`] ?? null;
        if (!raw) return null;
        let iid;
        try {
          iid = JSON.parse(raw);
        } catch {
          iid = raw;
        }
        if (iid?.id) iid = iid.id;
        else if (iid?.hash) iid = iid.hash;
        const raw2 = kv()[`invoice:${iid}`] ?? null;
        if (!raw2) return null;
        try {
          return JSON.parse(raw2);
        } catch {
          return raw2;
        }
      },
      getPayment: async (id: string) => {
        const raw = kv()[`payment:${id}`];
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed === "string") {
            const p = kv()[`payment:${parsed}`];
            return p ? JSON.parse(p) : null;
          }
          return parsed;
        } catch {
          return null;
        }
      },
      // Mirrors lib/utils.ts's getUser, including the pointer hop: a
      // `user:<username>` / `user:<pubkey>` key holds the uid as a string, and
      // the real function follows it to the record. This mock returned the
      // bare uid string, so any handler that looked a user up by name or key
      // got a string where it expected an object and failed somewhere else.
      getUser: async (username: string) => {
        const k = username?.replace(/\s/g, "").toLowerCase();
        const raw = kv()[`user:${k}`];
        if (!raw) return null;
        let user = JSON.parse(raw);
        if (typeof user === "string") {
          const rec = kv()[`user:${user}`];
          user = rec ? JSON.parse(rec) : null;
        }
        return user;
      },
      getAccount: async () => null,
      link: (id: string) => `http://test/${id}`,
      sats: (n: number) => Math.round(n * SATS),
      sleep: async () => {},
      t: () => ({ insufficientFunds: "Insufficient funds" }),
      bip21: () => "",
      fields: [],
      nada: () => {},
      fiat: (n: number, r: number) => (n * r) / SATS,
      f: (s: any) => String(s),
      getClientIp: () => "127.0.0.1",
      // lib/app.ts imports this, so the module cannot load without it. The
      // real one normalizes an IP to the unit banIp() stores — /64 for IPv6,
      // the address itself for IPv4, null for shared infrastructure. Nothing
      // under test exercises the normalization, so pass the address through.
      banKey: (ip: string) => ip ?? null,
      pick: (O: any, K: string[]) => K.reduce((o: any, k: string) => ((o[k] = O[k]), o), {}),
      prod: false,
      uniq: (a: any[], k: any) => [...new Map(a.map((x: any) => [k(x), x])).values()],
      wait: async () => {},
      time: () => ({ start: () => {}, end: () => {} }),
    };
  });
  // Placed after the $lib/utils mock above so the real module binds the mocked
  // utils, and spread from the real one rather than replaced wholesale.
  //
  // The middleware and eviction stubs are what route tests actually need. The
  // pure functions are not: stubbing requirePin to `async () => {}` meant no
  // test had ever exercised pin enforcement, which is how a pin comparison
  // that could never match a migrated account went unnoticed.
  const realAuth = await import("$lib/auth");
  mock.module("$lib/auth", () => ({
    ...realAuth,
    auth: (_r: any, _s: any, n: any) => n(),
    optional: (_r: any, _s: any, n: any) => n(),
    isEvicted: async () => false,
    evictUser: async () => {},
  }));
  // Also after the $lib/utils mock, and opt-in rather than absolute.
  //
  // The stub below echoes `...invoice` straight back, so a test asserting on a
  // field it passed in passes without any of generate() running — which is how
  // two tests of the aid-ownership check went green against a function that
  // had never been called. Set __testStore.realGenerate in a suite that needs
  // the real thing; everything else keeps the cheap stub, which is all
  // forward/onchain want from it.
  // Destructured, NOT kept as the namespace object: an ES module namespace is a
  // live view, so `ns.generate` re-resolves to whatever mock.module installed —
  // calling through it recursed until the stack gave out. Destructuring reads
  // the binding once and holds the original function.
  const { generate: realGenerate, parseEntry: realParseEntry } =
    await import("$lib/invoices");
  mock.module("$lib/invoices", () => ({
    generate: mock(async (args: any) => {
      if ((globalThis as any).__testStore.realGenerate) return realGenerate(args);
      const { invoice, user } = args;
      return { id: "gen-inv", hash: "gen-hash", uid: user?.id, received: 0, pending: 0, ...invoice };
    }),
    getUserOffer: mock(async () => ({ id: "gen-offer", hash: "gen-offer-hash" })),
    parseEntry: realParseEntry,
  }));
} // end INTEGRATION skip
