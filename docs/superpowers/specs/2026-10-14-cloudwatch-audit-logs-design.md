# Replace CloudTrail Lake with Amazon CloudWatch for TEAM session audit logs

- **Date:** 2026-10-14
- **Status:** Approved design, pending spec review
- **Branch:** `feat/cloudwatch-audit-logs` (fork `debojitroy/iam-identity-center-team`)

## Context

TEAM records the API activity of every elevated session and shows it on the session
logs page. Today this uses an AWS CloudTrail Lake event data store (EDS) created by the
Amplify custom resource `cloudtrailLake`, queried by two Lambdas:

- `teamgetLogs` — DynamoDB stream trigger on the Sessions table. Runs a CloudTrail Lake
  SQL query for the session window and writes the `queryId` back via AppSync
  `updateSessions`.
- `teamqueryLogs` — AppSync `getLogs(queryId)` resolver. Returns
  `[{eventID, eventName, eventSource, eventTime}]`.

CloudTrail Lake closed to new customers on 2026-05-31. AWS recommends Amazon CloudWatch
as the replacement: CloudTrail events delivered to CloudWatch Logs through telemetry
enablement rules (service-linked channels, no trail required), consolidated with
CloudWatch Logs centralization rules. New TEAM deployments cannot create an EDS, so the
stack is broken for new customers.

## Goals

- New deployments work end to end without CloudTrail Lake.
- Keep the existing `queryId` contract so AppSync schema, Sessions table and UI flow are
  unchanged.
- Keep the `CLOUDTRAIL_AUDIT_LOGS` choice of `read | write | read_write | none`.

## Non-goals

- Supporting an existing EDS ARN as input (removed).
- Migrating historical EDS data (operators use CloudTrail's "Export to CloudWatch").
- Other modernisation of TEAM unless it blocks deployment.

## Architecture

```
member accounts (all Regions in scope)                 TEAM account (deploy Region)
┌──────────────────────────────┐                      ┌────────────────────────────────┐
│ CloudTrail ──SLC──▶ aws/cloudtrail/<event-type>      │ team-audit-<env>-cloudtrail    │
│   (OrganizationTelemetryRule)│ ──centralization──▶  │   (AWS::Logs::LogGroup)        │
└──────────────────────────────┘   (Org Central. Rule)│        ▲             ▲         │
                                                      │ StartQuery     GetQueryResults │
                                                      │ teamgetLogs    teamqueryLogs   │
                                                      └────────────────────────────────┘
```

### One-time organization setup (management account, `deployment/init.sh`)

1. `aws observabilityadmin start-telemetry-evaluation-for-organization` — enables trusted
   access for CloudWatch and creates `AWSServiceRoleForObservabilityAdmin`.
2. `aws organizations register-delegated-administrator --service-principal
   observabilityadmin.amazonaws.com --account-id $TEAM_ACCOUNT` (idempotent check first).
3. Ensure the `AWSServiceRoleForObservabilityAdmin_LogsCentralization` service-linked
   role exists (management and TEAM accounts; required by centralization rules).
4. Remove the CloudTrail trusted-access, service-linked-role and delegated-admin steps
   (no longer used). IAM Identity Center and Account Management steps are unchanged.

These checks live in a sourced helper, `deployment/audit-logs-prereqs.sh`, used by
`init.sh`, `deploy.sh` and `update.sh` (management-account deployments run the
organization steps from `deploy.sh` because they skip `init.sh`).

### TEAM stack: Amplify custom resource `auditLogs` (replaces `cloudtrailLake`)

Template `amplify/backend/custom/auditLogs/auditLogs-cloudformation-template.json`.

Parameters:

| Name | Source | Default |
| --- | --- | --- |
| `env` | Amplify | — |
| `CloudTrailAuditLogs` | `CLOUDTRAIL_AUDIT_LOGS` | `read` |
| `OrganizationId` | `parameters.js` (`organizations:DescribeOrganization`) | — |
| `SourceRegions` | `AUDIT_LOG_REGIONS` (optional) | 17 default-enabled commercial Regions |
| `SourceRetentionInDays` | parameters.json | `7` |
| `AuditLogRetentionInDays` | parameters.json | `30` |

Resources:

1. **`AuditLogGroup`** — `AWS::Logs::LogGroup`, name `team-audit-<env>-cloudtrail`,
   retention `AuditLogRetentionInDays`. Always created so the Lambdas have a stable,
   pre-existing target (queries return empty instead of failing before first delivery).
2. **`CloudTrailTelemetryRule`** — `AWS::ObservabilityAdmin::OrganizationTelemetryRule`,
   condition `CloudTrailAuditLogs != none`:
   - `ResourceType: AWS::CloudTrail`, `TelemetryType: Logs`, `AllRegions: true`,
     `Scope` omitted (organization-wide).
   - `DestinationConfiguration`: `DestinationType: cloud-watch-logs`,
     `RetentionInDays: SourceRetentionInDays`,
     `CloudtrailParameters.AdvancedEventSelectors`:
     - `read` → `eventCategory = Management` and `readOnly = true`
     - `write` → `eventCategory = Management` and `readOnly = false`
     - `read_write` → `eventCategory = Management`
3. **`AuditLogCentralizationRule`** — `AWS::ObservabilityAdmin::OrganizationCentralizationRule`,
   same condition:
   - Source: `Scope: OrganizationId = '<OrganizationId>'` (syntax probed before
     deploy), `Regions: SourceRegions`,
     `LogGroupSelectionCriteria: LogGroupName LIKE 'aws/cloudtrail/%'`,
     `EncryptedLogGroupStrategy: SKIP`.
   - Destination: `Account` = `AWS::AccountId`, `Region` = `AWS::Region`,
     `LogGroupNamePattern` = the static `AuditLogGroup` name, so all source accounts and
     Regions merge into one log group (source context is kept in `@aws.account` /
     `@aws.region`). The destination group uses the log group's default AWS-owned
     encryption; the rule sets no `LogsEncryptionConfiguration` because the service
     rejects it together with `EncryptedLogGroupStrategy: SKIP`.

Output: `AuditLogGroupName` (replaces `EventDataStoreOutput`).

### Query Lambdas

Both switch from `@aws-sdk/client-cloudtrail` to `@aws-sdk/client-cloudwatch-logs`.
`teamgetLogs` reads `AUDIT_LOG_GROUP` (replaces `EVENT_DATA_STORE`); `teamqueryLogs`
only needs the `queryId`, so it no longer depends on the custom resource. Pure logic
moves to small modules (`query.js`, `results.js`) and handlers take injected clients
for unit testing.

**`teamgetLogs`** (DynamoDB stream → Sessions `NewImage`):

1. Validate: `accountId` is 12 digits; `startTime`/`endTime` parse as dates and
   `endTime > startTime`; strip a leading `idc_` from the username; `username` and
   `role` must match the IAM Identity Center character set `[A-Za-z0-9_+=,.@-]`
   (anything else is rejected, so no value can break out of the query string).
2. `StartQuery` on `AUDIT_LOG_GROUP`, `startTime`/`endTime` in epoch seconds, query:

   ```
   fields eventID, eventName, eventSource, eventTime
   | filter recipientAccountId = "<accountId>"
   | filter userIdentity.sessionContext.sessionIssuer.arn like /\/AWSReservedSSO_<role>_[0-9A-Za-z]+$/
   | filter userIdentity.principalId like /(?i):<lower-cased username>$/
   | sort eventTime asc
   | limit 10000
   ```

   The `like` filters are anchored regexes (with `<role>` and `<username>`
   regex-escaped), so other users' and permission sets' events never match; a plain
   `like "<string>"` is a substring match and would leak events such as `:janet` for
   `:jane` or `AWSReservedSSO_Admin_Extra_…` for `Admin`. `tolower()` cannot be used inside a Logs Insights `filter … like` (it matches nothing), so the principal match uses a case-insensitive regex.
3. Poll `GetQueryResults` every 1 s (bounded by the Lambda timeout) until `Complete`;
   on `Failed | Cancelled | Timeout | Unknown` throw so the stream retries, without
   writing. If the Lambda runs out of time while the query is still running, write the
   `queryId` anyway (`teamqueryLogs` returns `[]` until the query completes).
4. Write `queryId` back with the existing SigV4-signed AppSync `updateSessions` call.

**`teamqueryLogs`** (AppSync `getLogs(queryId)`):

- `GetQueryResults(queryId)`; map each row's `[{field, value}]` to an object, dropping
  `@ptr`; return the array. Same `Logs` GraphQL type. Results remain retrievable for
  7 days (same as CloudTrail Lake).

**IAM** (`custom-policies.json`, static ARNs only): `teamgetLogs` → `logs:StartQuery` on
`arn:aws:logs:*:*:log-group:team-audit-*`, `logs:GetQueryResults` on `*`;
`teamqueryLogs` → `logs:GetQueryResults` on `*` (the action does not support
resource-level permissions).

### Wiring and cleanup

- Rename the custom category `cloudtrailLake` → `auditLogs` in
  `amplify/backend/backend-config.json`,
  `amplify/backend/types/amplify-dependent-resources-ref.d.ts`, and the two function
  `teamgetLogs` CloudFormation template (parameter `customauditLogsAuditLogGroupName`);
  remove the dependency, parameter and environment variable from `teamqueryLogs`.
- `parameters.js`: write `amplify/backend/custom/auditLogs/parameters.json`
  (`CloudTrailAuditLogs`, `OrganizationId`, optional `SourceRegions`); drop the
  duplicated `update_cloudtrail_parameters` function.
- `deployment/template.yml`: `CloudTrailAuditLogs` `AllowedPattern` becomes
  `^(read_write|read|write|none)?$`, description updated. `AUDIT_LOG_REGIONS` is an
  optional Amplify environment variable read by `parameters.js` (no stack parameter).
- `deployment/parameters-template.sh`, `parameters-mgmt-template.sh`: example values
  updated (`CLOUDTRAIL_AUDIT_LOGS=read`).
- UI `src/components/Navigation/ToolsDrawer.js`: "AWS CloudTrail Lake" →
  "Amazon CloudWatch Logs".
- Docs: architecture, prerequisites, deployment process, cost, security, approver and
  walkthrough pages; `changelog.md` entry.
- `docs/_config.yml`: exclude `superpowers/` from the Jekyll site.

## Error handling

- Invalid session input in `teamgetLogs` → log and return without querying (never build
  a query from unvalidated input).
- `StartQuery` / `GetQueryResults` errors → log with session id and rethrow so the
  DynamoDB stream retries per its configured policy.
- Query terminal failure states (`Failed`, `Cancelled`, `Timeout`, `Unknown`) → log and
  throw so the DynamoDB stream retries; no `queryId` is written.
- Lambda out of time while the query is still running → write the `queryId` anyway and
  log it; `teamqueryLogs` returns `[]` while the query runs and the session-logs page
  re-reads by `queryId` on refresh.
- `teamqueryLogs` with an expired/unknown `queryId` → return `[]` and log.

## Testing and verification

1. Unit tests (`node --test`, no new dependencies) for query construction, input
   validation/escaping, and result-row mapping.
2. `cfn-lint` on the new custom template and the edited function templates.
3. Org setup in the organization management account (explicit confirmation before each
   org-level change).
4. Deploy TEAM to a member TEAM account that is the IAM Identity Center delegated
   administrator, in the IAM Identity Center Region, from the GitHub fork, using a
   fine-grained PAT stored in Secrets Manager by the user.
5. End to end: request → approve → perform API calls in a target account → confirm the
   events appear on the session logs page; confirm `@aws.account`/`@aws.region` in the
   central log group.

## Risks and items to confirm during implementation

- **Exact managed log group names** (`aws/cloudtrail/<event-types>`): the selection
  criteria uses a prefix, so the exact suffix does not matter; confirm after first
  delivery.
- **Centralization `Scope` syntax**: confirm `OrganizationId = '<o-id>'` is accepted.
- **Region coverage**: the centralization rule needs an explicit Region list; Regions
  where centralization is unavailable are dropped from the default list after checking.
  Global-service events (IAM, STS) arrive in `us-east-1`, which is included.
- **Rule conflicts**: an existing organization-level CloudTrail telemetry rule would
  conflict; none exists in the target org today.
- **Latency**: initial discovery can take up to 24 h; steady state is minutes.
- **Cost**: CloudTrail service-linked-channel delivery charges + CloudWatch Logs
  ingestion per account + centralized copy and storage.
- **Upgrades of existing deployments**: removing `cloudtrailLake` deletes the old EDS
  (termination protection is off). Operators must export EDS data to CloudWatch first;
  documented in the changelog and deployment docs.
