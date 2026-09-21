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
  help                           Show this help

Environment:
  COYOTE_AWS_PROFILE             AWS CLI profile, which selects the AWS account (default: coyote)
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

cmd_deploy() {
  aws sts get-caller-identity --profile "$PROFILE" >/dev/null ||
    die "AWS profile '$PROFILE' is not working. Check 'aws sts get-caller-identity --profile $PROFILE'."

  cd "$ROOT/infra"
  npx cdk deploy Coyote --profile "$PROFILE" --outputs-file cdk-outputs.json "$@"
}

command="${1:-help}"
shift || true
case "$command" in
  deploy) cmd_deploy "$@" ;;
  help | -h | --help) usage ;;
  *)
    usage >&2
    die "unknown command '$command'"
    ;;
esac
