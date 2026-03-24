import config from "$config";
import fs from "fs";

const lndConfig = (config as any).lnd;

function makeLndClient() {
  if (!lndConfig?.url) return null;

  const macaroon = fs.readFileSync(lndConfig.macaroon).toString("hex");
  const tlsCert = fs.readFileSync(lndConfig.tlsCert);
  const baseUrl = lndConfig.url;

  const headers = {
    "Grpc-Metadata-macaroon": macaroon,
    "Content-Type": "application/json",
  };

  async function request(method: string, path: string, body?: any) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      // @ts-ignore
      tls: { ca: tlsCert },
    });
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      if (json.error || json.code) throw new Error(json.message || json.error);
      return json.result ?? json;
    } catch (e: any) {
      if (e.message) throw e;
      throw new Error(text);
    }
  }

  return {
    async decode(bolt11: string) {
      const r = await request("GET", `/v1/payreq/${bolt11}`);
      return {
        type: "bolt11",
        amount_msat: r.num_msat ? parseInt(r.num_msat) : undefined,
        invoice_node_id: r.destination,
        payee: r.destination,
      };
    },

    async listpeerchannels() {
      const r = await request("GET", "/v1/channels");
      const channels = (r.channels || []).map((c: any) => ({
        peer_id: c.remote_pubkey,
        spendable_msat: parseInt(c.local_balance) * 1000,
      }));
      return { channels };
    },

    async listpays(bolt11: string) {
      const r = await request("GET", `/v1/payments?include_incomplete=true&max_payments=50`);
      const pays = (r.payments || [])
        .filter((p: any) => p.payment_request === bolt11)
        .map((p: any) => ({
          status: p.status === "SUCCEEDED" ? "complete" : p.status === "IN_FLIGHT" ? "pending" : "failed",
          amount_sent_msat: parseInt(p.value_msat) + parseInt(p.fee_msat),
          preimage: p.payment_preimage,
        }));
      return { pays };
    },

    async xpay({ invstring, amount_msat, maxfee, retry_for }: {
      invstring: string;
      amount_msat?: number;
      maxfee: number;
      retry_for: number;
    }) {
      const body: any = {
        payment_request: invstring,
        fee_limit_msat: String(maxfee),
        timeout_seconds: retry_for,
        no_inflight_updates: true,
      };

      if (amount_msat) body.amt_msat = String(amount_msat);

      const r = await request("POST", "/v2/router/send", body);

      if (r.status === "FAILED") {
        const lastHtlc = r.htlcs?.[r.htlcs.length - 1];
        const detail = lastHtlc?.failure ? `${lastHtlc.failure.code} @hop${lastHtlc.failure.failure_source_index}` : "";
        throw new Error(`${r.failure_reason} ${detail}`.trim());
      }

      return {
        preimage: r.payment_preimage,
        amount_sent_msat: parseInt(r.value_msat) + parseInt(r.fee_msat),
      };
    },

    async keysend({ destination, amount_msat, maxfee, retry_for, extratlvs }: any) {
      const body: any = {
        dest: Buffer.from(destination, "hex").toString("base64"),
        amt_msat: String(amount_msat),
        fee_limit_msat: String(maxfee),
        timeout_seconds: retry_for,
        dest_custom_records: extratlvs,
      };

      const r = await request("POST", "/v2/router/sendtoroute", body);
      if (r.failure) throw new Error(r.failure.reason || "keysend failed");
      return { preimage: r.preimage };
    },

    async getinfo() {
      const r = await request("GET", "/v1/getinfo");
      return { id: r.identity_pubkey };
    },

    async getroutes({ source, destination, amount_msat }: any) {
      const r = await request("GET", `/v1/graph/routes/${destination}/${Math.ceil(amount_msat / 1000)}`);
      return { routes: r.routes || [] };
    },
  };
}

const lnd = makeLndClient();
export default lnd;
