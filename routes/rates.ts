import { g, s } from "$lib/db";
import { err } from "$lib/logging";
import { rate } from "$lib/rates";
import got from "got";

let lastIrt = 0;

export default {
  async fx(c) {
    const { fx } = await g("fx");
    c.header("Cache-Control", "public, max-age=300");
    return c.json({ fx });
  },

  async last(c) {
    c.header("Cache-Control", "public, max-age=30");
    return c.json(rate || (await g("rate")));
  },

  async index(c) {
    const { date: _date, fx: _fx, ...rates } = await g("rates");

    if (Date.now() - lastIrt > 60000) {
      try {
        rates.IRT = (
          (await got("https://api.nobitex.ir/v2/orderbook/BTCIRT").json()) as any
        ).lastTradePrice;
        lastIrt = Date.now();
        await s("rates", { date: _date, fx: _fx, ...rates });
      } catch (e) {
        err("nobitex fetch failed", e.message);
      }
    }

    c.header("Cache-Control", "public, max-age=30");
    return c.json(rates);
  },
};
