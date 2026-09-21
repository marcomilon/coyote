#!/usr/bin/env bash
# Coyote project commands.
#   ./coyote.sh <command> [args]
# To add a command: write a cmd_<name> function and add it to usage() and the case at the bottom.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${COYOTE_AWS_PROFILE:-coyote}"

usage() {
  cat <<'USAGE'
Usage: ./coyote.sh <command> [args]

Commands:
  deploy [cdk args]              Deploy the stack. Writes infra/cdk-outputs.json
  abuse-report                   Requests, rejections, and new sites of the last 24 h
  unpublish <slug>               Take a site down for good and blocklist its slug
  restore <slug>                 Bring a quarantined site back online
  rerender-all                   Re-render every published site (after theme, renderer, or domain changes)
  help                           Show this help

Environment:
  COYOTE_AWS_PROFILE             AWS CLI profile, which selects the AWS account (default: coyote)
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

# Loads every bundled Lambda the way the Lambda runtime does (CommonJS, outside the repo), with dummy
# settings. Catches bundling problems that unit tests cannot see, before anything is deployed.
check_bundles() {
  local tmp bundle failed=0
  tmp="$(mktemp -d)"
  for bundle in "$ROOT"/infra/cdk.out/asset.*/index.js; do
    grep -q "services/generator/src/handlers" "$bundle" 2>/dev/null || grep -q "JOBS_TABLE" "$bundle" || continue
    cp "$bundle" "$tmp/index.js"
    if ! (cd "$tmp" && JOBS_TABLE=x SITES_TABLE=x RATE_LIMIT_TABLE=x BLOCKLIST_TABLE=x SITES_BUCKET=x \
      APP_BASE_URL=https://a.invalid API_BASE_URL=https://b.invalid SITES_BASE_URL=https://c.invalid AWS_REGION=us-east-1 \
      node -e "if (typeof require('./index.js').handler !== 'function') { console.error('no handler export'); process.exit(1) }"); then
      echo "bundle failed to load: $bundle" >&2
      failed=1
    fi
  done
  rm -rf "$tmp"
  [[ "$failed" == 0 ]] || die "a Lambda bundle does not load; not deploying"
  echo "Lambda bundles load correctly."
}

cmd_deploy() {
  aws sts get-caller-identity --profile "$PROFILE" >/dev/null ||
    die "AWS profile '$PROFILE' is not working. Check 'aws sts get-caller-identity --profile $PROFILE'."

  echo "Building the frontend…"
  (cd "$ROOT" && npm run build -w web --silent)

  cd "$ROOT/infra"
  rm -rf cdk.out
  npx cdk synth --quiet
  check_bundles
  npx cdk deploy Coyote --app cdk.out --profile "$PROFILE" --outputs-file cdk-outputs.json "$@"
}

cmd_admin() {
  cd "$ROOT/services/generator"
  AWS_PROFILE="$PROFILE" npx tsx scripts/admin.ts "$@"
}

command="${1:-help}"
shift || true
case "$command" in
  deploy) cmd_deploy "$@" ;;
  abuse-report | unpublish | restore | rerender-all) cmd_admin "$command" "$@" ;;
  help | -h | --help) usage ;;
  *)
    usage >&2
    die "unknown command '$command'"
    ;;
esac
