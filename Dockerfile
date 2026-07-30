# The whole pipeline runs in the browser, so the server only has to hand out
# static files over HTTPS. There is no application code in this image at all.

FROM node:22-alpine AS build

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build


FROM nginx:1.27-alpine

# openssl for the self-signed certificate generated on first start.
RUN apk add --no-cache openssl

COPY --from=build /build/dist /usr/share/nginx/html
COPY docker/nginx.conf.template /etc/nginx/nginx.conf.template
# The base image runs everything in this directory before starting nginx.
COPY docker/20-make-cert.sh /docker-entrypoint.d/20-make-cert.sh
RUN chmod +x /docker-entrypoint.d/20-make-cert.sh \
    && rm -f /etc/nginx/conf.d/default.conf

# Hosts the certificate should be valid for. Browsers match on subjectAltName,
# so add whatever name you actually reach this by.
ENV CERT_HOSTS=localhost,127.0.0.1,::1 \
    HTTPS_PORT=8443

VOLUME ["/etc/nginx/certs"]
EXPOSE 8080 8443
