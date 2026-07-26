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

while [ $# -gt 0 ]; do
  case "$1" in
    --all) scope="all" ;;
    --base) base="${2:?--base needs a ref}"; shift ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

say "Starting the local SonarQube (first run pulls the image and takes a few minutes)"
"${compose[@]}" up -d sonarqube

# Waiting from the host rather than with a container healthcheck: the SonarQube image carries no
# wget, curl, bash or python, so nothing inside it can probe its own port.
printf '  waiting for the server'
for _ in $(seq 1 120); do
  if [ "$(curl -fsS "${host}/api/system/status" 2>/dev/null | sed -n 's/.*"status":"\([A-Z]*\)".*/\1/p')" = "UP" ]; then
    printf ' up\n'
    break
  fi
  printf '.'
  sleep 5
done
if [ "$(curl -fsS "${host}/api/system/status" 2>/dev/null | sed -n 's/.*"status":"\([A-Z]*\)".*/\1/p')" != "UP" ]; then
  printf '\n\033[31m✘ SonarQube did not become ready at %s\033[0m\n' "${host}" >&2
  exit 1
fi

# SonarQube ships with admin/admin and refuses API use until that password is changed. Both values
# are local-only and are never a secret: this server is bound to 127.0.0.1 and holds no evidence.
# The password must satisfy SonarQube's own policy (upper, lower, digit, special) or the change is
# rejected — and a rejected change is NOT ignored here, because a swallowed bootstrap failure turns
# into an unexplained 401 three steps later.
say "Provisioning a local analysis token"
password="Keiko-local-gate-1"
if curl -fsS -o /dev/null -u "admin:${password}" "${host}/api/authentication/validate" 2>/dev/null &&
  [ "$(curl -fsS -u "admin:${password}" "${host}/api/authentication/validate")" = '{"valid":true}' ]; then
  printf '  password already provisioned\n'
else
  change="$(curl -fsS -u admin:admin -X POST \
    "${host}/api/users/change_password?login=admin&previousPassword=admin&password=${password}" || true)"
  case "${change}" in
    "") : ;;
    *result*)
      printf '\033[31m✘ SonarQube rejected the local password: %s\033[0m\n' "${change}" >&2
      exit 1
      ;;
  esac
fi

token="$(curl -fsS -u "admin:${password}" -X POST \
  "${host}/api/user_tokens/generate?name=keiko-local-$(date +%s)" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token??"")}catch{process.stdout.write("")}})')"

if [ -z "${token}" ]; then
  printf '\033[31m✘ could not obtain a local analysis token from %s\033[0m\n' "${host}" >&2
  exit 1
fi

# Analysing the whole monorepo takes half an hour, and a gate nobody runs is not a gate. The default
# analyses ONLY the files this branch changed, which is the pre-push question and takes seconds; the
# rules this exists to catch (S7755, S7778, S7786, S7776) are single-file rules, so nothing is lost.
# `--all` analyses everything when a whole-project picture is what you want.
inclusions=""
if [ "${scope}" = "changed" ]; then
  changed="$(git -C "${repo_root}" diff --name-only --diff-filter=ACMR "${base}...HEAD" 2>/dev/null || true)"
  if [ -z "${changed}" ]; then
    printf '\033[33m! no diff against %s — analysing the whole project instead\033[0m\n' "${base}"
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
KEIKO_LOCAL_SONAR_TOKEN="${token}" "${compose[@]}" run --rm scanner \
  ${inclusions:+-Dsonar.inclusions="${inclusions}"} \
  -Dsonar.projectKey="${project}" \
  -Dsonar.projectName="Keiko (local pre-push scan)" \
  -Dsonar.scm.disabled=true \
  -Dsonar.exclusions="**/node_modules/**,**/dist/**,**/coverage/**,**/.next/**,**/out/**,**/.portable-runtime/**,**/*.min.*" \
  -Dsonar.javascript.node.maxspace=4096

say "Collecting findings"
issues="$(curl -fsS -u "${token}": \
  "${host}/api/issues/search?componentKeys=${project}&resolved=false&ps=500")"

printf '%s' "${issues}" | KEIKO_SONAR_SCOPE="${scope}" KEIKO_SONAR_CHANGED="${changed:-}" \
  node "${repo_root}/scripts/report-local-sonar-findings.mjs"
