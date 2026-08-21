#!/bin/sh
#
# Optional: teach nginx which addresses in front of it may be believed.
#
# Runs from `/docker-entrypoint.d/` before nginx starts, and writes a config
# fragment that the stock `include /etc/nginx/conf.d/*.conf;` picks up.
#
# `TRUSTED_PROXY_CIDRS` is a comma-separated list of networks — the client's own
# load balancer, an ingress controller, whatever terminates TLS in front of this
# container. For each one, nginx's realip module is allowed to take the client
# address from the incoming `X-Forwarded-For`; `$remote_addr` is rewritten
# *before* `proxy-headers.conf` reads it, so the API still receives one address
# it can trust rather than a list a caller composed.
#
# Unset — the default, and the right one when this proxy is the outermost hop —
# the file is written empty and nothing is trusted. That is the safe direction
# to fail: an unset variable means IP-keyed limits bucket by the real peer, and
# a *wrong* one would mean any caller inside the named range can spoof an
# address. Deliberately not defaulted to the RFC1918 ranges for that reason:
# on a plant network, "10.0.0.0/8" is most of the plant.
set -eu

target=/etc/nginx/conf.d/real-ip.conf
: > "$target"

if [ -z "${TRUSTED_PROXY_CIDRS:-}" ]; then
  echo "$0: TRUSTED_PROXY_CIDRS unset — X-Forwarded-For from callers is ignored."
  exit 0
fi

printf '%s\n' "$TRUSTED_PROXY_CIDRS" | tr ',' '\n' | while read -r cidr; do
  trimmed=$(printf '%s' "$cidr" | tr -d '[:space:]')
  [ -n "$trimmed" ] || continue
  printf 'set_real_ip_from %s;\n' "$trimmed" >> "$target"
done

# Only meaningful once at least one network is trusted; an empty file would
# otherwise carry a directive that trusts nothing and reads as if it did.
if [ -s "$target" ]; then
  # `recursive on` walks the list right-to-left past every trusted hop, so a
  # chain of two known proxies still yields the original client rather than the
  # inner one.
  printf 'real_ip_header X-Forwarded-For;\nreal_ip_recursive on;\n' >> "$target"
  echo "$0: trusting X-Forwarded-For from: $TRUSTED_PROXY_CIDRS"
fi
