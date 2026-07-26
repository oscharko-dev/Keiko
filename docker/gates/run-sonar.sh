#!/usr/bin/env bash
# Runs a real SonarJS analysis of the working tree against a local, self-hosted SonarQube and prints
# the findings that land on files this branch changed. See docs/qa/local-sonar.md.
#
#   ./docker/gates/run-sonar.sh              # findings on files changed against origin/dev
#   ./docker/gates/run-sonar.sh --all        # every finding in the project
#   ./docker/gates/run-sonar.sh --base main  # diff against a different base
#
# Exit status is 1 when a finding lands on a changed file, so this is usable as a pre-push guard.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose=(docker compose -f "${repo_root}/docker/gates/sonar-compose.yml")
host="http://127.0.0.1:9234"
project="keiko-local"
scope="changed"
base="origin/dev"

while [[ $# -gt 0 ]]; do
  argument="$1"
  case "${argument}" in
    --all) scope="all" ;;
    --base)
      base="${2:?--base needs a ref}"
      shift
      ;;
    *)
      printf 'unknown argument: %s\n' "${argument}" >&2
      exit 2
      ;;
  esac
  shift
done

say() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

# No request to the local server may block forever: an unbounded call turns the readiness loop into
# a hang that never reaches its own failure path, and a pre-push gate that hangs is a gate nobody
# runs. Generous enough for a cold server, finite in every case.
curl_opts=(--connect-timeout 5 --max-time 120)
ask() { curl -fsS "${curl_opts[@]}" "$@"; }

say "Starting the local SonarQube (first run pulls the image and takes a few minutes)"
"${compose[@]}" up -d sonarqube

# Waiting from the host rather than with a container healthcheck: the SonarQube image carries no
# wget, curl, bash or python, so nothing inside it can probe its own port.
printf '  waiting for the server'
for _ in $(seq 1 120); do
  if [[ "$(ask "${host}/api/system/status" 2>/dev/null | sed -n 's/.*"status":"\([A-Z]*\)".*/\1/p')" == "UP" ]]; then
    printf ' up\n'
    break
  fi
  printf '.'
  sleep 5
done
if [[ "$(ask "${host}/api/system/status" 2>/dev/null | sed -n 's/.*"status":"\([A-Z]*\)".*/\1/p')" != "UP" ]]; then
  printf '\n\033[31m✘ SonarQube did not become ready at %s\033[0m\n' "${host}" >&2
  exit 1
fi

# SonarQube ships with admin/admin and refuses API use until that password is changed. The
# replacement is GENERATED, never written into this file: a credential in a tracked script is a
# credential regardless of how local the server is, and it would be copied into the next repository
# that borrows this lane. It lives in the git directory, which is untracked by construction.
say "Provisioning a local analysis token"
credentials="$(git -C "${repo_root}" rev-parse --absolute-git-dir)/keiko-local-sonar"
if [[ ! -f "${credentials}" ]]; then
  umask 077
  # Satisfies SonarQube's policy (upper, lower, digit, special) without ever being predictable.
  printf 'K%s-a1!\n' "$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)" > "${credentials}"
fi
password="$(cat "${credentials}")"

if [[ "$(ask -u "admin:${password}" "${host}/api/authentication/validate" 2>/dev/null)" == '{"valid":true}' ]]; then
  printf '  credentials already provisioned\n'
else
  # Not swallowed: a bootstrap that fails here resurfaces three steps later as an unexplained 401,
  # and the reader then debugs the wrong thing.
  if ! change="$(ask -u admin:admin -X POST \
    "${host}/api/users/change_password?login=admin&previousPassword=admin&password=${password}" 2>&1)"; then
    printf '\033[31m✘ could not reach %s to provision credentials: %s\033[0m\n' "${host}" "${change}" >&2
    printf '   If this server was provisioned with different credentials, remove %s and the\n' "${credentials}" >&2
    printf '   sonar-data volume, then re-run.\n' >&2
    exit 1
  fi
  case "${change}" in
    "") : ;;
    *)
      printf '\033[31m✘ SonarQube rejected the local password: %s\033[0m\n' "${change}" >&2
      exit 1
      ;;
  esac
fi

# One named token, revoked before it is re-issued. A fresh timestamped token per run would pile up
# credentials in the persisted volume forever.
token_name="keiko-local-gate"
ask -o /dev/null -u "admin:${password}" -X POST \
  "${host}/api/user_tokens/revoke?name=${token_name}" 2>/dev/null || true
token="$(ask -u "admin:${password}" -X POST \
  "${host}/api/user_tokens/generate?name=${token_name}" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token??"")}catch{process.stdout.write("")}})')"

if [[ -z "${token}" ]]; then
  printf '\033[31m✘ could not obtain a local analysis token from %s\033[0m\n' "${host}" >&2
  exit 1
fi

# Analysing the whole monorepo takes half an hour, and a gate nobody runs is not a gate. The default
# analyses ONLY the files this branch changed, which is the pre-push question and takes seconds; the
# rules this exists to catch (S7755, S7778, S7786, S7776) are single-file rules, so nothing is lost.
# `--all` analyses everything when a whole-project picture is what you want.
inclusions=""
if [[ "${scope}" == "changed" ]]; then
  # NUL-delimited: a newline in a path would otherwise become two paths. `sonar.inclusions` is a
  # comma-separated list of GLOBS, so a name carrying a comma or a glob metacharacter cannot be
  # expressed exactly — and a path that cannot be expressed exactly would be silently dropped from
  # the scan. That is the one outcome a pre-push gate must never produce, so it widens to a full
  # scan instead of quietly narrowing.
  changed="$(git -C "${repo_root}" diff -z --name-only --diff-filter=ACMR "${base}...HEAD" 2>/dev/null | tr '\0' '\n' || true)"
  if [[ -z "${changed}" ]]; then
    printf '\033[33m! no diff against %s — analysing the whole project instead\033[0m\n' "${base}"
    scope="all"
  elif printf '%s' "${changed}" | grep -q '[],*?[]'; then
    printf '\033[33m! a changed path carries a comma or a glob character and cannot be scoped exactly\033[0m\n'
    printf '  analysing the whole project instead, so nothing is skipped\n'
    scope="all"
  else
    inclusions="$(printf '%s' "${changed}" | tr '\n' ',' | sed 's/,$//')"
    printf '  scoped to %s changed file(s)\n' "$(printf '%s\n' "${changed}" | wc -l | tr -d ' ')"
  fi
fi

say "Analysing"
# sonar.projectKey is deliberately NOT the real project key: nothing here may be mistaken for, or
# uploaded over, the organisation's analysis. Coverage is not supplied on purpose — coverage has its
# own gate (`check:coverage:new-code`) and importing it here would double the runtime for no signal.
# An array, not an unquoted expansion: a changed path containing a space would otherwise split into
# two arguments and silently scan the wrong scope.
scanner_args=()
if [[ -n "${inclusions}" ]]; then scanner_args+=("-Dsonar.inclusions=${inclusions}"); fi
KEIKO_LOCAL_SONAR_TOKEN="${token}" "${compose[@]}" run --rm scanner \
  "${scanner_args[@]}" \
  -Dsonar.projectKey="${project}" \
  -Dsonar.projectName="Keiko (local pre-push scan)" \
  -Dsonar.scm.disabled=true \
  -Dsonar.exclusions="**/node_modules/**,**/dist/**,**/coverage/**,**/.next/**,**/out/**,**/.portable-runtime/**,**/*.min.*" \
  -Dsonar.javascript.node.maxspace=4096

say "Collecting findings"
issues="$(ask -u "${token}": \
  "${host}/api/issues/search?componentKeys=${project}&resolved=false&ps=500")"

printf '%s' "${issues}" | KEIKO_SONAR_SCOPE="${scope}" KEIKO_SONAR_CHANGED="${changed:-}" \
  node "${repo_root}/scripts/report-local-sonar-findings.mjs"
