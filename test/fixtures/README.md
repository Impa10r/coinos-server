Throwaway self-signed certificate for `test/webhook-tls.test.ts`.

It exists so a test can stand up an HTTPS server that a correctly configured
client must REFUSE. It is not a credential, it secures nothing, and it is not
used outside that test. `CN=localhost`, 10-year validity so the test does not
rot. Regenerate with:

    openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
      -days 3650 -nodes -subj "/CN=localhost"
