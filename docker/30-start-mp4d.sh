#!/bin/sh
# Start mp4d, which builds the MP4 a shared sound is embedded as.
#
# The base image runs everything in /docker-entrypoint.d before exec'ing nginx,
# so this backgrounds the process and returns. The loop is the whole supervisor:
# nothing else in this container would notice mp4d dying, and the cost of it
# staying dead is that every share link stops embedding until someone restarts
# the container. nginx keeps serving cached MP4s off the volume either way.
set -e

CACHE_DIR="${MP4D_CACHE:-/var/cache/chatsounds-mp4}"
mkdir -p "$CACHE_DIR/mp4"

echo "make-chatsounds: starting mp4d on 127.0.0.1:${MP4D_PORT:-8081}"
(
    while true; do
        node /opt/chatsounds/mp4d.mjs || echo "make-chatsounds: mp4d exited $?, restarting"
        sleep 2
    done
) &
