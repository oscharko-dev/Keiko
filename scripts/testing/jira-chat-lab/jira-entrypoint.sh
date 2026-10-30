#!/bin/sh
set -eu
ATL_JDBC_PASSWORD="$(cat /run/secrets/database_password)"
export ATL_JDBC_PASSWORD
exec /entrypoint.py "$@"
