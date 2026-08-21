#!/usr/bin/env bash
#
# Proves the assembled stack actually works (roadmap Session 41, definition of
# done). Run against a stack that is already up:
#
#   PLANTOPS_VERSION=1.2.3 PLATFORM_BOOTSTRAP_SECRET=… \
#     deploy/stack-smoke.sh http://127.0.0.1:8080
#
# Everything below goes through the proxy's published port and nothing else —
# no `docker exec`, no direct connection to a service. That restriction is the
# test: if a check here can only pass by reaching around the front door, the
# stack does not work the way a client would use it.
#
# Four properties, each an acceptance criterion of the session:
#
#   1. The console is served at `/`, and the API at `/api` with the prefix
#      stripped — Session 40's same-origin default has something behind it.
#   2. `/health` reports the version that was built into the image. CI compares
#      it against the tag it pushed, which is what makes the stamp trustworthy.
#   3. The same image digest serves two different hostnames, and a real login
#      succeeds through both. Nothing customer-specific is baked in.
#   4. The proxy **replaces** `X-Forwarded-For`. Tested by consequence rather
#      than by reading the config: a burst of login attempts, each carrying a
#      different forged client address, must land in one rate-limit bucket. If
#      the header were passed through, every caller would pick their own bucket,
#      which is the same as having no IP rate limiting at all.
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8080}"
EXPECTED_VERSION="${PLANTOPS_VERSION:-dev}"
BOOTSTRAP_SECRET="${PLATFORM_BOOTSTRAP_SECRET:?PLATFORM_BOOTSTRAP_SECRET is required to log in}"

# The identity migration 0011 seeds. It is a service account rather than a user
# because the first platform admin cannot be created through an API that would
# need that admin to authorize the call (Doc 07 §8).
readonly BOOTSTRAP_ACCOUNT_KEY='platform-bootstrap'

# Two hostnames that resolve to nothing. That is deliberate — they are sent as
# `Host` headers against the same address, so the only thing under test is
# whether the stack cares what it is called. It must not.
readonly HOST_A='plant-a.example'
readonly HOST_B='plant-b.internal'

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; exit 1; }
step() { printf '\n%s\n' "$1"; }

# ── Wait for the stack ───────────────────────────────────────────────────────
#
# `/api/ready`, not `/api/health`: liveness answers 200 the moment the process
# is up, which on a cold stack is well before Postgres will accept a query.
# Readiness is the endpoint that says the dependencies answered (Doc 06 §13),
# so it is the only honest thing to wait on.
step "Waiting for ${BASE_URL}/api/ready"
deadline=$(( $(date +%s) + 180 ))
until [ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/ready" || true)" = '200' ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    fail "the stack did not become ready within 180s (last body: $(curl -s "${BASE_URL}/api/ready" || echo 'no response'))"
  fi
  sleep 3
done
pass "ready"

# ── 1. Routing ───────────────────────────────────────────────────────────────
step '1. The proxy serves the console at / and the API at /api'

status=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/login")
[ "$status" = '200' ] || fail "GET /login returned ${status}, expected 200 from the console"
pass "console answers at /login"

# The prefix must be *stripped*: the API has no global prefix and serves
# `/health` at its root (Doc 06 §1). A proxy that forwarded `/api/health`
# unchanged would get a 404 from the router here.
health=$(curl -s "${BASE_URL}/api/health")
case "$health" in
  *'"status":"ok"'*) pass "API answers at /api/health with the /api prefix stripped" ;;
  *) fail "GET /api/health returned: ${health}" ;;
esac

# ── 2. Version stamping ──────────────────────────────────────────────────────
step '2. The running container reports the version that was built into it'

reported=$(printf '%s' "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
[ -n "$reported" ] || fail "/api/health reported no version at all: ${health}"
[ "$reported" = "$EXPECTED_VERSION" ] || \
  fail "/api/health reports '${reported}' but the image was built and tagged '${EXPECTED_VERSION}'"
pass "reported version '${reported}' matches the image tag"

# ── 3. One image, any hostname ───────────────────────────────────────────────
step '3. The same images serve two different hostnames, and login works on both'

login_through() {
  local host="$1"
  curl -s -o /dev/null -w '%{http_code}' \
    -H "Host: ${host}" \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/api/auth/token" \
    --data "{\"account_key\":\"${BOOTSTRAP_ACCOUNT_KEY}\",\"account_secret\":\"${BOOTSTRAP_SECRET}\"}"
}

for host in "$HOST_A" "$HOST_B"; do
  status=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${host}" "${BASE_URL}/login")
  [ "$status" = '200' ] || fail "the console returned ${status} for Host: ${host}"

  status=$(login_through "$host")
  [ "$status" = '200' ] || \
    fail "login through Host: ${host} returned ${status} — a hostname-specific value is baked in somewhere"
  pass "console and login both work as ${host}"
done

# One more time, keeping the body, so the failure mode "200 with no token" is
# not mistaken for success.
token_body=$(curl -s -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/auth/token" \
  --data "{\"account_key\":\"${BOOTSTRAP_ACCOUNT_KEY}\",\"account_secret\":\"${BOOTSTRAP_SECRET}\"}")
case "$token_body" in
  *'"access_token"'*) pass "the exchange returned an access token" ;;
  *) fail "no access_token in the response: ${token_body}" ;;
esac

# ── 4. X-Forwarded-For is replaced, not appended ─────────────────────────────
step '4. Forged X-Forwarded-For values all land in one rate-limit bucket'

# `POST /auth/login` carries a limit of 10 per minute per caller
# (`auth.controller.ts`), so attempts from one bucket must eventually 429.
# The credentials are deliberately nonsense against a client that does not
# exist: the throttle runs in a guard, before validation and before any handler,
# so a rejected attempt is counted like any other — and nothing real is locked
# out by it (Doc 03 §8 counts failures per account, and there is no account).
#
# Twenty-five rather than eleven, because the window is a *fixed* one aligned to
# the clock (`common/throttler.guard.ts`). A run that straddles a boundary
# splits its attempts between two counters, and a dozen split six-six clears
# neither — which is a flaky test rather than a wrong proxy. Twenty-five puts
# more than the limit on one side of any boundary.
saw_429=0
for i in $(seq 1 25); do
  status=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "X-Forwarded-For: 203.0.113.${i}" \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/api/auth/login" \
    --data '{"client_slug":"no-such-client","email":"nobody@example.com","password":"not-a-real-password"}')
  if [ "$status" = '429' ]; then
    saw_429=1
    break
  fi
done

[ "$saw_429" = '1' ] || fail \
  "twenty-five attempts with twenty-five different X-Forwarded-For values were never throttled — the proxy is forwarding the caller's header instead of replacing it, and every caller can choose its own rate-limit bucket"
pass "throttled — the client's X-Forwarded-For is not believed"

printf '\nAll stack smoke checks passed against %s (version %s).\n' "$BASE_URL" "$EXPECTED_VERSION"
