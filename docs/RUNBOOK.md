# Runbook

How the production deployment is built, deployed, backed up, restored and repaired. The decisions behind it are D-100 to D-107 in `docs/DECISIONS.md`.

## What runs where

- **One EC2 instance** in `ap-south-1`: a t4g.medium (ARM, 4 GB) running Amazon Linux 2023. Docker Compose runs `caddy`, `web`, `api`, `worker`, `postgres` and `redis` from `deploy/compose.prod.yaml`.
- **Only Caddy is reachable from outside**, on ports 80 and 443 (TCP, plus UDP 443 for HTTP/3). It obtains the TLS certificate and sends `/api/*` to the API and everything else to the web app. There is no SSH; Session Manager is the shell.
- **Data volume:** an encrypted EBS volume mounted at `/data` holds Postgres, Redis, Caddy's certificates and the three newest local backups. It is separate from the instance, so the instance can be replaced.
- **S3:** two private, encrypted buckets.
  - `…-media-…` holds customer media under `tenants/{id}/`, expired after `media_retention_days` (default 90).
  - `…-ops-…` holds nightly backups (`backups/`, 30 days, versioned) and release bundles (`releases/`).
- **ECR:** one repository each for `api`, `worker` and `web`. Tags are commit SHAs and cannot be overwritten.
- **SSM Parameter Store** under `/support-desk/prod/`:
  - Settings, managed by Terraform (`infra/terraform/settings.tf`).
  - Secrets, managed by `infra/scripts/put-secrets.sh`. Secrets never go through Terraform, CI or the repo.
- **IAM:**
  - **Instance role:** reads its SSM path, pulls from ECR, reads and writes `tenants/*` in the media bucket and `backups/*` in the ops bucket, and calls Transcribe, Polly, Claude (bedrock-mantle) and Cohere.
  - **Two GitHub OIDC roles:** `push` (ECR and release bundles, from `main` only) and `deploy` (Run Command on this one instance, from the `production` environment only).
- **Cost:** an estimated $24 a month for the infrastructure at rest. The usage-based services (Bedrock, Transcribe, Polly, WhatsApp) come on top. A budget email fires at 80 % of `budget_monthly_usd`.

## First-time setup

Run these once, in order, from your own machine with an AWS profile that can administer the account. Terraform can come from the official image; `scripts/infra-check.sh` shows the `docker run` form.

1. **Bedrock access** (console, `ap-south-1`):
   - Request access to Claude Haiku 5.5. Until access is granted, set `chat_model = "anthropic.claude-haiku-4-5"`.
   - Subscribe to Cohere Embed Multilingual v3 in AWS Marketplace. Invoking it once with your own credentials also starts the subscription. That's why the instance role has no `aws-marketplace` permissions.
2. **State bucket:**
   - Run `terraform -chdir=infra/terraform/bootstrap init && terraform -chdir=infra/terraform/bootstrap apply`.
   - Copy `infra/terraform/backend.hcl.example` to `backend.hcl` and put the `state_bucket` output in it.
3. **Variables:** copy `terraform.tfvars.example` to `terraform.tfvars` (git-ignored) and fill it in.
   - `domain`: the host name customers and staff will use.
   - `github_oidc_subject_prefix`: the repository part of GitHub's OIDC `sub` claim.
     - Repositories created before 2026-07-15 use `repo:OWNER/REPO`.
     - Newer ones, or ones that opted in to immutable subject claims, use `repo:OWNER@OWNER_ID/REPO@REPO_ID`. Get the IDs from `gh api repos/OWNER/REPO --jq '"\(.owner.id) \(.id)"'`.
     - If unsure, run a throwaway workflow that prints the token's `sub`.
     - Set `create_github_oidc_provider = false` if the account already has GitHub's provider.
   - `budget_email`: where cost alerts go.
4. **Apply:**
   - Run `terraform -chdir=infra/terraform init -backend-config=backend.hcl`, then `plan -out=tfplan`. Read the plan, then `apply tfplan`.
   - Note the outputs: `public_ip`, `instance_id`, `ops_bucket`, `media_origin`, `ecr_registry` and the two role ARNs.
5. **DNS:** point the domain's A record at `public_ip`. Caddy obtains the certificate the first time a request arrives over HTTPS after the record resolves.
6. **Secrets:** `AWS_REGION=ap-south-1 infra/scripts/put-secrets.sh`.
   - It generates the database passwords, `BETTER_AUTH_SECRET` and `CREDENTIALS_KEY`, asks for Meta's app secret, and generates the webhook verify token, which it prints once.
   - Add `--seed` to also set `SEED_PASSWORD` for the public demo accounts.
7. **GitHub:**
   - Create the environment `production`, with yourself as required reviewer and deployments limited to `main`.
   - Add these repository variables from the outputs:

     | Variable              | Value                    |
     | --------------------- | ------------------------ |
     | `AWS_REGION`          | `ap-south-1`             |
     | `AWS_PUSH_ROLE_ARN`   | `github_push_role_arn`   |
     | `AWS_DEPLOY_ROLE_ARN` | `github_deploy_role_arn` |
     | `ECR_REGISTRY`        | `ecr_registry`           |
     | `OPS_BUCKET`          | `ops_bucket`             |
     | `MEDIA_ORIGIN`        | `media_origin`           |
     | `DEPLOY_INSTANCE_ID`  | `instance_id`            |
     | `DEPLOY_ENABLED`      | `true`, last             |

   - Until `DEPLOY_ENABLED` is `true`, CI only builds images.
8. **First deploy:**
   - Push to `main`. CI then tests everything, pushes the images, uploads the bundle and waits for your approval in `production`.
   - Once approved, it runs `support-desk-deploy <sha>` on the instance and prints the output.
9. **Demo data** (optional): `aws ssm start-session --target <instance_id>`, then `sudo /opt/support-desk/current/deploy/bin/seed`. This creates the platform admin and the two demo businesses with `SEED_PASSWORD`.
10. **Meta:**
    - In the Meta app, set the webhook URL to `https://<domain>/api/webhooks/whatsapp/meta`, with the verify token from step 6. Subscribe to `messages`.
    - Add a payment method in Billing Hub. Since 1 October 2026, Meta stops delivering service messages after the first 1,000 a month per number when none is on file.
    - Then, in the desk, open Settings, then WhatsApp, and enter the business's phone number ID and token. The token is stored sealed (D-094).
11. **Smoke test:**
    - Sign in and send a text and a voice note from a real phone. Check that the reply arrives and that the voice note gets a transcript.
    - Then open CloudTrail, find the `CreateInference` event and read its model value. Use it to add the `bedrock-mantle:Model` condition in `iam.tf` (D-107).

## Deploying

- **Normal path:** merge to `main`, then approve the `production` deployment.
- **What `deploy/bin/deploy` does:**
  1. Renders `/etc/support-desk/app.env` (mode 600) from SSM.
  2. Pulls the SHA-tagged images.
  3. Runs `provision`: database roles, with passwords from SSM, and migrations.
  4. Starts the new containers and waits for every health check.
  5. Checks `https://<domain>/health` through Caddy, refreshes the backup timers, and records the deploy in `/opt/support-desk/deploys.log`.
- **Downtime:** containers are replaced in place, so expect a few seconds of downtime. That's the single-instance trade-off.
- **Migrations must keep the previous release working.** Add a column first and remove it in a later release, so that a rollback is just a redeploy.
- **By hand:** open a Session Manager shell and run `sudo support-desk-deploy <sha>`. The images and the bundle for that SHA must already be in ECR and S3; CI's `images` and `bundle` jobs put them there.

### Roll back

```sh
tail /opt/support-desk/deploys.log          # find the previous good SHA
sudo support-desk-deploy <previous-sha>
```

ECR keeps the last 20 images and S3 keeps bundles for 90 days. If the bad release included a migration the previous code cannot run against, roll forward with a fix instead, or restore the backup taken before the deploy (see below).

### Change a setting or a secret

- **Setting:** `aws ssm put-parameter --name /support-desk/prod/NAME --value VALUE --overwrite`. For settings Terraform owns, change the variable and apply instead.
- **Secret:** `infra/scripts/put-secrets.sh --rotate NAME`.
- **Then redeploy the current release:** `sudo support-desk-deploy "$(basename "$(readlink /opt/support-desk/current)")"`.
- **Notes on rotating:**
  - Rotating a database password is a redeploy, since `provision` applies it.
  - Rotating `CREDENTIALS_KEY` leaves the sealed tokens unreadable: every business must re-enter its WhatsApp token afterwards.
  - The `postgres` superuser password is fixed when the data directory is created. Change it with `ALTER ROLE` inside Postgres first, then in SSM.

### Stop the assistant (kill switch)

Set `ASSISTANT_ENABLED` to `false` in SSM and redeploy the current release. New messages wait for a person. Nothing else changes.

## Access, logs and health

```sh
aws ssm start-session --target <instance_id>
cd /opt/support-desk/current/deploy
sudo docker compose -p support-desk -f compose.prod.yaml --env-file /etc/support-desk/app.env ps
sudo docker compose -p support-desk -f compose.prod.yaml --env-file /etc/support-desk/app.env logs -f --since 10m api worker
```

- **Logs:** the apps log structured JSON, with phone numbers and message text masked. Container logs rotate at 20 MB × 5 per container.
- **Health:** the API answers `/ready` and the worker answers `/health` inside the network. From outside, `https://<domain>/health` checks Caddy and the web app.
- **Disk:** `df -h / /data`. Old images are pruned after a week on every deploy; `sudo docker image prune -a` frees more.

## Backups and restores

- **Nightly** at 02:00 India time (`support-desk-backup.timer`):
  - `deploy/bin/backup` takes a `pg_dump` as the superuser, so row-level security hides nothing.
  - It checks that the dump lists its table data, then uploads it to `s3://<ops>/backups/`, encrypted.
  - S3 keeps 30 days, plus 7 days for overwritten versions. `/data/backups` keeps the newest three.
- **Weekly restore drill** on Sundays (`support-desk-restore-drill.timer`): restores the newest backup into a scratch database. It checks that the tables, the row-level security switches and the policy counts match the live database, then drops it.
- **Check them:** `systemctl list-timers 'support-desk-*'`, `journalctl -u support-desk-backup -u support-desk-restore-drill --since -8d`.
- **Tested how:**
  - CI and `make backup-test` back up the migrated test database and restore it. Row counts must match, a truncated dump must fail without leaving tables behind, and a restore over `app` is refused.
  - `make rehearsal` runs the drill and a full `--replace-production` restore against the production Compose stack.
- **Recovery point:** up to 24 hours of data. Take a manual backup before risky work: `sudo /opt/support-desk/current/deploy/bin/backup`.

### Look at old data without touching production

```sh
sudo /opt/support-desk/current/deploy/bin/restore --into app_restore_check latest   # or an s3:// URI or a file
# inspect it with psql inside the postgres container, then:
sudo /opt/support-desk/current/deploy/bin/restore --into app_restore_check --drop-after latest
```

### Replace the production database

```sh
sudo /opt/support-desk/current/deploy/bin/restore --replace-production latest
```

This:

1. Asks for confirmation.
2. Stops Caddy, web, API and worker.
3. Renames the live database to `app_before_restore_<time>` rather than dropping it.
4. Restores, reruns `provision` and starts everything.

Once the restored data is confirmed, drop the kept copy with `DROP DATABASE app_before_restore_<time>`. Messages that arrived between the backup and the restore are lost from the database. Meta does not resend delivered webhooks, so tell the businesses.

## When things break

- **The instance is impaired:**
  - Try a reboot from the console or with `aws ec2 reboot-instances`.
  - If it stays broken, replace it with `terraform apply -replace=aws_instance.app`. The data volume is reattached and recognised, and is not formatted again.
  - Then redeploy the last SHA from CI (re-run the deploy job), since the new instance has no releases on disk yet.
- **The Availability Zone or the data volume is lost:**
  - The data volume lives in one zone. Change the subnet's zone in `network.tf` and apply, which creates a new volume and instance.
  - Then deploy, and run `restore --replace-production latest` from S3.
- **No certificate:** check that the A record resolves to `public_ip` and that port 80 is reachable. Then read Caddy's log (`logs caddy`). Let's Encrypt rate limits apply after repeated failures.
- **Meta webhooks rejected:**
  - A 403 on the handshake means the verify token differs from SSM.
  - A 401 on events means `META_APP_SECRET` is wrong.
  - Meta retries for a while; stored raw events are never lost once accepted.
- **The assistant hands everything to people:** Bedrock refused the call (D-095). Check model access and the IAM statements in `iam.tf`, then the API and worker logs for `ModelUnavailableError`.
- **Voice notes are never transcribed:** check the Transcribe job in the console. Its output must be allowed into the media bucket, which the instance role grants under `tenants/*`.
- **Budget alert:**
  1. Open Cost Explorer by service.
  2. If Bedrock spend spiked, lower the tenants' daily token budget or use the kill switch.
  3. If WhatsApp spend spiked, check Meta's billing; it isn't on the AWS bill.

## Upgrade path

The single instance is a deliberate trade-off: about $24 a month, one place to look, minutes to restore.

**What it costs:**

- Deploys cause seconds of downtime.
- There's no redundancy across zones.
- Restores can lose up to a day of data.

**The next steps, in order:**

1. Postgres on RDS (point-in-time recovery, Multi-AZ).
2. Redis on ElastiCache.
3. A second app instance behind an Application Load Balancer, which replaces Caddy's TLS with ACM.
4. Images deployed by ECS instead of Compose.

The images, migrations and settings in SSM carry over unchanged.
