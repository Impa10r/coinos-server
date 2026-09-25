import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
// @ts-ignore
import type { AuthenticatorTransportFuture } from "@simplewebauthn/types";
import config from "$config";
import { db, g, s } from "$lib/db";
import { fail } from "$lib/utils";
import { v4 } from "uuid";

const rpName = "coinos";
const androidOrigin = "android:apk-key-hash:DaYNHto1fsy7jrhOfRaDDy4HCRNqFo8H0gf3DmW7bOw";

// WebAuthn's whole value over a password is that the authenticator signs the
// origin and the RELYING PARTY verifies it against its OWN identity. The old
// code took the origin from the request body (routes/users.ts:
// `body.origin || https://${config.hostname}`) and used it as both the expected
// origin AND the source of the expected RPID — so the server verified each
// assertion against an origin the caller chose, which is no verification at all.
//
// It was worse in production than in principle: config.hostname is undefined
// (the domain is config.domain), so the fallback was the literal string
// "https://undefined" and the server had no knowledge of its own origin to fall
// back to. Every real passkey ceremony had to be trusting body.origin.
//
// Pin both to server config. The RPID is the registrable domain (config.domain),
// which is also correct for the Android app: Android binds to the web domain via
// /assetlinks.json, so its RPID is the domain while its origin is the apk hash.
// The allowed origins are the domain's https origin, that apk origin, and any
// extra origins a deployment configures (config.passkeyOrigins) for dev hosts or
// app subdomains. Caller-supplied origin is ignored.
function rpID(): string {
  const d = (config as any).domain;
  if (!d) fail("passkeys not configured");
  return d;
}

function expectedOrigins(): string[] {
  const extra: string[] = (config as any).passkeyOrigins || [];
  return [`https://${rpID()}`, androidOrigin, ...extra];
}

export async function generatePasskeyRegistration(user: any) {
  const passkeys = user.passkeys || [];

  const options = await generateRegistrationOptions({
    rpName,
    rpID: rpID(),
    userName: user.username,
    userID: new TextEncoder().encode(user.id) as any,
    attestationType: "none",
    excludeCredentials: passkeys.map((p: any) => ({
      id: p.credentialID,
      transports: p.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
  });

  await db.set(`challenge:${user.id}`, options.challenge, { EX: 300 });

  return options;
}

export async function verifyPasskeyRegistration(user: any, response: any) {
  const expectedChallenge = await db.get(`challenge:${user.id}`);
  if (!expectedChallenge) fail("Challenge expired");

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: expectedChallenge as string,
    expectedOrigin: expectedOrigins(),
    expectedRPID: rpID(),
  });

  if (!verification.verified || !verification.registrationInfo) {
    fail("Passkey verification failed");
  }

  await db.del(`challenge:${user.id}`);

  const { credential } = verification.registrationInfo;

  const cred = {
    credentialID: credential.id,
    credentialPublicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: response.response.transports || [],
    createdAt: Date.now(),
  };

  await db.set(`passkey:${credential.id}`, user.id);

  return cred;
}

export async function generatePasskeyLogin() {
  const options = await generateAuthenticationOptions({
    rpID: rpID(),
    userVerification: "preferred",
  });

  const challengeId = v4();
  await db.set(`challenge:passkey:${challengeId}`, options.challenge, { EX: 300 });

  return { ...options, challengeId };
}

export async function verifyPasskeyLogin(response: any, challengeId: string) {
  const userId = await db.get(`passkey:${response.id}`);
  if (!userId) fail("Passkey not recognized");

  const user = await g(`user:${userId}`);
  if (!user) fail("User not found", 404);

  const passkeys = user.passkeys || [];
  const passkey = passkeys.find((p: any) => p.credentialID === response.id);
  if (!passkey) fail("Passkey not found", 404);

  const expectedChallenge = await db.get(`challenge:passkey:${challengeId}`);
  if (!expectedChallenge) fail("Challenge expired");

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: expectedChallenge as string,
    expectedOrigin: expectedOrigins(),
    expectedRPID: rpID(),
    requireUserVerification: false,
    credential: {
      id: passkey.credentialID,
      publicKey: Buffer.from(passkey.credentialPublicKey, "base64url") as any,
      counter: passkey.counter,
      transports: passkey.transports as AuthenticatorTransportFuture[],
    } as any,
  });

  if (!verification.verified) fail("Passkey authentication failed");

  await db.del(`challenge:passkey:${challengeId}`);

  passkey.counter = verification.authenticationInfo.newCounter;
  await s(`user:${user.id}`, user);

  return user;
}
