# PLAN-EMAIL.md — Email on the owner's domain

Companion to `PLAN.md` (Phase 8, custom domains). Goal: a business that bought its domain through us gets `contacto@sudominio.com`, cheaply, without any risk to the mail reputation of ventas314.com.

Prerequisite: the domain is registered through our Porkbun account (Phase 8) and its DNS is managed there by our API key.

## Decision

Three levels, built in this order. Each one is useful alone.

| Level | What the owner gets | Who runs it | Our cost per domain | Risk to ventas314.com |
|---|---|---|---|---|
| 1. Forwarding | `contacto@sudominio.com` arrives in their Gmail/Outlook | Porkbun email forwarding | $0 | none (Porkbun's MX, Porkbun's reputation) |
| 2. Send as | They also reply *from* `contacto@sudominio.com` inside Gmail | Amazon SES in a separate AWS account, one identity and configuration set per domain | ~$0.10 per 1,000 emails (à la carte) | none if the account is separate (see Isolation) |
| 3. Mailbox | A real inbox (webmail, IMAP, phone app), not tied to Gmail | Porkbun email hosting | $36/year per mailbox | none (Porkbun's servers) |

Level 1 is included with the domain. Level 2 is a small add-on or included. Level 3 is resold (for example $4–5/month) to the few who want a separate inbox.

### Why not AWS for everything
- **Amazon WorkMail is closed to new customers** (since April 30, 2026; end of support March 31, 2027). AWS has no mailbox product for us.
- **Receiving on SES** (MX → SES → S3 → Lambda → forward to Gmail) costs cents, but Porkbun forwarding is free, already in our registrar API, and runs on Porkbun's IPs. If we forwarded spam to Gmail through our SES, the complaints would count against our SES account. Building inbound ourselves buys nothing.
- **Sending is where AWS wins.** Porkbun forwarding cannot send. SES gives each domain DKIM-signed sending for cents. Gmail's "Enviar como" works with any SMTP server, including SES.

### Alternatives considered
- **Zoho Mail Lite**: about $1/user/month, the cheapest real mailbox. Needs a Zoho partner account and one Zoho organization per customer domain, a second vendor and API. Revisit if Level 3 demand grows and $36/year is too much.
- **Google Workspace**: about $7/user/month (US). Best experience, too expensive for the target customer. Owners who want it can buy it themselves; we only add the DNS records.
- **Migadu, Forward Email**: cheap, but their plans are per account with shared sending limits. Not built for one customer per domain at scale.
- **Cloudflare Email Routing**: free, but needs the domain's DNS on Cloudflare. Ours is on Porkbun.

## Isolation: what protects ventas314.com
Reputation lives in three places. Customer mail touches none of ours.
1. **Our domain.** Customer mail never uses ventas314.com: not in `From`, not in the return path (`MAIL FROM`), not in the DKIM `d=`. Each customer domain signs and bounces as itself.
2. **Our SES account.** SES enforces bounce and complaint limits per AWS account and Region. Customer sending goes from a **separate AWS account** (`coyote-mail`, in the same AWS Organization). Its suspension cannot stop our transactional mail (ready emails, sign-in links). Inside it, each domain has its own configuration set, and our own watcher stops a domain whose bounces or complaints climb (see Level 2), so one bad sender is cut off before it endangers the others.
   - **Why not SES tenants.** SES tenant management pauses one tenant at a time, but over SMTP a message joins a tenant only through an `X-SES-TENANT` header, and Gmail's "Enviar como" cannot add headers. Mail Manager can add the header, but its authenticated ingress endpoint has one shared password (50 endpoints per Region), so it cannot give each owner their own credentials. Revisit if SES lets an identity or SMTP credential carry a default tenant.
3. **Our Porkbun account.** Forwards and mailboxes run under our Porkbun account, so heavy abuse could bring a complaint against it. Controls: mail only for paid, published sites with a verified owner; Porkbun's own limits; our terms (no bulk or marketing mail); a kill switch that removes the forwards and mailboxes of one domain at once.

## Level 1 — Forwarding (Porkbun)
- Porkbun API (`email` scope): `POST /email/addForward/{domain}` (`address`, `forwardTo`), `getForwards`, `deleteForward`. Free up to the domain's forward limit; no catch-all.
- Default: `contacto@<domain>` → the owner's email from the form. The owner can add up to a few more (`ventas@`, `pedidos@`) in Mi sitio → "Dominio" → "Correo".
- The first forward sets Porkbun's MX and SPF at the apex. Porkbun refuses (`DNS_CHANGE_CONFIRMATION_REQUIRED`) if another mail service is there. Then we show "Tu dominio ya tiene correo" and change nothing.
- Each forward target gets a verification email first (a link through our main account's SES, from the same sender as our sign-in links, never from the customer's domain, which is not verified there). Otherwise anyone could point a forward at a stranger's inbox.
- The page checks already allow numbers and emails the owner wrote. The site can show `contacto@<domain>` once the forward exists.

## Level 2 — Send as (SES, separate account)
Per domain, when the owner turns it on:
- **SES identity** for the domain in `coyote-mail`, with Easy DKIM (3 CNAMEs) and a custom MAIL FROM `envio.<domain>` (exactly one MX `10 feedback-smtp.us-east-1.amazonses.com`, TXT `v=spf1 include:amazonses.com ~all`, as SES specifies), behavior on MX failure *reject message*. The SPF lives on the subdomain, so Porkbun's apex SPF is never rewritten. DMARC `_dmarc.<domain>`: `p=none` at first, then `p=quarantine`.
- **Configuration set** per domain, set as the identity's **default configuration set** (Gmail cannot add the `X-SES-CONFIGURATION-SET` header), with reputation metrics on and send, bounce, and complaint events to EventBridge.
- **SMTP credentials**: an IAM user per domain whose only permission is `ses:SendRawEmail` (the action SES checks for SMTP) on that identity and its configuration set, with `ses:FromAddress` limited to `*@<domain>`. The SMTP password is derived in code from the access key's secret (SES's SigV4 algorithm, us-east-1 only), shown once with the Gmail "Enviar correo como" steps (server `email-smtp.us-east-1.amazonaws.com`, port 587, TLS), and never stored. IAM has a hard limit of 5,000 users per account. Past that, more accounts or our own SMTP relay.
- **Daily cap**: SES has no per-sender quota. Configuration-set send events → a Lambda counts per domain per day in DynamoDB. Over the cap (start at 100/day) it deactivates that IAM user's access key until the next day and tells the owner. The cap is approximate; a burst can overshoot by a few messages.
- **Reputation**: bounce and complaint events per configuration set → the same Lambda keeps per-domain rates; past a threshold (start at 2% bounces or 0.1% complaints over the last 7 days, with a minimum volume) it deactivates the key and alerts the admin (`alerts` topic). SES does not do this for us without tenants. A stopped domain shows as "Envío pausado" in Mi sitio, with a way to contact us. A CloudWatch alarm on the account-wide `Reputation.BounceRate` and `Reputation.ComplaintRate` also alerts the admin.
- **Production access** for `coyote-mail` in us-east-1 (it is per account and Region): request it with the use case "1:1 mail sent by small businesses from their own verified domains, one SES identity and configuration set per business, daily caps and automatic cut-off on bounces and complaints". The account's own sending quota and rate also cap the total.
- **Cost**: new SES accounts start on the Essentials plan ($0.16 per 1,000 emails); switch `coyote-mail` to à la carte ($0.10 per 1,000 emails, $0.12 per GB of attachments). A business sending 20 emails a day costs about $0.06 a month.

## Level 3 — Mailbox (Porkbun)
- `POST /email/createMailbox/{domain}` ($36/year, from prepaid credit) or `setupMailbox` for the free trial mailbox that comes with every registration. The password is returned once; we show it once and never store it.
- Webmail `webmail.porkbun.com`, IMAP `imap.porkbun.com:993`, SMTP `smtp.porkbun.com:587`. A mailbox address cannot also be a forward: turning a forward into a mailbox deletes the forward first.
- Billing follows Phase 8 payments: we charge the owner yearly, and renewal (`renewMailbox`) runs only if they paid. Unpaid → the mailbox is not renewed, with warnings 30 and 7 days before.

## Kill switch and admin
- `./coyote.sh mail-off <slug>`: deletes the domain's forwards and deactivates its SMTP key. Mailboxes are left for the owner to export, with a warning. `mail-on <slug>` restores the forwards and the key.
- Quarantine or block of a site (`policy.ts` flow) runs `mail-off` too.
- The admin notice for every new forward, send-as, or mailbox: domain, owner, targets.

## Privacy and terms
- Terms: mail is for the business's own 1:1 messages. No bulk mail, purchased lists, or marketing without consent. We can pause sending.
- Privacy: we store forward targets and send counts, never message content. Forwarded mail passes through Porkbun; mail sent through SES leaves only delivery events with us (kept 30 days).

## Implementation phases
- [ ] 👤 Porkbun API key gets the `email` scope (no `purchase` for Level 1–2)
- [ ] Level 1: `porkbun.ts` forwards (add, list, delete), target verification email, "Correo" section in the Dominio tab, `contacto@` by default once the domain is connected
- [ ] Kill switch `mail-off` / `mail-on` (forwards first), wired into quarantine
- [ ] 👤 AWS account `coyote-mail` in the Organization, `coyote-mail` CLI profile, SES production access requested
- [ ] Level 2: second CDK stack in `coyote-mail` (send events → cap and reputation Lambda, alarms; per-domain identities, configuration sets, and IAM users are created at runtime by API, not CDK); the `domains` Lambda assumes a role there to add a domain; DNS records through Porkbun's API; SMTP credentials shown once with Gmail steps
- [ ] Level 2 checks live: send as from Gmail passes DKIM, SPF (MAIL FROM), and DMARC (Gmail "Mostrar original"); the cap deactivates the key; a stopped domain does not affect other domains or ventas314.com mail
- [ ] 👤 Price for Level 2 (add-on or included) and Level 3 decided
- [ ] Level 3: mailbox create/renew through Phase 8 payments, renewal warnings
- [ ] Privacy and terms pages (es/pt) updated

## Sources
- WorkMail end of support: https://docs.aws.amazon.com/workmail/latest/adminguide/workmail-end-of-support.html
- SES tenants (SMTP needs `X-SES-TENANT`): https://docs.aws.amazon.com/ses/latest/dg/tenants.html and Mail Manager patterns: https://aws.amazon.com/blogs/messaging-and-targeting/isolate-email-reputation-in-amazon-ses-mail-manager-with-tenant-management/
- SES custom MAIL FROM: https://docs.aws.amazon.com/ses/latest/dg/mail-from.html
- SES SMTP credentials: https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html
- SES pricing (plans, à la carte): https://aws.amazon.com/ses/pricing/
- SES receiving prices: https://aws.amazon.com/blogs/aws/new-receive-and-process-incoming-email-with-amazon-ses
- Porkbun email API (forwards, mailboxes, $36/year, trial mailbox): https://porkbun.com/llms-full.txt and https://porkbun.com/llms/guides/set-up-a-mailbox
- Zoho Mail pricing: https://www.capterra.com/p/174694/Zoho-Mail/pricing/
- Google Workspace pricing: https://www.emailvendorselection.com/google-workspace-pricing/
