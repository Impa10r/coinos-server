import { g } from "$lib/db";
import { warn } from "$lib/logging";
import { bail } from "$lib/utils";
import { getHealthStatus } from "$lib/health";
import ln from "$lib/ln";
import { getDecodedToken } from "@cashu/cashu-ts";

export default {
  async health(c) {
    const status = getHealthStatus();
    const httpStatus = status.healthy ? 200 : 503;
    return c.json(status, httpStatus);
  },

  // Reports the node's own liquidity — channel balance, onchain wallet, ecash.
  // See index.ts: this is admin-gated, because that is exactly the number
  // someone probing for a drain wants to know.
  async balances(c) {
    try {
      const funds = await ln.listfunds();
      const lnchannel = parseInt(funds.channels.reduce((a, b) => a + b.channel_sat, 0));
      const lnwallet = parseInt(funds.outputs.reduce((a, b) => a + b.value, 0));

      // getDecodedToken() throws on anything that isn't a token — including
      // null, where cashu-ts calls .startsWith on it and produces the opaque
      // "null is not an object (evaluating 'n.startsWith')" seen in production.
      // The `cash` key is simply unset on an instance that has never held
      // ecash, which is a zero balance, not a failure.
      const token = await g("cash");
      let cash = 0;
      if (token) {
        try {
          cash = getDecodedToken(token).proofs.reduce((a, b) => a + b.amount, 0);
        } catch (e: any) {
          warn("balances: could not decode cash token", e.message);
        }
      }

      return c.json({ cash, lnchannel, lnwallet });
    } catch (e: any) {
      warn("balances failed", e.message);
      return bail(c, e.message);
    }
  },
};
