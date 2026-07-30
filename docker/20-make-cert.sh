#!/bin/sh
# Generate a self-signed certificate on first start and render the nginx config.
#
# The certificate lives in a volume so it survives restarts -- regenerating it
# every time would make every browser demand the security exception again.
set -e

CERT_DIR=/etc/nginx/certs
CERT_HOSTS="${CERT_HOSTS:-localhost,127.0.0.1,::1}"
HTTPS_PORT="${HTTPS_PORT:-8443}"

# Behind a reverse proxy (Traefik with a real certificate), this container
# speaks plain HTTP and the self-signed machinery below is dead weight: render
# the proxy-mode config and stop.
if [ "${BEHIND_PROXY:-}" = "true" ]; then
    echo "make-chatsounds: BEHIND_PROXY=true, serving plain HTTP on 8080"
    sed -e "s|__GITHUB_CLIENT_ID__|${GITHUB_CLIENT_ID:-}|g" \
        /etc/nginx/nginx-proxy.conf.template > /etc/nginx/conf.d/default.conf
    exit 0
fi

mkdir -p "$CERT_DIR"

if [ ! -f "$CERT_DIR/cert.pem" ] || [ ! -f "$CERT_DIR/key.pem" ]; then
    # Modern browsers ignore the Common Name entirely and match on
    # subjectAltName, so every host you intend to reach this by has to be listed
    # there or the certificate is rejected outright rather than just distrusted.
    SANS=""
    PRIMARY=""
    OLD_IFS="$IFS"
    IFS=','
    for host in $CERT_HOSTS; do
        host=$(echo "$host" | tr -d '[:space:]')
        [ -z "$host" ] && continue
        [ -z "$PRIMARY" ] && PRIMARY="$host"
        # Anything that is only hex digits, dots and colons is an address.
        if echo "$host" | grep -qE '^[0-9a-fA-F.:]+$' && echo "$host" | grep -qE '[.:]'; then
            SANS="${SANS},IP:${host}"
        else
            SANS="${SANS},DNS:${host}"
        fi
    done
    IFS="$OLD_IFS"
    SANS=$(echo "$SANS" | sed 's/^,//')
    [ -z "$PRIMARY" ] && PRIMARY=localhost

    echo "make-chatsounds: generating a self-signed certificate for ${SANS}"
    openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
        -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
        -subj "/CN=${PRIMARY}" \
        -addext "subjectAltName=${SANS}" \
        -addext "basicConstraints=critical,CA:FALSE" \
        -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
        -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
    chmod 600 "$CERT_DIR/key.pem"
else
    echo "make-chatsounds: reusing the certificate in $CERT_DIR"
fi

# Substituted by hand rather than with envsubst, which would also eat nginx's own
# $host and $request_uri.
sed -e "s|__HTTPS_PORT__|${HTTPS_PORT}|g" \
    -e "s|__GITHUB_CLIENT_ID__|${GITHUB_CLIENT_ID:-}|g" \
    /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf
