#!/usr/bin/env bash
# Local Postgres cluster without Docker.
#
# Useful when a Docker daemon is unavailable (CI sandboxes, restricted laptops).
# Requires the postgresql server binaries to be installed, for example
#   sudo apt-get install -y postgresql-16
#
# Usage: scripts/pg-dev.sh {start|stop|status|psql|reset}
set -euo pipefail

PG_VERSION="${PG_VERSION:-16}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/${PG_VERSION}/bin}"
PG_PORT="${PG_PORT:-55432}"
PG_DATA="${PG_DATA:-$(cd "$(dirname "$0")/.." && pwd)/.pgdata/data}"
# The unix socket path has a hard 107 byte limit, so it never lives under the project tree.
PG_SOCKET_DIR="${PG_SOCKET_DIR:-/tmp/pg-digital-shop}"
PG_LOG="$(dirname "$PG_DATA")/postgres.log"
DB_NAME="${DB_NAME:-digital_shop}"

if [ ! -x "${PG_BIN}/initdb" ]; then
  echo "Postgres binaries not found at ${PG_BIN}. Set PG_BIN or install postgresql-${PG_VERSION}." >&2
  exit 1
fi

# initdb and postgres refuse to run as root, so when invoked as root we drop to
# the unprivileged postgres system user.
RUNNER=""
if [ "$(id -u)" -eq 0 ]; then
  if ! id postgres >/dev/null 2>&1; then
    echo "Running as root but no 'postgres' user exists. Run this script as a normal user." >&2
    exit 1
  fi
  RUNNER="postgres"
fi

run_pg() {
  if [ -n "$RUNNER" ]; then
    su "$RUNNER" -c "$*"
  else
    bash -c "$*"
  fi
}

prepare_dirs() {
  mkdir -p "$(dirname "$PG_DATA")" "$PG_SOCKET_DIR"
  if [ -n "$RUNNER" ]; then
    chown -R "$RUNNER" "$(dirname "$PG_DATA")" "$PG_SOCKET_DIR"
  fi
}

start() {
  prepare_dirs
  if [ ! -f "${PG_DATA}/PG_VERSION" ]; then
    echo "Initialising cluster at ${PG_DATA}"
    run_pg "${PG_BIN}/initdb -D '${PG_DATA}' -U postgres --auth=trust -E UTF8" >/dev/null
  fi
  if "${PG_BIN}/pg_isready" -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; then
    echo "Postgres already running on port ${PG_PORT}"
  else
    run_pg "${PG_BIN}/pg_ctl -D '${PG_DATA}' -o '-p ${PG_PORT} -k ${PG_SOCKET_DIR}' -l '${PG_LOG}' start" >/dev/null
    for _ in $(seq 1 30); do
      "${PG_BIN}/pg_isready" -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1 && break
      sleep 0.5
    done
  fi
  "${PG_BIN}/psql" -h 127.0.0.1 -p "$PG_PORT" -U postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 ||
    "${PG_BIN}/createdb" -h 127.0.0.1 -p "$PG_PORT" -U postgres "$DB_NAME"
  echo "Ready: postgres://postgres@127.0.0.1:${PG_PORT}/${DB_NAME}"
}

case "${1:-start}" in
  start) start ;;
  stop) run_pg "${PG_BIN}/pg_ctl -D '${PG_DATA}' stop -m fast" >/dev/null && echo "stopped" ;;
  status) "${PG_BIN}/pg_isready" -h 127.0.0.1 -p "$PG_PORT" ;;
  psql) "${PG_BIN}/psql" -h 127.0.0.1 -p "$PG_PORT" -U postgres -d "$DB_NAME" ;;
  reset)
    "${PG_BIN}/dropdb" -h 127.0.0.1 -p "$PG_PORT" -U postgres --if-exists "$DB_NAME"
    "${PG_BIN}/createdb" -h 127.0.0.1 -p "$PG_PORT" -U postgres "$DB_NAME"
    echo "database ${DB_NAME} recreated"
    ;;
  *)
    echo "Usage: $0 {start|stop|status|psql|reset}" >&2
    exit 1
    ;;
esac
