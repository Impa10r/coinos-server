# Send-only Postfix relay. The app talks to this on the compose network and
# never handles credentials, a tunnel, or a queue — it just hands a message to
# mail:25 and this forwards everything to the real mail server on the VPS.
#
# Built from the Alpine base + the distro postfix package rather than a
# third-party relay image, matching tor.Dockerfile: this carries account
# verification and withdrawal-breaker alerts, so the supply chain is worth
# keeping to base-distro packages.
#
# It is a NULL CLIENT: no local mailboxes, no inbound delivery, no user
# accounts. It accepts from the compose network and relays out. Nothing here
# should ever be reachable from the public internet — see the compose entry,
# which publishes no ports.
FROM alpine:3.22

RUN apk update && apk upgrade && apk add --no-cache postfix

# RELAYHOST is the VPS over WireGuard. Kept as a build arg with a default so
# the address lives in compose rather than being baked in.
ARG RELAYHOST="[10.9.0.11]:587"
ARG MYHOSTNAME="coinos-relay"

RUN postconf -e "myhostname = ${MYHOSTNAME}" \
 && postconf -e "relayhost = ${RELAYHOST}" \
 # Accept only from loopback and private ranges — the compose network and the
 # WireGuard subnet. A relay that accepts from anywhere is an open relay, and
 # open relays are found and abused within days.
 && postconf -e "mynetworks = 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16" \
 && postconf -e "inet_interfaces = all" \
 # IPv4 only. Google rejects rather than spam-folders IPv6 mail that misses any
 # authentication detail, and there is no reason to take that risk on the hop
 # to our own VPS.
 && postconf -e "inet_protocols = ipv4" \
 # No local delivery: there are no mailboxes here, and a misrouted message
 # should bounce loudly rather than vanish into a container filesystem.
 && postconf -e "mydestination =" \
 && postconf -e "local_transport = error: local delivery is disabled" \
 # The hop to the VPS runs inside WireGuard, so it is already encrypted;
 # opportunistic TLS on top costs nothing and covers a misconfigured tunnel.
 && postconf -e "smtp_tls_security_level = may" \
 # Log to stdout so `docker logs mail` works like every other service here.
 && postconf -e "maillog_file = /dev/stdout" \
 && newaliases

EXPOSE 25

# start-fg keeps postfix in the foreground so docker supervises it directly.
ENTRYPOINT ["postfix", "start-fg"]
