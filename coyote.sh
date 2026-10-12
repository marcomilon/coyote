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
  view <slug>                    Copy a site's current draft to out/view/<slug>/ and open it in the browser
  page-mode [design|template]    Show or switch how pages are made, for the whole stack from the next job: design, Opus
                                 writes each page (about $0.50); template, Haiku fills a template Opus designed (a few cents).
                                 Rediseñar follows the mode too. No deploy needed. Survives deploys
  page-templates                 List the templates for template mode (the repo's services/generator/templates/ and the live ones)
  page-templates add <id> <file> "<description>"
                                 Check a template (npm run templates:make makes them), add it to the repo's library, upload it
  page-templates rm <id>         Take a template out of the repo's library and the live one
  page-model [opus|haiku]        Show or set the model that writes the pages, for the whole stack, from the next job.
                                 haiku is cheap, for testing the workflow; opus makes the real designs. Survives deploys
  page-skill [<name>|none]       Show the page writer's skill and the ones available, or switch it (none: no skill),
                                 for the whole stack from the next job. No deploy needed. Survives deploys
  page-skill add <name> <file>   Add a skill (a SKILL.md, e.g. ~/.claude/skills/<name>/SKILL.md) or replace one
  page-look [on|off]             Show or switch the look nudge on new pages (3 random tones, light or dark, no ticker),
                                 for the whole stack from the next job. No deploy needed. Survives deploys
  page-images [on|off]           Show or switch the photos the page writer makes (for owners who leave "Fotos creadas con IA" on),
                                 for the whole stack from the next job. No deploy needed. Survives deploys
  example-page <page-dir> <slug> Make a page from an opus:sites run a landing example site (examples/sites/<slug>/; then deploy)
  refill-all                     Finish every site's current draft again (after page-check or domain changes; no model call)
  domains                        List the domains owners registered (Mi sitio → Dominio)
  domain-register [on|off]       Show or switch whether owners may register a domain (Coyote pays from the Porkbun balance).
                                 Search works either way. No deploy needed. Survives deploys
  captcha [on|off]               Show or switch the CAPTCHA (Cloudflare Turnstile) on the create, sign-in link and report forms.
                                 Needs the secret coyote/turnstile and the turnstileSiteKey context. No deploy needed. Survives deploys
  email [on|off]                 Show or switch whether we send email (sign-in links, "ready"). The SES bounce and complaint
                                 rate alarms turn it off; check the cause, then turn it on. No deploy needed. Survives deploys
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
    if ! (cd "$tmp" && JOBS_TABLE=x SITES_TABLE=x RATE_LIMIT_TABLE=x BLOCKLIST_TABLE=x CHAT_TABLE=x ACCOUNTS_TABLE=x DOMAINS_TABLE=x SITES_BUCKET=x \
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
  params="$("${aws[@]}" ssm get-parameters --names /coyote/page-mode /coyote/page-model /coyote/page-skill /coyote/page-look /coyote/page-images /coyote/domain-register /coyote/captcha /coyote/email --query "Parameters[].[Name, Value]")"
  param() { awk -v n="/coyote/$1" '$1 == n { print $2 }' <<<"$params"; }
  env() { "${aws[@]}" lambda get-function-configuration --function-name "$fn" --query "Environment.Variables.$1"; }
  bucket="$(output PageSkillsBucketName)"

  echo "Stack       $(cut -f1 <<<"$stack"), last change $(cut -f2 <<<"$stack" | cut -c1-16 | tr T ' ') UTC (AWS profile $PROFILE)"
  echo "App         $(output AppUrl)"
  echo "API         $(output ApiUrl)"
  echo "Sites       $(output SitesBaseUrl)"
  echo
  echo "Page writer (switches apply from the next job)"
  echo "  mode      $(param page-mode)   templates: $("${aws[@]}" s3 cp "s3://$bucket/templates/index.json" - 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s||"[]").map(t=>t.id).join(" ")||"none"))')"
  local override
  override="$(env PAGE_MODEL)"
  echo "  model     $(param page-model)$([[ "$override" != None ]] && echo " (overridden by PAGE_MODEL=$override)")   effort $(env PAGE_EFFORT | sed 's/^None$/default/')"
  echo "  skill     $(param page-skill)   available: $("${aws[@]}" s3 ls "s3://$bucket/" 2>/dev/null | awk '{print $4}' | sed -n 's/\.md$//p' | tr '\n' ' ')"
  echo "  look      $(param page-look)"
  echo "  images    $(param page-images)   model $(env IMAGE_MODEL_ID) (us-west-2), when the owner leaves \"Fotos creadas con IA\" on"
  echo
  echo "Domains     registering $(param domain-register) (Porkbun; ./coyote.sh domains lists them)"
  echo "CAPTCHA     $(param captcha) (Cloudflare Turnstile; site key: $(k="$(output TurnstileSiteKey)"; [[ -n "$k" && "$k" != None ]] && echo "$k" || echo none))"
  echo "Email       $(param email) (off: paused by the SES bounce/complaint alarms or by hand)"
  echo
  echo "Bedrock"
  echo "  questions   $(env BEDROCK_MODEL_ID)"
  echo "  pre-screen  $(env PRESCREEN_MODEL_ID)"
}

# Copies a site's current draft (_draft/<draftId>/ in the sites bucket) to out/view/<slug>/ and opens it.
# Pages use relative asset URLs, so the local copy looks like the real one.
cmd_view() {
  local slug="${1:-}" aws=(aws --profile "$PROFILE" --region us-east-1 --output text) table bucket draft dir
  [[ "$slug" =~ ^[a-z0-9-]+$ ]] || die "usage: ./coyote.sh view <slug>"
  output() { "${aws[@]}" cloudformation describe-stacks --stack-name Coyote --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue"; }
  table="$(output SitesTableName)"
  bucket="$(output SitesBucketName)"
  draft="$("${aws[@]}" dynamodb get-item --table-name "$table" --key "{\"slug\":{\"S\":\"$slug\"}}" --query Item.currentDraftId.S)"
  [[ -n "$draft" && "$draft" != None ]] || die "no site '$slug' with a draft"
  dir="$ROOT/out/view/$slug"
  rm -rf "$dir"
  "${aws[@]}" s3 sync "s3://$bucket/_draft/$draft/" "$dir/" --only-show-errors
  [[ -f "$dir/index.html" ]] || die "draft $draft has no index.html"
  echo "$dir/index.html"
  open "$dir/index.html" 2>/dev/null || xdg-open "$dir/index.html" 2>/dev/null || true
}

# Copies an opus:sites page (with its photos) to examples/sites/<slug>/ with the real footer links. Deploy publishes it.
cmd_example_page() {
  [[ $# -eq 2 ]] || die "usage: ./coyote.sh example-page <run>/pages/<biz>/<page-dir> <slug>"
  local dir
  dir="$(cd "$1" && pwd)" || die "no such folder: $1"
  npm run --silent example-page -w services/generator -- "$dir" "$2"
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

cmd_page_mode() {
  local ssm=(aws ssm --profile "$PROFILE" --region us-east-1) name=/coyote/page-mode
  case "${1:-}" in
    '') "${ssm[@]}" get-parameter --name "$name" --query Parameter.Value --output text ;;
    design)
      "${ssm[@]}" put-parameter --name "$name" --value design --overwrite >/dev/null
      echo "Opus now writes each page (from the next job). page-model, page-skill and page-look apply."
      ;;
    template)
      "${ssm[@]}" put-parameter --name "$name" --value template --overwrite >/dev/null
      echo "Pages are now filled from templates (from the next job). Templates: ./coyote.sh page-templates"
      ;;
    *) die "page-mode takes design or template" ;;
  esac
}

# The repo's services/generator/templates/ is the library; the stack's copy (templates/ in the skills bucket) follows it.
cmd_page_templates() {
  local dir="$ROOT/services/generator/templates" bucket
  bucket="$(aws cloudformation describe-stacks --profile "$PROFILE" --region us-east-1 --stack-name Coyote \
    --query "Stacks[0].Outputs[?OutputKey=='PageSkillsBucketName'].OutputValue" --output text 2>/dev/null)" || bucket=""
  push_templates() {
    [[ -n "$bucket" && "$bucket" != None ]] || die "no skills bucket in the stack. Run ./coyote.sh deploy (it uploads the templates too)"
    aws s3 sync "$dir/" "s3://$bucket/templates/" --delete --profile "$PROFILE" --region us-east-1 --only-show-errors
    echo "The live templates now match the repo's."
  }
  case "${1:-}" in
    '')
      echo "Repo:"
      npm run --silent templates -w services/generator -- list
      if [[ -n "$bucket" && "$bucket" != None ]]; then
        echo "Live: $(aws s3 ls "s3://$bucket/templates/" --profile "$PROFILE" --region us-east-1 | awk '{print $4}' | sed -n 's/\.html$//p' | tr '\n' ' ')"
      fi
      ;;
    add)
      [[ $# -eq 4 ]] || die "usage: page-templates add <id> <file> \"<description>\""
      local file
      file="$(cd "$(dirname "$3")" && pwd)/$(basename "$3")"
      npm run --silent templates -w services/generator -- add "$2" "$file" "$4"
      push_templates
      ;;
    rm)
      [[ $# -eq 2 ]] || die "usage: page-templates rm <id>"
      npm run --silent templates -w services/generator -- rm "$2"
      push_templates
      ;;
    *) die "usage: page-templates [add <id> <file> \"<description>\" | rm <id>]" ;;
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

cmd_domain_register() {
  local ssm=(aws ssm --profile "$PROFILE" --region us-east-1) name=/coyote/domain-register
  case "${1:-}" in
    '') "${ssm[@]}" get-parameter --name "$name" --query Parameter.Value --output text ;;
    on | off)
      "${ssm[@]}" put-parameter --name "$name" --value "$1" --overwrite >/dev/null
      echo "Domain registration is now $1. While on, owners register domains paid from the Porkbun balance."
      ;;
    *) die "domain-register takes on or off" ;;
  esac
}

cmd_captcha() {
  local ssm=(aws ssm --profile "$PROFILE" --region us-east-1) name=/coyote/captcha
  case "${1:-}" in
    '') "${ssm[@]}" get-parameter --name "$name" --query Parameter.Value --output text ;;
    on)
      aws secretsmanager describe-secret --profile "$PROFILE" --region us-east-1 --secret-id coyote/turnstile >/dev/null 2>&1 ||
        die "no secret coyote/turnstile yet. Create it first: aws secretsmanager create-secret --name coyote/turnstile --secret-string '<secret key>' --profile $PROFILE"
      "${ssm[@]}" put-parameter --name "$name" --value on --overwrite >/dev/null
      echo "CAPTCHA on: create, sign-in link and report need Turnstile's token (within a minute)."
      ;;
    off)
      "${ssm[@]}" put-parameter --name "$name" --value off --overwrite >/dev/null
      echo "CAPTCHA off: the forms work without a token (within a minute); the rate limits still apply."
      ;;
    *) die "captcha takes on or off" ;;
  esac
}

cmd_email() {
  local ssm=(aws ssm --profile "$PROFILE" --region us-east-1) name=/coyote/email
  case "${1:-}" in
    '') "${ssm[@]}" get-parameter --name "$name" --query Parameter.Value --output text ;;
    on | off)
      "${ssm[@]}" put-parameter --name "$name" --value "$1" --overwrite >/dev/null
      echo "Email $1 (within a minute)."
      ;;
    *) die "email takes on or off" ;;
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
  abuse-report | unpublish | restore | refill-all | domains) cmd_admin "$command" "$@" ;;
  domain-register) cmd_domain_register "$@" ;;
  captcha) cmd_captcha "$@" ;;
  email) cmd_email "$@" ;;
  view) cmd_view "$@" ;;
  example-page) cmd_example_page "$@" ;;
  page-mode) cmd_page_mode "$@" ;;
  page-templates) cmd_page_templates "$@" ;;
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
