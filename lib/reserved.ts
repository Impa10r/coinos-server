import config from "$config";

// Usernames that carry authority, and so must never be claimable.
//
// Several checks in this codebase authorize by username string rather than by
// uid or a role flag:
//
//   routes/ecash.ts    melt() refuses anyone whose username isn't "mint" —
//                      that endpoint debits an account and books a lightning
//                      payment, so the name IS the credential
//   routes/payments.ts a send to an invoice owned by "mint" is routed out over
//                      lightning instead of being settled internally
//   lib/nwc.ts         same special case, twice
//   routes/users.ts    the admin password-reset endpoint compares against
//                      config.admin; the mqtt ACL against config.mqtt2.username
//
// Until now the only thing standing between an attacker and that authority was
// the account already existing — nothing stopped someone registering the name
// if it were ever deleted, or renaming into it in the gap. Production logs show
// this being attempted directly: a registration for "mint", then a rename of
// "min" to "mint", from an account also called "victim" and "mintundefind".
//
// Reserving a name does not affect the account that already holds it; it only
// blocks new registrations and renames INTO it.
//
// The proper fix is to authorize on uid or an explicit role rather than on a
// mutable display name. This closes the immediate hole without that surgery.
const RESERVED = [
  "ecash",
  "mint",
  "admin",
  "coinos",
  "support",
  "system",
];

export const isReserved = (username?: string): boolean => {
  if (!username) return false;
  const name = username.replace(/\s/g, "").toLowerCase();

  // Configured privileged identities, resolved at call time so a config change
  // doesn't need a rebuild to take effect.
  const configured = [(config as any).admin, (config as any).mqtt2?.username]
    .filter(Boolean)
    .map((u: string) => String(u).replace(/\s/g, "").toLowerCase());

  return RESERVED.includes(name) || configured.includes(name);
};
