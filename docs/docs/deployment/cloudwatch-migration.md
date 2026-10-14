---
layout: default
title: CloudWatch audit logs (migration and testing)
nav_order: 4
parent: Solution deployment
---

# Session audit logs in Amazon CloudWatch

AWS CloudTrail Lake closed to new customers on 31 May 2026, so new TEAM deployments can no longer create the CloudTrail Lake event data store that TEAM previously used for session activity logs. This version of TEAM uses AWS's recommended replacement: AWS CloudTrail events delivered to Amazon CloudWatch Logs. This page summarises what changed, how to deploy or upgrade, and how to test it.

For the full list of changes, see the `[Unreleased]` section of [changelog.md](../../../changelog.md).

---

## What changed

### Audit log pipeline
- An **organization telemetry enablement rule** in CloudWatch delivers CloudTrail management events from every account and Region to CloudWatch Logs. No trail or S3 bucket is needed.
- An **organization centralization rule** copies those events into one log group in the TEAM account, `team-audit-<env>-cloudtrail` (30-day retention). Each event keeps its source account and Region in the `@aws.account` and `@aws.region` fields.
- **CLOUDTRAIL_AUDIT_LOGS** still selects what is collected: `read`, `write`, `read_write` or `none`. CloudTrail Lake event data store ARNs are no longer accepted.

### Session log queries
- TEAM queries session activity with [CloudWatch Logs Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AnalyzingLogData.html). The TEAM UI and API are unchanged.
- Each session's query matches only that session's user and permission set, using exact, case-insensitive matches, and every value is validated before it reaches the query. The previous CloudTrail Lake query inserted values directly into SQL and used substring matches, which could include other users' events.

### Deployment
- **init.sh** (run in the management account) registers the TEAM account as the **Amazon CloudWatch delegated administrator**, in addition to IAM Identity Center and Account Management. It also turns on CloudWatch telemetry config for the organization in all Regions, waits until it is running, and creates the service-linked role that log centralization uses. The CloudTrail delegated administrator step was removed.

### Security updates
- A pre-release scan (dependency CVEs, static analysis, infrastructure-as-code checks and secret scanning) found no issues in the new code or its dependencies.
- Inherited dependency fixes: `uuid` 11.1.1 (`teamgetLogs`, `teamStatus`), `urllib3` 2.8.0 (`teamRouter`, `teamNotifications`), and frontend overrides for `shell-quote`, `proxy-addr` and `lodash`.
- 40 automated tests cover the log Lambdas, the build parameters and the Amplify wiring (`npm run test:lambdas`).

---

## Deploying

### New deployment
1. Complete the [prerequisites](prerequisites.md): an AWS Organizations organization with an organization instance of IAM Identity Center, a dedicated TEAM account, and (for GitHub) a Secrets Manager secret containing your repository URL and a **classic** personal access token with the `repo` and `admin:repo_hook` scopes.
2. Copy `deployment/parameters-template.sh` to `deployment/parameters.sh` and fill it in, including `CLOUDTRAIL_AUDIT_LOGS` (`read`, `write`, `read_write` or `none`).
3. From the management account, run `./init.sh` in the `deployment` folder. On the first run it can take several minutes while CloudWatch telemetry config starts in every Region. It is safe to re-run.
4. From the TEAM account, run `./deploy.sh`. The Amplify build takes about 20–40 minutes.
5. Run `./integration.sh`, create the TEAM custom SAML 2.0 application in IAM Identity Center with the values it prints, put the application's metadata URL in `deployment/details.json`, then run `./cognito.sh`. See [Identity Center integration](configuration/idc.md).

See [Deployment](deployment_process.md) for the full procedure.

### Upgrading an existing TEAM deployment
> Upgrading deletes the TEAM CloudTrail Lake event data store. Export any history you need first: **CloudTrail console → Lake → Event data stores → Actions → Export to CloudWatch**.
{: .warning}

1. Export the event data store history you need (see the warning above).
2. Re-run `./init.sh` from the management account. The `auditLogs` stack fails if the TEAM account is not the CloudWatch delegated administrator.
3. In `parameters.sh`, change `CLOUDTRAIL_AUDIT_LOGS` from the event data store ARN to `read`, `write`, `read_write` or `none`.
4. Run `./update.sh`.

See [Update](update.md) for details.

---

## How to test

### 1. Automated tests
From the repository root:

```sh
npm run test:lambdas
```

Expected: 40 tests pass.

### 2. Infrastructure checks
With credentials for the TEAM account, in the TEAM deployment Region:

```sh
aws observabilityadmin get-telemetry-evaluation-status-for-organization   # Status: RUNNING
aws observabilityadmin list-telemetry-rules-for-organization                # team-<env>-cloudtrail
aws observabilityadmin list-centralization-rules-for-organization           # team-<env>-cloudtrail, RuleHealth: Healthy
aws logs describe-log-groups --log-group-name-prefix team-audit-            # team-audit-<env>-cloudtrail
```

### 3. Organization-wide ingestion
In the TEAM account, open **CloudWatch → Logs → Logs Insights**, select the `team-audit-<env>-cloudtrail` log group, and run:

```
stats count(*) as events by @aws.account, @aws.region
```

Within about an hour of deployment you should see events from every account and Region in scope, including `us-east-1`, where IAM and STS events are recorded.

### 4. End-to-end session test
1. In IAM Identity Center, create a permission set for TEAM to grant, for example `TEAM-ReadOnly` with the AWS managed `ReadOnlyAccess` policy. **Do not assign it to the management account.** When TEAM runs in a delegated administrator account it hides permission sets provisioned to the management account, so the eligibility policy's permission list would otherwise be empty.
2. As a TEAM administrator, create an **eligibility policy** (requester, target account, `TEAM-ReadOnly`) and an **approver policy** for that account.
3. As the requester, submit a request. As the approver, approve it.
4. When the request is in progress, the requester opens the AWS access portal, signs in to the target account with `TEAM-ReadOnly`, and performs a few actions (for example browsing Amazon S3, Amazon EC2 and IAM in the console).
5. In TEAM, open **Elevated access → Active access** (or **Ended access** after the session ends), select the session and choose **View details**. The session activity log should list those API calls within a few minutes; choose refresh if needed. Auditors see the same view under **Audit → Elevated access**.
6. Isolation check: activity by other users in the same account during the session window must not appear in this session's log.

### Viewing logs directly
All centralized CloudTrail events are in the `team-audit-<env>-cloudtrail` log group in the TEAM account. For example, to see one user's activity:

```
fields eventTime, eventSource, eventName, recipientAccountId, @aws.region
| filter userIdentity.principalId like /(?i):jane\.doe@example\.com$/
| sort eventTime desc
```

---

## Things to know

- **Cost** – CloudTrail event delivery, CloudWatch Logs ingestion and storage (in each account and for the central copy), and Logs Insights queries. Reduce it with `CLOUDTRAIL_AUDIT_LOGS=write` and shorter retention (`SourceRetentionInDays` and `AuditLogRetentionInDays` in `amplify/backend/custom/auditLogs/parameters.json`). See [Cost](../overview/cost.md).
- **Regions** – CloudTrail events are collected in all Regions of the organization; the 17 Regions enabled by default in commercial AWS are centralized into TEAM. Add opt-in Regions with `AUDIT_LOG_REGIONS` (Amplify branch environment variable) or `SourceRegions` in `parameters.json`.
- **Existing rules** – an existing organization-level CloudTrail telemetry enablement rule conflicts with TEAM's rule. Commercial AWS partitions only.
- **Limits** – Logs Insights query results are kept for 7 days, and each session view shows up to 10,000 events.
- **Known issues** (inherited, see the changelog) – `basic-ftp` in Amplify build-time tooling (not deployed); the frontend uses Amplify JS v5 (a v6 upgrade is recommended separately); High advisories in the `react-scripts` build toolchain (not deployed).
- **Optional hardening** – encrypt the audit log group with a customer managed AWS KMS key.
