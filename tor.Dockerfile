# Minimal Tor SOCKS5 client proxy for outbound onion routing (esplora's
# rate-limited clearnet API has an onion mirror — see lib/esplora.ts).
# Built from the official Alpine base + the standard `tor` package rather
# than a third-party proxy image, since this sits in the payment-request
# path and the supply chain is worth keeping to base-distro packages.
FROM alpine:3.22

RUN apk update && apk upgrade && apk add --no-cache tor

# Client only — no relay/exit function, since no ORPort is configured (that's
# Tor's default). SocksPort must bind beyond loopback to be reachable from
# other containers on the compose network.
RUN printf 'SocksPort 0.0.0.0:9050\nSocksPolicy accept *\n' > /etc/tor/torrc

EXPOSE 9050

ENTRYPOINT ["tor", "-f", "/etc/tor/torrc"]
