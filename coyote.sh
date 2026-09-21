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
  subscribe-alerts <email>       Email alarms, visitor reports, and cost alerts to this address (then confirm-alerts)
  protect-alerts                 Re-create the alert email subscriptions that anyone could unsubscribe by link.
                                 AWS sends new confirmation emails; confirm each with confirm-alerts, never by clicking
  confirm-alerts '<link>'        Confirm an SNS email subscription so that only the AWS account can undo it.
                                 Paste the "Confirm subscription" link from the AWS email, in quotes
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

# Every SNS email carries an unsubscribe link that works without logging in. Mail scanners and link
# previews follow it and silently deactivate the subscription. Confirming through the API with
# AuthenticateOnUnsubscribe makes that link useless: only this AWS account can unsubscribe.
cmd_confirm_alerts() {
  local link="${1:-}"
  link="${link//\\/}" # zsh escapes ? = & when a URL is pasted; drop those backslashes
  if [[ "$link" == *"unsubscribe.html"* ]]; then
    die "that is the UNSUBSCRIBE link (do not open it). Use the link behind \"Confirm subscription\" in the email titled \"AWS Notification - Subscription Confirmation\": it contains confirmation.html, TopicArn= and Token="
  fi
  [[ "$link" == *"Token="* && "$link" == *"TopicArn="* ]] || die "paste the full \"Confirm subscription\" link from the AWS email, in single quotes"
  local topic token
  topic="$(sed -E 's/.*TopicArn=([^&]+).*/\1/' <<<"$link")"
  token="$(sed -E 's/.*Token=([^&]+).*/\1/' <<<"$link")"
  aws sns confirm-subscription --profile "$PROFILE" --region us-east-1 --topic-arn "$topic" --token "$token" \
    --authenticate-on-unsubscribe true --query SubscriptionArn --output text
  echo "Confirmed. The unsubscribe link in future emails no longer works without AWS credentials."
}

cmd_subscribe_alerts() {
  local email="${1:-}" topic
  [[ "$email" == *@*.* ]] || die "usage: ./coyote.sh subscribe-alerts <email>"
  for topic in $(aws sns --profile "$PROFILE" --region us-east-1 list-topics --query "Topics[?contains(TopicArn, ':Coyote-')].TopicArn" --output text); do
    aws sns --profile "$PROFILE" --region us-east-1 subscribe --topic-arn "$topic" --protocol email --notification-endpoint "$email" >/dev/null
    echo "subscribed: ${topic##*:}"
  done
  echo
  echo "AWS sent one confirmation email per topic. For each: copy the \"Confirm subscription\" link"
  echo "(right-click, copy link address, do NOT click it) and run:  ./coyote.sh confirm-alerts '<link>'"
}

# A subscription confirmed by clicking the email link cannot be upgraded afterwards, so it is replaced:
# unsubscribe through the API, subscribe the same address again, and confirm the new one with confirm-alerts.
cmd_protect_alerts() {
  local sns=(aws sns --profile "$PROFILE" --region us-east-1) topic sub email protected replaced=0
  for topic in $("${sns[@]}" list-topics --query "Topics[?contains(TopicArn, ':Coyote-')].TopicArn" --output text); do
    for sub in $("${sns[@]}" list-subscriptions-by-topic --topic-arn "$topic" --query "Subscriptions[?Protocol=='email'].SubscriptionArn" --output text); do
      [[ "$sub" == arn:* ]] || continue # pending ones have no ARN yet
      protected="$("${sns[@]}" get-subscription-attributes --subscription-arn "$sub" --query 'Attributes.ConfirmationWasAuthenticated' --output text)"
      [[ "$protected" == "true" ]] && { echo "already protected: ${topic##*:}"; continue; }
      email="$("${sns[@]}" get-subscription-attributes --subscription-arn "$sub" --query 'Attributes.Endpoint' --output text)"
      "${sns[@]}" unsubscribe --subscription-arn "$sub"
      "${sns[@]}" subscribe --topic-arn "$topic" --protocol email --notification-endpoint "$email" >/dev/null
      echo "replaced: ${topic##*:}"
      replaced=$((replaced + 1))
    done
  done
  if [[ "$replaced" -gt 0 ]]; then
    echo
    echo "AWS sent $replaced new confirmation email(s). For each one: copy the \"Confirm subscription\" link"
    echo "(right-click, copy link address, do NOT click it) and run:  ./coyote.sh confirm-alerts '<link>'"
  fi
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
  confirm-alerts) cmd_confirm_alerts "$@" ;;
  protect-alerts) cmd_protect_alerts ;;
  subscribe-alerts) cmd_subscribe_alerts "$@" ;;
  help | -h | --help) usage ;;
  *)
    usage >&2
    die "unknown command '$command'"
    ;;
esac
