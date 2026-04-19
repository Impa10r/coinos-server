import config from "$config";
import { l, warn } from "$lib/logging";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { Relay } from "nostr-tools/relay";

export const announceFips = async () => {
  try {
    const sk = nip19.decode(config.nostrKeyFips).data as unknown as Uint8Array;
    const pubkey = getPublicKey(sk);

    const created_at = Math.floor(Date.now() / 1000);
    const expiration = created_at + 7200;

    const content = JSON.stringify({
      identifier: "fips-overlay-v1",
      version: 1,
      endpoints: [{ transport: "udp", addr: `${config.domain}:2121` }],
      signalRelays: [config.publicRelay],
    });

    const ev = finalizeEvent(
      {
        kind: 30078,
        created_at,
        content,
        tags: [
          ["d", "fips-overlay-v1"],
          ["protocol", "fips-overlay-v1"],
          ["version", "1"],
          ["expiration", String(expiration)],
        ],
      },
      sk,
    );

    const npub = nip19.npubEncode(pubkey);
    l(`announcing FIPS overlay as ${npub}`);

    await Promise.all(
      config.relays.map(async (url) => {
        try {
          const r = await Relay.connect(url);
          await r.publish(ev);
          setTimeout(() => r.close(), 1000);
        } catch (e: any) {
          warn(`fips announce failed on ${url}`, e.message);
        }
      }),
    );
  } catch (e: any) {
    warn("fips announce error", e.message);
  }
};
