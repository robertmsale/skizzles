#!/bin/sh
set -eu

: "${CODEX_AGGREGATOR_REPO_URL:?CODEX_AGGREGATOR_REPO_URL is required}"

workspace="${CODEX_AGGREGATOR_WORKSPACE:-/workspace/repo}"
mkdir -p "$CODEX_HOME" "$(dirname "$workspace")"

if [ -d /codex-home-seed ]; then
  cp -R /codex-home-seed/. "$CODEX_HOME"/
fi

if [ -f "$CODEX_HOME/config.toml" ]; then
  container_host="${CODEX_AGGREGATOR_CONTAINER_HOST:-host.docker.internal}"
  sed "s/{{SKIZZLES_CONTAINER_HOST}}/$container_host/g" "$CODEX_HOME/config.toml" > "$CODEX_HOME/config.toml.tmp"
  mv "$CODEX_HOME/config.toml.tmp" "$CODEX_HOME/config.toml"
fi

git clone -- "$CODEX_AGGREGATOR_REPO_URL" "$workspace"
if [ -n "${CODEX_AGGREGATOR_REPO_REF:-}" ]; then
  git -C "$workspace" fetch --depth=1 origin "$CODEX_AGGREGATOR_REPO_REF"
  git -C "$workspace" checkout --detach FETCH_HEAD
fi

if [ -n "${CODEX_AGGREGATOR_PROVIDER_COMMAND:-}" ]; then
  sh -lc "$CODEX_AGGREGATOR_PROVIDER_COMMAND" >&2 &
fi

if [ -n "${CODEX_AGGREGATOR_PROVIDER_READY_URL:-}" ]; then
  attempt=0
  until curl --fail --silent "$CODEX_AGGREGATOR_PROVIDER_READY_URL" >/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
      echo "provider did not become ready: $CODEX_AGGREGATOR_PROVIDER_READY_URL" >&2
      exit 1
    fi
    sleep 1
  done
fi

cd "$workspace"
printf '%s\n' '__SKIZZLES_CODEX_APP_SERVER_READY__'
exec codex --config "projects={\"$workspace\"={trust_level=\"trusted\"}}" app-server --stdio
