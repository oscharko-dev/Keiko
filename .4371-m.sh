set -u
cd /repo
run() { local name="$1"; shift; echo "== $name"; "$@" > /tmp/out.$$ 2>&1 < /dev/null; local rc=$?; tail -${TAILN:-4} /tmp/out.$$ | cut -c1-240; echo "$name rc=$rc"; }
run build-packages bash -c 'npm run --silent build:packages 2>&1 | tail -2'
run gen-catalog bash -c 'npm run --silent generate:op-catalog 2>&1 | tail -2'
run activity-log npm run --silent check:activity-log
run ui-tests bash -c 'cd packages/keiko-ui && npx vitest run --maxWorkers=4 src/app/components/desktop src/lib 2>&1 | grep -E "×|Test Files|Tests " | head -10'
TAILN=8 run ui-lint npm --silent --workspace @oscharko-dev/keiko-ui run lint
run ui-typecheck npm run --silent typecheck --workspace @oscharko-dev/keiko-ui
run typecheck npm run --silent typecheck
run knip npm run --silent check:knip
run style-governance bash -c 'cd packages/keiko-ui && npx vitest run --maxWorkers=4 style-governance 2>&1 | grep -E "×|Test Files|Tests " | head'
run prettier bash -c 'npx prettier --check packages/keiko-ui/src/app/components/desktop/widgets/connectors/LivePodCard.tsx'
echo "M DONE"
