# The pipeline runs in the browser, so the server is almost entirely a static
# file host. The one exception is mp4d: Discord plays no audio link, only an
# og:video MP4, so a shared sound has to be transcoded somewhere, and it cannot
# be in the browser that shares it or the crawler that reads it. See
# docker/mp4d.mjs.

FROM node:22-alpine AS build

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build


FROM nginx:1.27-alpine

# openssl for the self-signed certificate generated on first start; ffmpeg and
# nodejs for mp4d, which turns one sound into the MP4 Discord will play.
RUN apk add --no-cache openssl ffmpeg nodejs

COPY --from=build /build/dist /usr/share/nginx/html

# The still frame every shared sound plays under. Squared and scaled here so the
# transcode at request time is only ever audio work. Nearest-neighbour because
# the source is pixel art and anything smoother turns it to mush; the crop takes
# the shorter side, so a source that is not quite square loses a row rather than
# stretching.
COPY docker/mp4d.mjs /opt/chatsounds/mp4d.mjs
COPY docker/share-cover.png /opt/chatsounds/cover-source.png
RUN ffmpeg -hide_banner -loglevel error -y -i /opt/chatsounds/cover-source.png \
        -vf "crop='min(iw,ih)':'min(iw,ih)',scale=480:480:flags=neighbor" \
        /opt/chatsounds/cover.png \
    && rm /opt/chatsounds/cover-source.png
# Two shapes: standalone, which makes its own certificate and speaks HTTPS, and
# BEHIND_PROXY, which speaks plain HTTP because something in front of it holds a
# real certificate. The entrypoint picks one.
COPY docker/nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker/nginx-proxy.conf.template /etc/nginx/nginx-proxy.conf.template
# The base image runs everything in this directory before starting nginx.
COPY docker/20-make-cert.sh /docker-entrypoint.d/20-make-cert.sh
COPY docker/30-start-mp4d.sh /docker-entrypoint.d/30-start-mp4d.sh
RUN chmod +x /docker-entrypoint.d/20-make-cert.sh /docker-entrypoint.d/30-start-mp4d.sh \
    && rm -f /etc/nginx/conf.d/default.conf

# Hosts the certificate should be valid for. Browsers match on subjectAltName,
# so add whatever name you actually reach this by.
ENV CERT_HOSTS=localhost,127.0.0.1,::1 \
    HTTPS_PORT=8443

# The certificate survives restarts; the transcoded MP4s are worth keeping too,
# since rebuilding one costs a fetch and an encode.
VOLUME ["/etc/nginx/certs", "/var/cache/chatsounds-mp4"]
EXPOSE 8080 8443
