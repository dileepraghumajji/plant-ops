# syntax=docker/dockerfile:1.7
#
# The bundled reverse proxy (roadmap Session 41, Doc 11 §5.3).
#
# One origin in front of the whole stack: the console at `/`, the API at `/api`
# with the prefix stripped. That is what makes Session 40's same-origin default
# real — until something serves `/api`, a console built with no
# `NEXT_PUBLIC_IAM_API_URL` has nowhere to send a request.
#
# `nginx.conf` carries the reasoning for every routing decision; this file is
# only the packaging. Build from the **repository root**:
#
#   docker build -f deploy/proxy/Dockerfile -t plantops/proxy:dev .

# Alpine here, unlike the two Node images. The argument that keeps those on
# Debian — `@node-rs/argon2`'s prebuilt glibc bindings — has no counterpart in a
# proxy that runs no native addon of ours, and nginx's own musl build is one of
# the most heavily exercised images in existence.
#
# Digest-pinned for the reason the other two are: an artifact a client
# reproduces months from now must not depend on what a tag pointed at this week
# (Doc 11 §5.3 — "digest-pinned").
ARG NGINX_IMAGE=nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de

FROM ${NGINX_IMAGE}

ARG APP_VERSION=0.0.0-dev

LABEL org.opencontainers.image.title="plantops-proxy" \
      org.opencontainers.image.description="PlantOps single-origin reverse proxy — console at /, API at /api" \
      org.opencontainers.image.source="https://github.com/dileepraghumajji/plant-ops" \
      org.opencontainers.image.version="${APP_VERSION}"

# Replaces the stock welcome-page server block. The stock `/etc/nginx/nginx.conf`
# is left in place deliberately — it is what includes `conf.d/*.conf` and what
# the image's entrypoint scripts expect to find.
COPY deploy/proxy/nginx.conf /etc/nginx/conf.d/default.conf

# Outside `conf.d/` on purpose: this is an `include` used *inside* two location
# blocks, and anything under `conf.d/` is also included at `http` level by the
# stock config, where `proxy_set_header` would be a duplicate rather than an
# error you notice.
COPY deploy/proxy/proxy-headers.conf /etc/nginx/proxy-headers.conf

# Runs before nginx starts (the official image executes `/docker-entrypoint.d/*`
# in name order), and writes `conf.d/real-ip.conf` from `TRUSTED_PROXY_CIDRS`.
# 40- so it lands after the stock 10-/15-/20-/30- scripts.
COPY --chmod=0755 deploy/proxy/40-real-ip.sh /docker-entrypoint.d/40-real-ip.sh

EXPOSE 80

# The proxy's own front door, not the stack's readiness. A failing container
# healthcheck restarts the container, so it must not depend on an upstream: a
# thirty-second `iam-api` restart would otherwise take the proxy down with it
# and turn one service's blip into an outage of both. `/api/ready` is what a
# load balancer or an operator polls to ask whether the stack can serve.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --spider --tries=1 http://127.0.0.1/healthz || exit 1

# No CMD: the base image's entrypoint and `nginx -g 'daemon off;'` are correct
# as they stand, and restating them here would be one more thing to keep in step
# with an upstream that occasionally changes them.
