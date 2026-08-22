#!/usr/bin/env bun

// Overlay one Redis/Kvrocks archive onto a base archive without materializing
// keys in memory. The source wins on collisions. SCAN is intentionally sent as
// a raw command because Kvrocks cursors can exceed JavaScript's safe integer
// range and node-redis' high-level scan helper rounds them.

import { createClient, type RedisClientType } from "redis";

const valueOption = (name: string) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const hasFlag = (name: string) => process.argv.includes(`--${name}`);
const positiveInteger = (name: string, fallback: number) => {
  const parsed = Number(valueOption(name) || fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
};

const sourceUrl = valueOption("source-url");
const baseUrl = valueOption("base-url");
const targetUrl = valueOption("target-url");
const verifyUrl = valueOption("verify-url");
const apply = hasFlag("apply");
const skipEqual = hasFlag("skip-equal");
const countTypes = hasFlag("count-types");
const batchSize = positiveInteger("batch", 512);
const concurrency = positiveInteger("concurrency", 32);
const progressEvery = positiveInteger("progress", 100_000);

if (!sourceUrl || (apply && !targetUrl)) {
  console.error(
    "usage: bun scripts/merge-kvrocks-archives.ts " +
      "--source-url=redis://127.0.0.1:6402 " +
      "[--base-url=redis://127.0.0.1:6401] " +
      "[--target-url=redis://127.0.0.1:6403 --apply] " +
      "[--batch=512] [--concurrency=32]",
  );
  process.exit(2);
}
if (apply && (sourceUrl === targetUrl || baseUrl === targetUrl)) {
  throw new Error("The target must be distinct from the source and base");
}

const makeClient = (url: string) =>
  createClient({
    url,
    socket: { reconnectStrategy: () => false },
  });
const source = makeClient(sourceUrl);
const base = baseUrl ? makeClient(baseUrl) : null;
const target = targetUrl ? makeClient(targetUrl) : null;
const verifier = verifyUrl ? makeClient(verifyUrl) : null;
const clients = [source, base, target, verifier].filter(
  Boolean,
) as RedisClientType[];

const concurrentMap = async <T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
) => {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
};

const valuesMatch = async (
  left: RedisClientType,
  right: RedisClientType,
  key: string,
  type: string,
) => {
  if ((await right.type(key)) !== type) return false;
  if (type === "string") {
    const [leftValue, rightValue] = await Promise.all([
      left.sendCommand<Buffer | null>(["GET", key], { returnBuffers: true }),
      right.sendCommand<Buffer | null>(["GET", key], { returnBuffers: true }),
    ]);
    return (
      leftValue !== null &&
      rightValue !== null &&
      Buffer.from(leftValue).equals(Buffer.from(rightValue))
    );
  }
  if (type === "list") {
    const [leftValues, rightValues] = await Promise.all([
      left.sendCommand<Buffer[]>(["LRANGE", key, "0", "-1"], {
        returnBuffers: true,
      }),
      right.sendCommand<Buffer[]>(["LRANGE", key, "0", "-1"], {
        returnBuffers: true,
      }),
    ]);
    return (
      leftValues.length === rightValues.length &&
      leftValues.every((value, index) =>
        Buffer.from(value).equals(Buffer.from(rightValues[index])),
      )
    );
  }
  return false;
};

let scanned = 0;
let overlaps = 0;
let restored = 0;
let skippedEqual = 0;
let expiredDuringRead = 0;
const typeCounts: Record<string, number> = {};
let verified = 0;
const verificationMismatches: string[] = [];
let cursor = "0";
let nextProgress = progressEvery;
const startedAt = Date.now();

try {
  await Promise.all(clients.map((client) => client.connect()));

  do {
    const reply = await source.sendCommand<[string, string[]]>([
      "SCAN",
      cursor,
      "COUNT",
      String(batchSize),
    ]);
    cursor = String(reply[0]);
    const keys = reply[1];
    scanned += keys.length;

    if (countTypes) {
      await concurrentMap(keys, concurrency, async (key) => {
        const type = await source.type(key);
        typeCounts[type] = (typeCounts[type] || 0) + 1;
      });
    }

    if (base) {
      await concurrentMap(keys, concurrency, async (key) => {
        if (await base.exists(key)) overlaps++;
      });
    }

    if (verifier) {
      await concurrentMap(keys, concurrency, async (key) => {
        const [sourceType, verifyType] = await Promise.all([
          source.type(key),
          verifier.type(key),
        ]);
        if (sourceType !== verifyType) {
          if (verificationMismatches.length < 20) {
            verificationMismatches.push(
              `${key}: type ${sourceType} != ${verifyType}`,
            );
          }
          return;
        }

        if (sourceType === "string") {
          const [sourceValue, verifyValue] = await Promise.all([
            source.sendCommand<Buffer | null>(["GET", key], {
              returnBuffers: true,
            }),
            verifier.sendCommand<Buffer | null>(["GET", key], {
              returnBuffers: true,
            }),
          ]);
          if (
            sourceValue === null ||
            verifyValue === null ||
            !Buffer.from(sourceValue).equals(Buffer.from(verifyValue))
          ) {
            if (verificationMismatches.length < 20) {
              verificationMismatches.push(`${key}: string value differs`);
            }
            return;
          }
        } else if (sourceType === "list") {
          const [sourceValues, verifyValues] = await Promise.all([
            source.sendCommand<Buffer[]>(["LRANGE", key, "0", "-1"], {
              returnBuffers: true,
            }),
            verifier.sendCommand<Buffer[]>(["LRANGE", key, "0", "-1"], {
              returnBuffers: true,
            }),
          ]);
          if (
            sourceValues.length !== verifyValues.length ||
            sourceValues.some(
              (value, index) =>
                !Buffer.from(value).equals(Buffer.from(verifyValues[index])),
            )
          ) {
            if (verificationMismatches.length < 20) {
              verificationMismatches.push(`${key}: list value differs`);
            }
            return;
          }
        } else {
          if (verificationMismatches.length < 20) {
            verificationMismatches.push(
              `${key}: verification unsupported for ${sourceType}`,
            );
          }
          return;
        }
        verified++;
      });
    }

    if (apply && target) {
      await concurrentMap(keys, concurrency, async (key) => {
        const [type, ttlRaw] = await Promise.all([
          source.type(key),
          source.sendCommand<string>(["PTTL", key]),
        ]);
        const ttl = Number(ttlRaw);
        if (type === "none" || ttl === -2) {
          expiredDuringRead++;
          return;
        }

        if (skipEqual && (await valuesMatch(source, target, key, type))) {
          const targetTtl = await target.pTTL(key);
          const ttlMatches =
            (ttl === -1 && targetTtl === -1) ||
            (ttl > 0 && targetTtl > 0 && Math.abs(ttl - targetTtl) < 10_000);
          if (ttlMatches) {
            skippedEqual++;
            return;
          }
        }

        if (type === "string") {
          const value = await source.sendCommand<Buffer | null>(["GET", key], {
            returnBuffers: true,
          });
          if (value === null) {
            expiredDuringRead++;
            return;
          }
          await target.sendCommand(["SET", key, value]);
        } else if (type === "list") {
          await target.del(key);
          let offset = 0;
          while (true) {
            const values = await source.sendCommand<Buffer[]>(
              ["LRANGE", key, String(offset), String(offset + batchSize - 1)],
              { returnBuffers: true },
            );
            if (!values.length) break;
            await target.sendCommand(["RPUSH", key, ...values]);
            offset += values.length;
            if (values.length < batchSize) break;
          }
        } else {
          throw new Error(`Unsupported source type ${type} for key ${key}`);
        }

        if (ttl > 0) await target.pExpire(key, ttl);
        restored++;
      });
    }

    if (scanned >= nextProgress) {
      console.error(
        JSON.stringify({
          scanned,
          overlaps,
          restored,
          skippedEqual,
          cursor,
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        }),
      );
      nextProgress += progressEvery;
    }
  } while (cursor !== "0");

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "audit",
        sourceUrl,
        baseUrl: baseUrl || null,
        targetUrl: targetUrl || null,
        sourceKeysScanned: scanned,
        overlappingBaseKeys: base ? overlaps : null,
        sourceOnlyKeys: base ? scanned - overlaps : null,
        restored: apply ? restored : null,
        skippedEqual: apply ? skippedEqual : null,
        expiredDuringRead,
        typeCounts: countTypes ? typeCounts : null,
        verifyUrl: verifyUrl || null,
        verified: verifier ? verified : null,
        verificationMismatches: verifier ? verificationMismatches : null,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      },
      null,
      2,
    ),
  );
  if (verificationMismatches.length) process.exitCode = 1;
} finally {
  await Promise.all(
    clients.map(async (client) => {
      if (client.isOpen) await client.quit();
    }),
  );
}
