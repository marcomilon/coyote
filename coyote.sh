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
  status                         The deployed stack at a glance: URLs, page writer switches, Bedrock models
  deploy [cdk args]              Deploy the stack. Writes infra/cdk-outputs.json
  destroy                        Delete the whole stack and ALL its data (sites, records, alerts). For when you
                                 stop working on the project: the idle cost drops to zero. deploy brings it back
  abuse-report                   Requests, rejections, and new sites of the last 24 h
  unpublish <slug>               Take a site down for good and blocklist its slug
  restore <slug>                 Bring a quarantined site back online
  page-model [opus|haiku]        Show or set the model that writes the pages, for the whole stack, from the next job.
                                 haiku is cheap, for testing the workflow; opus makes the real designs. Survives deploys
  page-skill [<name>|none]       Show the page writer's skill and the ones available, or switch it (none: no skill),
                                 for the whole stack from the next job. No deploy needed. Survives deploys
  page-skill add <name> <file>   Add a skill (a SKILL.md, e.g. ~/.claude/skills/<name>/SKILL.md) or replace one
  page-look [on|off]             Show or switch the look nudge on new pages (3 random tones, light or dark, no ticker),
                                 for the whole stack from the next job. No deploy needed. Survives deploys
  page-images [on|off]           Show or switch the photos the page writer makes (for owners who leave "Fotos creadas con IA" on),
                                 for the whole stack from the next job. No deploy needed. Survives deploys
  refill-all                     Finish every site's current draft again (after page-check or domain changes; no model call)
  subscribe-alerts <email>       Email alarms, visitor reports, site notices (new and rejected), and cost alerts to this address (then confirm-alerts)
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
    if ! (cd "$tmp" && JOBS_TABLE=x SITES_TABLE=x RATE_LIMIT_TABLE=x BLOCKLIST_TABLE=x CHAT_TABLE=x ACCOUNTS_TABLE=x SITES_BUCKET=x \
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

cmd_destroy() {
  local account sites
  account="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)" ||
    die "AWS profile '$PROFILE' is not working."
  aws cloudformation describe-stacks --profile "$PROFILE" --region us-east-1 --stack-name Coyote >/dev/null 2>&1 ||
    die "there is no Coyote stack in account $account. Nothing to destroy."
  sites="$(aws dynamodb scan --profile "$PROFILE" --region us-east-1 --select COUNT \
    --table-name "$(aws cloudformation describe-stacks --profile "$PROFILE" --region us-east-1 --stack-name Coyote \
      --query "Stacks[0].Outputs[?OutputKey=='SitesTableName'].OutputValue" --output text)" \
    --filter-expression "#s = :p" --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values '{":p":{"S":"published"}}' --query Count --output text 2>/dev/null || echo "?")"

  cat <<WARNING
This deletes the Coyote stack in AWS account $account (profile: $PROFILE):
  - every generated site ($sites published now), all records, uploads, and previews
  - the API, both CloudFront distributions, the guardrail, alarms, dashboard, and budget
  - the alert email subscriptions (after the next deploy: ./coyote.sh subscribe-alerts <email>)
Nothing can be recovered. A later ./coyote.sh deploy creates a fresh stack with NEW URLs.
The CDK bootstrap resources stay (they cost nothing).
WARNING
  read -r -p "Type 'destroy $account' to continue: " answer
  [[ "$answer" == "destroy $account" ]] || die "cancelled"

  # Synth needs a frontend build to exist, even though nothing is uploaded.
  [[ -d "$ROOT/web/dist" ]] || (cd "$ROOT" && npm run build -w web --silent)
  cd "$ROOT/infra"
  npx cdk destroy Coyote --profile "$PROFILE" --force
  rm -f cdk-outputs.json "$ROOT/web/public/config.js"
  echo "Done. CloudFront distributions can take a few more minutes to disappear from the console."
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

cmd_status() {
  local aws=(aws --profile "$PROFILE" --region us-east-1 --output text)
  local stack fn env params bucket
  stack="$("${aws[@]}" cloudformation describe-stacks --stack-name Coyote \
    --query "Stacks[0].[StackStatus, LastUpdatedTime || CreationTime]" 2>/dev/null)" || die "no Coyote stack in this account. Run ./coyote.sh deploy"
  output() { "${aws[@]}" cloudformation describe-stacks --stack-name Coyote --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue"; }
  fn="$("${aws[@]}" lambda list-functions --query "Functions[?starts_with(FunctionName, 'Coyote-GeneratorApiGenerate')].FunctionName | [0]")"
  # name<TAB>value lines; missing parameters print nothing.
  params="$("${aws[@]}" ssm get-parameters --names /coyote/page-model /coyote/page-skill /coyote/page-look /coyote/page-images --query "Parameters[].[Name, Value]")"
  param() { awk -v n="/coyote/$1" '$1 == n { print $2 }' <<<"$params"; }
  env() { "${aws[@]}" lambda get-function-configuration --function-name "$fn" --query "Environment.Variables.$1"; }
  bucket="$(output PageSkillsBucketName)"

  echo "Stack       $(cut -f1 <<<"$stack"), last change $(cut -f2 <<<"$stack" | cut -c1-16 | tr T ' ') UTC (AWS profile $PROFILE)"
  echo "App         $(output AppUrl)"
  echo "API         $(output ApiUrl)"
  echo "Sites       $(output SitesBaseUrl)"
  echo
  echo "Page writer (switches apply from the next job)"
  local override
  override="$(env PAGE_MODEL)"
  echo "  model     $(param page-model)$([[ "$override" != None ]] && echo " (overridden by PAGE_MODEL=$override)")   effort $(env PAGE_EFFORT | sed 's/^None$/default/')"
  echo "  skill     $(param page-skill)   available: $("${aws[@]}" s3 ls "s3://$bucket/" 2>/dev/null | awk '{print $4}' | sed -n 's/\.md$//p' | tr '\n' ' ')"
  echo "  look      $(param page-look)"
  echo "  images    $(param page-images)   model $(env IMAGE_MODEL_ID) (us-west-2), when the owner leaves \"Fotos creadas con IA\" on"
  echo
  echo "Bedrock"
  echo "  questions   $(env BEDROCK_MODEL_ID)"
  echo "  pre-screen  $(env PRESCREEN_MODEL_ID)"
}

cmd_page_model() {
  local ssm=(aws ssm --profile "$PROFILE" --region us-east-1) name=/coyote/page-model
  case "${1:-}" in
    '') "${ssm[@]}" get-parameter --name "$name" --query Parameter.Value --output text ;;
    opus | haiku)
      "${ssm[@]}" put-parameter --name "$name" --value "$1" --overwrite >/dev/null
      echo "Pages are now written by $1 (from the next job)."
      ;;
    *) die "page-model takes opus or haiku" ;;
  esac
}

cmd_page_skill() {
  local ssm=(aws ssm --profile "$PROFILE" --region us-east-1) s3=(aws s3 --profile "$PROFILE" --region us-east-1)
  local name=/coyote/page-skill bucket
  bucket="$(aws cloudformation describe-stacks --profile "$PROFILE" --region us-east-1 --stack-name Coyote \
    --query "Stacks[0].Outputs[?OutputKey=='PageSkillsBucketName'].OutputValue" --output text)"
  [[ -n "$bucket" && "$bucket" != None ]] || die "no skills bucket in the stack. Run ./coyote.sh deploy first"
  case "${1:-}" in
    '')
      echo "Active: $("${ssm[@]}" get-parameter --name "$name" --query Parameter.Value --output text)"
      echo "Available: none $("${s3[@]}" ls "s3://$bucket/" | awk '{print $4}' | sed -n 's/\.md$//p' | tr '\n' ' ')"
      ;;
    add)
      [[ $# -eq 3 ]] || die "usage: page-skill add <name> <file>"
      [[ "$2" =~ ^[a-z0-9-]+$ && "$2" != none ]] || die "a skill name is lowercase letters, digits and hyphens (not 'none')"
      [[ -s "$3" ]] || die "no such file: $3"
      "${s3[@]}" cp "$3" "s3://$bucket/$2.md" --content-type 'text/markdown; charset=utf-8' >/dev/null
      echo "Added $2. Switch to it with: ./coyote.sh page-skill $2"
      ;;
    none)
      "${ssm[@]}" put-parameter --name "$name" --value none --overwrite >/dev/null
      echo "Pages are now written with no skill (from the next job)."
      ;;
    *)
      [[ $# -eq 1 ]] || die "usage: page-skill [<name>|none] or page-skill add <name> <file>"
      "${s3[@]}" ls "s3://$bucket/$1.md" >/dev/null 2>&1 || die "no skill '$1'. Add it first: ./coyote.sh page-skill add $1 <file>"
      "${ssm[@]}" put-parameter --name "$name" --value "$1" --overwrite >/dev/null
      echo "Pages are now written with the $1 skill (from the next job)."
      ;;
  esac
}

cmd_page_look() {
  local ssm=(aws ssm --profile "$PROFILE" --region us-east-1) name=/coyote/page-look
  case "${1:-}" in
    '') "${ssm[@]}" get-parameter --name "$name" --query Parameter.Value --output text ;;
    on | off)
      "${ssm[@]}" put-parameter --name "$name" --value "$1" --overwrite >/dev/null
      echo "The look nudge is now $1 (from the next job)."
      ;;
    *) die "page-look takes on or off" ;;
  esac
}

cmd_page_images() {
  local ssm=(aws ssm --profile "$PROFILE" --region us-east-1) name=/coyote/page-images
  case "${1:-}" in
    '') "${ssm[@]}" get-parameter --name "$name" --query Parameter.Value --output text ;;
    on | off)
      "${ssm[@]}" put-parameter --name "$name" --value "$1" --overwrite >/dev/null
      echo "Made photos are now $1 (from the next job)."
      ;;
    *) die "page-images takes on or off" ;;
  esac
}

cmd_admin() {
  cd "$ROOT/services/generator"
  AWS_PROFILE="$PROFILE" npx tsx scripts/admin.ts "$@"
}

command="${1:-help}"
shift || true
case "$command" in
  status) cmd_status ;;
  deploy) cmd_deploy "$@" ;;
  destroy) cmd_destroy ;;
  abuse-report | unpublish | restore | refill-all) cmd_admin "$command" "$@" ;;
  page-model) cmd_page_model "$@" ;;
  page-skill) cmd_page_skill "$@" ;;
  page-look) cmd_page_look "$@" ;;
  page-images) cmd_page_images "$@" ;;
  confirm-alerts) cmd_confirm_alerts "$@" ;;
  protect-alerts) cmd_protect_alerts ;;
  subscribe-alerts) cmd_subscribe_alerts "$@" ;;
  help | -h | --help) usage ;;
  *)
    usage >&2
    die "unknown command '$command'"
    ;;
esac
