# CloudWatch Audit Logs (CloudTrail Lake replacement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TEAM's CloudTrail Lake event data store with CloudTrail events ingested into Amazon CloudWatch Logs (organization telemetry rule + centralization rule), keeping the session-logs `queryId` flow unchanged, then deploy and verify end to end.

**Architecture:** An Amplify custom CloudFormation resource `auditLogs` creates an organization-wide CloudWatch telemetry enablement rule for CloudTrail management events, a centralization rule that copies every account's `aws/cloudtrail/*` log groups into one log group in the TEAM account, and that destination log group. `teamgetLogs` runs a Logs Insights query per session and stores the `queryId`; `teamqueryLogs` returns `GetQueryResults` rows in the existing GraphQL `Logs` shape.

**Tech Stack:** AWS Amplify Gen 1 (CLI 14), CloudFormation (`AWS::ObservabilityAdmin::*`, `AWS::Logs::LogGroup`), Node.js 22 Lambdas, `@aws-sdk/client-cloudwatch-logs`, `node:test`, bash deployment scripts, cfn-lint.

**Spec:** `docs/superpowers/specs/2026-10-14-cloudwatch-audit-logs-design.md`

## Global Constraints

- Lambda runtime stays `nodejs22.x`; tests use the built-in `node --test` (Node ≥ 22). No new test dependencies.
- New SDK dependency: `@aws-sdk/client-cloudwatch-logs` `^3.1151.0`; remove `@aws-sdk/client-cloudtrail` from both log Lambdas.
- Lambda lockfiles stay yarn v1: regenerate with `npx --yes yarn@1.22.22 install` inside the function `src/` directory.
- Central log group name: `team-audit-<env>-cloudtrail` (Amplify env `main` → `team-audit-main-cloudtrail`).
- `CLOUDTRAIL_AUDIT_LOGS` accepts exactly `read | write | read_write | none` (empty means `read_write` in `deployment/template.yml`). EDS ARNs are no longer accepted.
- Retention: member-account managed log groups 7 days (`SourceRetentionInDays`), central log group 30 days (`AuditLogRetentionInDays`).
- Default centralization source Regions: `ap-northeast-1,ap-northeast-2,ap-northeast-3,ap-south-1,ap-southeast-1,ap-southeast-2,ca-central-1,eu-central-1,eu-north-1,eu-west-1,eu-west-2,eu-west-3,sa-east-1,us-east-1,us-east-2,us-west-1,us-west-2`.
- IAM: `teamgetLogs` gets `logs:StartQuery` on `arn:aws:logs:*:*:log-group:team-audit-*` and `logs:GetQueryResults` on `*`; `teamqueryLogs` gets `logs:GetQueryResults` on `*`.
- Username and role values in queries must match `^[A-Za-z0-9_+=,.@-]+$`; account IDs `^\d{12}$`.
- Target environment: TEAM account `<TEAM_ACCOUNT_ID>` (profile `<TEAM_PROFILE>`), Region `<REGION>`; organization `<ORG_ID>`, management account `<MGMT_ACCOUNT_ID>`; IAM Identity Center instance `<IDC_INSTANCE_ID>`, identity store `<IDENTITY_STORE_ID>`. The real values live in the operator's git-ignored `deployment/parameters.sh` and local notes, not in this public repo.
- **Every live AWS change in the management account, every org-level change, every `git push`, and every PR/merge on GitHub requires explicit user confirmation immediately before it runs.** Use read-only calls otherwise.
- GitHub operations target the fork only: always pass `--repo debojitroy/iam-identity-center-team`. Never open PRs against `aws-samples`.
- Commits: conventional commits `<type>: <description>`; inclusive language in code, comments and docs.
- New source files start with the same copyright header style as their neighbours.

---

## File Map

| File | Responsibility | Task |
| --- | --- | --- |
| `package.json` | add `test:lambdas` script | 1, 4 |
| `amplify/backend/function/teamgetLogs/src/query.js` (new) | validate session image, build Logs Insights query, terminal statuses | 1 |
| `amplify/backend/function/teamgetLogs/test/query.test.mjs` (new) | unit tests for `query.js` | 1 |
| `amplify/backend/function/teamgetLogs/src/appsync.js` (new) | SigV4 AppSync `updateSessions` mutation | 2 |
| `amplify/backend/function/teamgetLogs/src/index.js` | stream handler: StartQuery → poll → save `queryId` | 2 |
| `amplify/backend/function/teamgetLogs/test/handler.test.mjs` (new) | handler tests with fake clients | 2 |
| `amplify/backend/function/teamgetLogs/{custom-policies.json,src/package.json,src/yarn.lock}` | IAM + deps | 2 |
| `amplify/backend/function/teamqueryLogs/src/results.js` (new) | map `GetQueryResults` rows | 3 |
| `amplify/backend/function/teamqueryLogs/src/index.js` | AppSync resolver | 3 |
| `amplify/backend/function/teamqueryLogs/test/*.test.mjs` (new) | tests | 3 |
| `amplify/backend/function/teamqueryLogs/{custom-policies.json,src/package.json,src/yarn.lock}` | IAM + deps | 3 |
| `amplify/backend/custom/auditLogs/*` (new) | telemetry rule, centralization rule, log group | 4 |
| `amplify/backend/custom/cloudtrailLake/` (delete) | old EDS | 4 |
| `amplify/backend/backend-config.json`, `amplify/backend/types/amplify-dependent-resources-ref.d.ts`, both function CFN templates | Amplify wiring | 2, 3, 4 |
| `tests/audit-logs-wiring.test.mjs` (new) | wiring consistency tests | 4 |
| `parameters.js`, `tests/parameters.test.mjs` (new) | build-time parameters for `auditLogs` | 5 |
| `deployment/audit-logs-prereqs.sh` (new), `init.sh`, `deploy.sh`, `update.sh`, `template.yml`, `parameters-template.sh`, `parameters-mgmt-template.sh` | deployment | 6 |
| `src/components/Navigation/ToolsDrawer.js`, `docs/docs/**`, `changelog.md` | UI text + docs | 7 |

---

### Task 1: Session query builder for `teamgetLogs`

**Files:**
- Create: `amplify/backend/function/teamgetLogs/src/query.js`
- Create: `amplify/backend/function/teamgetLogs/test/query.test.mjs`
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Produces (ESM, `src/query.js`):
  - `parseSessionImage(image: DynamoDBImage) → { id: string, accountId: string, role: string, username: string, startTime: number, endTime: number }` — epoch seconds; throws `Error` on invalid input.
  - `buildSessionQuery({ accountId, role, username }) → string` — Logs Insights query.
  - `isTerminalStatus(status: string) → boolean`
  - `MAX_RESULTS = 10000`

- [ ] **Step 1: Add the test script**

In `package.json`, add to `"scripts"` (keep the existing entries):

```json
    "test:lambdas": "node --test \"amplify/backend/function/*/test/*.test.mjs\""
```

- [ ] **Step 2: Write the failing tests**

Create `amplify/backend/function/teamgetLogs/test/query.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionImage, buildSessionQuery, isTerminalStatus, MAX_RESULTS } from "../src/query.js";

const image = {
  id: { S: "session-1" },
  startTime: { S: "2026-10-14T01:00:00.000Z" },
  endTime: { S: "2026-10-14T02:00:00.400Z" },
  username: { S: "idc_Jane.Doe+ops@example.com" },
  accountId: { S: "123456789012" },
  role: { S: "AdministratorAccess" },
};
const withField = (field, value) => ({ ...image, [field]: { S: value } });

test("parseSessionImage returns the session window in epoch seconds", () => {
  assert.deepEqual(parseSessionImage(image), {
    id: "session-1",
    accountId: "123456789012",
    role: "AdministratorAccess",
    username: "Jane.Doe+ops@example.com",
    startTime: 1791939600,
    endTime: 1791943201,
  });
});

test("parseSessionImage only strips a leading idc_ prefix", () => {
  assert.equal(parseSessionImage(withField("username", "ops_idc_user")).username, "ops_idc_user");
});

test("parseSessionImage rejects a missing id", () => {
  const { id, ...rest } = image;
  assert.throws(() => parseSessionImage(rest), /no id/);
});

test("parseSessionImage rejects account IDs that are not 12 digits", () => {
  assert.throws(() => parseSessionImage(withField("accountId", "12345")), /invalid accountId/);
});

test("parseSessionImage rejects roles that could break out of the query", () => {
  assert.throws(() => parseSessionImage(withField("role", 'Admin" | display @message')), /invalid role/);
});

test("parseSessionImage rejects usernames outside the IAM Identity Center character set", () => {
  assert.throws(() => parseSessionImage(withField("username", "idc_jane\ndoe")), /invalid username/);
  assert.throws(() => parseSessionImage(withField("username", 'idc_jane"doe')), /invalid username/);
});

test("parseSessionImage rejects unparseable or inverted session windows", () => {
  assert.throws(() => parseSessionImage(withField("startTime", "yesterday")), /invalid session window/);
  assert.throws(() => parseSessionImage(withField("endTime", "2026-10-14T00:00:00.000Z")), /invalid session window/);
});

test("buildSessionQuery filters by account, permission set role and lower-cased principal", () => {
  const query = buildSessionQuery({ accountId: "123456789012", role: "AdministratorAccess", username: "Jane.Doe+ops@example.com" });
  assert.equal(
    query,
    [
      "fields eventID, eventName, eventSource, eventTime",
      '| filter recipientAccountId = "123456789012"',
      '| filter userIdentity.sessionContext.sessionIssuer.arn like "AWSReservedSSO_AdministratorAccess_"',
      '| filter tolower(userIdentity.principalId) like ":jane.doe+ops@example.com"',
      "| sort eventTime asc",
      `| limit ${MAX_RESULTS}`,
    ].join("\n"),
  );
});

test("isTerminalStatus is true only for finished query states", () => {
  for (const status of ["Complete", "Failed", "Cancelled", "Timeout", "Unknown"]) {
    assert.equal(isTerminalStatus(status), true, status);
  }
  for (const status of ["Scheduled", "Running", undefined]) {
    assert.equal(isTerminalStatus(status), false, String(status));
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:lambdas`
Expected: FAIL — `Cannot find module .../teamgetLogs/src/query.js`.

- [ ] **Step 4: Implement `query.js`**

Create `amplify/backend/function/teamgetLogs/src/query.js`:

```js
//  © 2026 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
//  This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
//  http: // aws.amazon.com/agreement or other written agreement between Customer and either
//  Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.

const ACCOUNT_ID_PATTERN = /^\d{12}$/;
// Characters allowed in IAM Identity Center user names and permission set names.
// Rejecting everything else means no value can break out of the query string.
const IDENTITY_PATTERN = /^[A-Za-z0-9_+=,.@-]+$/;
const USERNAME_PREFIX = "idc_";
const TERMINAL_STATUSES = new Set(["Complete", "Failed", "Cancelled", "Timeout", "Unknown"]);

export const MAX_RESULTS = 10000;

const toEpochSeconds = (isoTime, round) => round(Date.parse(isoTime) / 1000);

export function parseSessionImage(image) {
  const id = image?.id?.S;
  if (!id) throw new Error("Session record has no id");

  const accountId = image.accountId?.S ?? "";
  const role = image.role?.S ?? "";
  const rawUsername = image.username?.S ?? "";
  const username = rawUsername.startsWith(USERNAME_PREFIX)
    ? rawUsername.slice(USERNAME_PREFIX.length)
    : rawUsername;
  const startTime = toEpochSeconds(image.startTime?.S, Math.floor);
  const endTime = toEpochSeconds(image.endTime?.S, Math.ceil);

  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error(`Session ${id}: invalid accountId`);
  if (!IDENTITY_PATTERN.test(role)) throw new Error(`Session ${id}: invalid role`);
  if (!IDENTITY_PATTERN.test(username)) throw new Error(`Session ${id}: invalid username`);
  // NaN comparisons are false, so this also rejects unparseable times.
  if (!(endTime > startTime)) throw new Error(`Session ${id}: invalid session window`);

  return { id, accountId, role, username, startTime, endTime };
}

export function buildSessionQuery({ accountId, role, username }) {
  return [
    "fields eventID, eventName, eventSource, eventTime",
    `| filter recipientAccountId = "${accountId}"`,
    `| filter userIdentity.sessionContext.sessionIssuer.arn like "AWSReservedSSO_${role}_"`,
    `| filter tolower(userIdentity.principalId) like ":${username.toLowerCase()}"`,
    "| sort eventTime asc",
    `| limit ${MAX_RESULTS}`,
  ].join("\n");
}

export const isTerminalStatus = (status) => TERMINAL_STATUSES.has(status);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:lambdas`
Expected: PASS — 9 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add package.json amplify/backend/function/teamgetLogs/src/query.js amplify/backend/function/teamgetLogs/test/query.test.mjs
git commit -m "feat: add Logs Insights session query builder for teamgetLogs"
```

---

### Task 2: `teamgetLogs` handler on CloudWatch Logs Insights

**Files:**
- Create: `amplify/backend/function/teamgetLogs/src/appsync.js`
- Rewrite: `amplify/backend/function/teamgetLogs/src/index.js`
- Create: `amplify/backend/function/teamgetLogs/test/handler.test.mjs`
- Modify: `amplify/backend/function/teamgetLogs/src/package.json`, regenerate `src/yarn.lock`
- Modify: `amplify/backend/function/teamgetLogs/custom-policies.json`
- Modify: `amplify/backend/function/teamgetLogs/teamgetLogs-cloudformation-template.json` (`CustomLambdaExecutionPolicy` only)

**Interfaces:**
- Consumes: `parseSessionImage`, `buildSessionQuery`, `isTerminalStatus` from Task 1.
- Produces:
  - `src/appsync.js`: `updateSessionQueryId({ endpoint: string, region: string, id: string, queryId: string }) → Promise<object>`; throws on HTTP or GraphQL errors.
  - `src/index.js`: `createHandler({ logsClient: { send(command) }, logGroupName: string, saveQueryId(id, queryId): Promise, wait?(ms): Promise }) → (event, context) => Promise<void>`; `handler` (default wiring, reads env `REGION`, `AUDIT_LOG_GROUP`, `API_TEAM_GRAPHQLAPIENDPOINTOUTPUT`).

- [ ] **Step 1: Swap the SDK dependency and install**

In `amplify/backend/function/teamgetLogs/src/package.json`, replace the line `"@aws-sdk/client-cloudtrail": "^3.777.0",` with:

```json
    "@aws-sdk/client-cloudwatch-logs": "^3.1151.0",
```

Then run:

```bash
cd amplify/backend/function/teamgetLogs/src && npx --yes yarn@1.22.22 install && cd -
```

Expected: `yarn.lock` updated, `node_modules/` created (ignored by `.gitignore`). Confirm with `git status --short amplify/backend/function/teamgetLogs` — only `package.json` and `yarn.lock` are modified.

- [ ] **Step 2: Write the failing handler tests**

Create `amplify/backend/function/teamgetLogs/test/handler.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/index.js";

const LOG_GROUP = "team-audit-test-cloudtrail";
const image = (overrides = {}) => ({
  id: { S: "session-1" },
  startTime: { S: "2026-10-14T01:00:00.000Z" },
  endTime: { S: "2026-10-14T02:00:00.000Z" },
  username: { S: "idc_jane@example.com" },
  accountId: { S: "123456789012" },
  role: { S: "ReadOnlyAccess" },
  ...overrides,
});
const streamEvent = (...images) => ({ Records: images.map((NewImage) => ({ dynamodb: { NewImage } })) });
const context = (remainingMs = 60000) => ({ getRemainingTimeInMillis: () => remainingMs });

function fakeLogsClient(statuses = ["Complete"], { startError } = {}) {
  const calls = [];
  const pending = [...statuses];
  let started = 0;
  return {
    calls,
    async send(command) {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });
      if (name === "StartQueryCommand") {
        if (startError) throw startError;
        started += 1;
        return { queryId: `q-${started}` };
      }
      return { status: pending.shift() ?? "Running" };
    },
  };
}

function setup(statuses, options) {
  const logsClient = fakeLogsClient(statuses, options);
  const saved = [];
  const waits = [];
  const handler = createHandler({
    logsClient,
    logGroupName: LOG_GROUP,
    saveQueryId: async (id, queryId) => saved.push({ id, queryId }),
    wait: async (ms) => waits.push(ms),
  });
  return { handler, logsClient, saved, waits };
}

test("starts a query over the session window and saves the queryId once complete", async () => {
  const { handler, logsClient, saved, waits } = setup(["Running", "Complete"]);

  await handler(streamEvent(image()), context());

  const start = logsClient.calls[0];
  assert.equal(start.name, "StartQueryCommand");
  assert.deepEqual(start.input.logGroupIdentifiers, [LOG_GROUP]);
  assert.equal(start.input.startTime, 1791939600);
  assert.equal(start.input.endTime, 1791943200);
  assert.match(start.input.queryString, /recipientAccountId = "123456789012"/);
  assert.deepEqual(logsClient.calls.slice(1).map((c) => c.input), [{ queryId: "q-1" }, { queryId: "q-1" }]);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(saved, [{ id: "session-1", queryId: "q-1" }]);
});

test("does not save the queryId when the query fails", async () => {
  const { handler, saved } = setup(["Failed"]);
  await handler(streamEvent(image()), context());
  assert.deepEqual(saved, []);
});

test("skips invalid session records without calling CloudWatch", async () => {
  const { handler, logsClient, saved } = setup();
  await handler(streamEvent(image({ accountId: { S: "not-an-account" } })), context());
  assert.deepEqual(logsClient.calls, []);
  assert.deepEqual(saved, []);
});

test("processes every record in the batch", async () => {
  const { handler, saved } = setup(["Complete", "Complete"]);
  await handler(streamEvent(image(), image({ id: { S: "session-2" } })), context());
  assert.deepEqual(saved, [
    { id: "session-1", queryId: "q-1" },
    { id: "session-2", queryId: "q-2" },
  ]);
});

test("stops polling when the Lambda is about to time out", async () => {
  const { handler, logsClient, saved } = setup(["Running"]);
  await handler(streamEvent(image()), context(1000));
  assert.deepEqual(logsClient.calls.map((c) => c.name), ["StartQueryCommand"]);
  assert.deepEqual(saved, []);
});

test("propagates StartQuery errors so the stream retries", async () => {
  const { handler } = setup([], { startError: new Error("throttled") });
  await assert.rejects(handler(streamEvent(image()), context()), /throttled/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:lambdas`
Expected: FAIL — `handler.test.mjs` cannot load `../src/index.js` (the old handler imports the removed `@aws-sdk/client-cloudtrail` and has no `createHandler` export).

- [ ] **Step 4: Move the AppSync mutation into `appsync.js`**

Create `amplify/backend/function/teamgetLogs/src/appsync.js`:

```js
//  © 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
//  This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
//  http: // aws.amazon.com/agreement or other written agreement between Customer and either
//  Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
import crypto from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { default as fetch, Request } from 'node-fetch';

const { Sha256 } = crypto;

const UPDATE_SESSIONS = /* GraphQL */ `
  mutation UpdateSessions(
    $input: UpdateSessionsInput!
    $condition: ModelSessionsConditionInput
  ) {
    updateSessions(input: $input, condition: $condition) {
      id
      startTime
      endTime
      username
      accountId
      role
      approver_ids
      queryId
      createdAt
      updatedAt
      owner
    }
  }
`;

export async function updateSessionQueryId({ endpoint, region, id, queryId }) {
  const url = new URL(endpoint);
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region,
    service: 'appsync',
    sha256: Sha256
  });

  const signed = await signer.sign(new HttpRequest({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      host: url.host
    },
    hostname: url.host,
    body: JSON.stringify({ query: UPDATE_SESSIONS, variables: { input: { id, queryId } } }),
    path: url.pathname
  }));

  const response = await fetch(new Request(url, signed));
  const body = await response.json();
  if (!response.ok || body.errors) {
    throw new Error(`updateSessions failed for session ${id}: ${JSON.stringify(body.errors ?? response.status)}`);
  }
  return body.data.updateSessions;
}
```

- [ ] **Step 5: Rewrite `index.js`**

Replace the full contents of `amplify/backend/function/teamgetLogs/src/index.js` with:

```js
//  © 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
//  This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
//  http: // aws.amazon.com/agreement or other written agreement between Customer and either
//  Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.

/* Amplify Params - DO NOT EDIT
	API_TEAM_GRAPHQLAPIENDPOINTOUTPUT
	API_AWSPIM_GRAPHQLAPIIDOUTPUT
	ENV
	REGION
Amplify Params - DO NOT EDIT */
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { parseSessionImage, buildSessionQuery, isTerminalStatus } from './query.js';
import { updateSessionQueryId } from './appsync.js';

const POLL_INTERVAL_MS = 1000;
// Stop polling while there is still time left to write the result back.
const MIN_REMAINING_MS = 5000;

export function createHandler({ logsClient, logGroupName, saveQueryId, wait = sleep }) {
  async function waitForQuery(queryId, context) {
    while (context.getRemainingTimeInMillis() > MIN_REMAINING_MS) {
      const { status } = await logsClient.send(new GetQueryResultsCommand({ queryId }));
      if (isTerminalStatus(status)) return status;
      await wait(POLL_INTERVAL_MS);
    }
    return "Timeout";
  }

  async function processRecord(record, context) {
    let session;
    try {
      session = parseSessionImage(record.dynamodb?.NewImage);
    } catch (err) {
      console.error("Skipping session record:", err.message);
      return;
    }

    const { queryId } = await logsClient.send(new StartQueryCommand({
      logGroupIdentifiers: [logGroupName],
      startTime: session.startTime,
      endTime: session.endTime,
      queryString: buildSessionQuery(session),
    }));

    const status = await waitForQuery(queryId, context);
    if (status !== "Complete") {
      console.error(`Query ${queryId} for session ${session.id} ended with status ${status}`);
      return;
    }
    await saveQueryId(session.id, queryId);
    console.log(`Query ${queryId} finished for session ${session.id}`);
  }

  return async (event, context) => {
    for (const record of event.Records ?? []) {
      await processRecord(record, context);
    }
  };
}

const REGION = process.env.REGION;

export const handler = createHandler({
  logsClient: new CloudWatchLogsClient({ region: REGION }),
  logGroupName: process.env.AUDIT_LOG_GROUP,
  saveQueryId: (id, queryId) => updateSessionQueryId({
    endpoint: process.env.API_TEAM_GRAPHQLAPIENDPOINTOUTPUT,
    region: REGION,
    id,
    queryId,
  }),
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:lambdas`
Expected: PASS — 15 tests (9 query + 6 handler), 0 failures.

- [ ] **Step 7: Update IAM for `teamgetLogs`**

Replace the contents of `amplify/backend/function/teamgetLogs/custom-policies.json` with:

```json
[
  {
    "Action": ["logs:StartQuery"],
    "Resource": ["arn:aws:logs:*:*:log-group:team-audit-*"]
  },
  {
    "Action": ["logs:GetQueryResults"],
    "Resource": ["*"]
  }
]
```

Mirror it in the CloudFormation template (Amplify regenerates this resource from `custom-policies.json`, so both must agree):

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("amplify/backend/function/teamgetLogs/teamgetLogs-cloudformation-template.json")
t = json.loads(p.read_text())
t["Resources"]["CustomLambdaExecutionPolicy"]["Properties"]["PolicyDocument"]["Statement"] = [
    {"Action": ["logs:StartQuery"], "Resource": ["arn:aws:logs:*:*:log-group:team-audit-*"], "Effect": "Allow"},
    {"Action": ["logs:GetQueryResults"], "Resource": ["*"], "Effect": "Allow"},
]
p.write_text(json.dumps(t, indent=2) + "\n")
PY
git diff --stat amplify/backend/function/teamgetLogs/teamgetLogs-cloudformation-template.json
```

Expected: only the policy statement lines change (if `git diff` shows whole-file reformatting, re-run with `indent=1` to match the original indentation and confirm the diff is limited to the policy).

- [ ] **Step 8: Commit**

```bash
git add amplify/backend/function/teamgetLogs package.json
git commit -m "feat: query session audit logs with CloudWatch Logs Insights in teamgetLogs"
```

---

### Task 3: `teamqueryLogs` on CloudWatch Logs Insights

**Files:**
- Create: `amplify/backend/function/teamqueryLogs/src/results.js`
- Rewrite: `amplify/backend/function/teamqueryLogs/src/index.js`
- Create: `amplify/backend/function/teamqueryLogs/test/results.test.mjs`, `amplify/backend/function/teamqueryLogs/test/handler.test.mjs`
- Modify: `amplify/backend/function/teamqueryLogs/src/package.json`, regenerate `src/yarn.lock`
- Modify: `amplify/backend/function/teamqueryLogs/custom-policies.json`
- Modify: `amplify/backend/function/teamqueryLogs/teamqueryLogs-cloudformation-template.json` (`CustomLambdaExecutionPolicy` only)

**Interfaces:**
- Produces (CommonJS):
  - `src/results.js`: `mapQueryResults(rows?: Array<Array<{ field: string, value: string }>>) → Array<Record<string, string>>` (drops `@ptr`).
  - `src/index.js`: `createHandler({ logsClient }) → (event) => Promise<Array<Record<string,string>>>`; `handler`.

- [ ] **Step 1: Swap the SDK dependency and install**

In `amplify/backend/function/teamqueryLogs/src/package.json`, replace `"@aws-sdk/client-cloudtrail": "^3.777.0"` with `"@aws-sdk/client-cloudwatch-logs": "^3.1151.0"`, then:

```bash
cd amplify/backend/function/teamqueryLogs/src && npx --yes yarn@1.22.22 install && cd -
```

Expected: `git status --short amplify/backend/function/teamqueryLogs` shows only `package.json` and `yarn.lock` modified.

- [ ] **Step 2: Write the failing tests**

Create `amplify/backend/function/teamqueryLogs/test/results.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import results from "../src/results.js";

const { mapQueryResults } = results;

test("mapQueryResults turns field/value rows into objects without @ptr", () => {
  const rows = [
    [
      { field: "eventID", value: "e-1" },
      { field: "eventName", value: "ListBuckets" },
      { field: "eventSource", value: "s3.amazonaws.com" },
      { field: "eventTime", value: "2026-10-14T01:05:00Z" },
      { field: "@ptr", value: "opaque" },
    ],
  ];
  assert.deepEqual(mapQueryResults(rows), [
    { eventID: "e-1", eventName: "ListBuckets", eventSource: "s3.amazonaws.com", eventTime: "2026-10-14T01:05:00Z" },
  ]);
});

test("mapQueryResults returns an empty list when there are no rows", () => {
  assert.deepEqual(mapQueryResults(undefined), []);
  assert.deepEqual(mapQueryResults([]), []);
});
```

Create `amplify/backend/function/teamqueryLogs/test/handler.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import queryLogs from "../src/index.js";

const { createHandler } = queryLogs;

const clientReturning = (response) => {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command.input);
      if (response instanceof Error) throw response;
      return response;
    },
  };
};
const namedError = (name) => Object.assign(new Error(name), { name });

test("returns mapped rows for a completed query", async () => {
  const logsClient = clientReturning({ status: "Complete", results: [[{ field: "eventID", value: "e-1" }]] });
  const rows = await createHandler({ logsClient })({ arguments: { queryId: "q-1" } });
  assert.deepEqual(logsClient.calls, [{ queryId: "q-1" }]);
  assert.deepEqual(rows, [{ eventID: "e-1" }]);
});

test("returns no rows while the query is still running", async () => {
  const logsClient = clientReturning({ status: "Running", results: [] });
  assert.deepEqual(await createHandler({ logsClient })({ arguments: { queryId: "q-1" } }), []);
});

test("returns no rows without calling CloudWatch when queryId is missing", async () => {
  const logsClient = clientReturning({ status: "Complete", results: [] });
  assert.deepEqual(await createHandler({ logsClient })({ arguments: {} }), []);
  assert.deepEqual(logsClient.calls, []);
});

test("returns no rows for expired or unknown query IDs", async () => {
  for (const name of ["ResourceNotFoundException", "InvalidParameterException"]) {
    const logsClient = clientReturning(namedError(name));
    assert.deepEqual(await createHandler({ logsClient })({ arguments: { queryId: "q-old" } }), [], name);
  }
});

test("rethrows unexpected errors", async () => {
  const logsClient = clientReturning(namedError("ServiceUnavailableException"));
  await assert.rejects(createHandler({ logsClient })({ arguments: { queryId: "q-1" } }), /ServiceUnavailableException/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:lambdas`
Expected: FAIL — `Cannot find module .../teamqueryLogs/src/results.js`, and `handler.test.mjs` cannot load the old `index.js` (removed `@aws-sdk/client-cloudtrail`).

- [ ] **Step 4: Implement `results.js` and the handler**

Create `amplify/backend/function/teamqueryLogs/src/results.js`:

```js
//  © 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
//  This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
//  http: // aws.amazon.com/agreement or other written agreement between Customer and either
//  Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.

// Logs Insights adds an opaque pointer to every row; the UI has no use for it.
const POINTER_FIELD = "@ptr";

function mapQueryResults(rows = []) {
  return rows.map((row) =>
    Object.fromEntries(
      row
        .filter(({ field }) => field !== POINTER_FIELD)
        .map(({ field, value }) => [field, value])
    )
  );
}

module.exports = { mapQueryResults };
```

Replace the full contents of `amplify/backend/function/teamqueryLogs/src/index.js` with:

```js
//  © 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
//  This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
//  http: // aws.amazon.com/agreement or other written agreement between Customer and either
//  Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
const {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
} = require("@aws-sdk/client-cloudwatch-logs");
const { mapQueryResults } = require("./results");

// Logs Insights keeps query results for 7 days; older or unknown IDs return these errors.
const EXPIRED_QUERY_ERRORS = new Set(["ResourceNotFoundException", "InvalidParameterException"]);

function createHandler({ logsClient }) {
  return async (event) => {
    const queryId = event?.arguments?.queryId;
    if (!queryId) return [];

    try {
      const { status, results } = await logsClient.send(new GetQueryResultsCommand({ queryId }));
      if (status !== "Complete") {
        console.warn(`Query ${queryId} is ${status}; returning no rows`);
        return [];
      }
      return mapQueryResults(results);
    } catch (err) {
      if (EXPIRED_QUERY_ERRORS.has(err.name)) {
        console.warn(`Query ${queryId} is unavailable: ${err.message}`);
        return [];
      }
      throw err;
    }
  };
}

const handler = createHandler({
  logsClient: new CloudWatchLogsClient({ region: process.env.REGION }),
});

module.exports = { handler, createHandler };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:lambdas`
Expected: PASS — 22 tests, 0 failures.

- [ ] **Step 6: Update IAM for `teamqueryLogs`**

Replace `amplify/backend/function/teamqueryLogs/custom-policies.json` with:

```json
[
  {
    "Action": ["logs:GetQueryResults"],
    "Resource": ["*"]
  }
]
```

Mirror it in the template:

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("amplify/backend/function/teamqueryLogs/teamqueryLogs-cloudformation-template.json")
t = json.loads(p.read_text())
t["Resources"]["CustomLambdaExecutionPolicy"]["Properties"]["PolicyDocument"]["Statement"] = [
    {"Action": ["logs:GetQueryResults"], "Resource": ["*"], "Effect": "Allow"},
]
p.write_text(json.dumps(t, indent=2) + "\n")
PY
git diff --stat amplify/backend/function/teamqueryLogs/teamqueryLogs-cloudformation-template.json
```

Expected: only the policy lines change (match the original indentation as in Task 2 Step 7).

- [ ] **Step 7: Commit**

```bash
git add amplify/backend/function/teamqueryLogs
git commit -m "feat: read session audit log results from CloudWatch Logs Insights"
```

---

### Task 4: `auditLogs` custom resource and Amplify wiring

**Files:**
- Create: `amplify/backend/custom/auditLogs/auditLogs-cloudformation-template.json`
- Create: `amplify/backend/custom/auditLogs/parameters.json`
- Delete: `amplify/backend/custom/cloudtrailLake/` (both files)
- Modify: `amplify/backend/backend-config.json`
- Modify: `amplify/backend/types/amplify-dependent-resources-ref.d.ts`
- Modify: `amplify/backend/function/teamgetLogs/teamgetLogs-cloudformation-template.json` (parameter + env)
- Modify: `amplify/backend/function/teamqueryLogs/teamqueryLogs-cloudformation-template.json` (remove parameter + env)
- Create: `tests/audit-logs-wiring.test.mjs`
- Modify: `package.json` (`test:lambdas` glob)

**Interfaces:**
- Consumes: env var name `AUDIT_LOG_GROUP` read by `teamgetLogs` (Task 2).
- Produces: custom resource `auditLogs` with output `AuditLogGroupName`; Amplify parameter `customauditLogsAuditLogGroupName` on `teamgetLogs`; template parameters `CloudTrailAuditLogs`, `OrganizationId`, `SourceRegions`, `SourceRetentionInDays`, `AuditLogRetentionInDays` (Task 5 writes the first three).

- [ ] **Step 1: Record the cfn-lint baseline**

Run: `cfn-lint amplify/backend/function/teamgetLogs/teamgetLogs-cloudformation-template.json amplify/backend/function/teamqueryLogs/teamqueryLogs-cloudformation-template.json > /tmp/cfnlint-baseline.txt; cat /tmp/cfnlint-baseline.txt`
Expected: any pre-existing findings are saved; later steps must not add new ones.

- [ ] **Step 2: Widen the test glob**

In `package.json`, change the `test:lambdas` script to:

```json
    "test:lambdas": "node --test \"amplify/backend/function/*/test/*.test.mjs\" \"tests/*.test.mjs\""
```

- [ ] **Step 3: Write the failing wiring tests**

Create `tests/audit-logs-wiring.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const repoPath = (path) => new URL(`../${path}`, import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(repoPath(path), "utf8"));

const backendConfig = readJson("amplify/backend/backend-config.json");
const auditTemplatePath = "amplify/backend/custom/auditLogs/auditLogs-cloudformation-template.json";
const getLogsTemplate = readJson("amplify/backend/function/teamgetLogs/teamgetLogs-cloudformation-template.json");
const queryLogsTemplate = readJson("amplify/backend/function/teamqueryLogs/teamqueryLogs-cloudformation-template.json");
const envVars = (template) => template.Resources.LambdaFunction.Properties.Environment.Variables;

test("the CloudTrail Lake custom resource is removed", () => {
  assert.equal(backendConfig.custom.cloudtrailLake, undefined);
  assert.equal(existsSync(repoPath("amplify/backend/custom/cloudtrailLake")), false);
});

test("teamgetLogs receives the audit log group name from auditLogs", () => {
  const auditTemplate = readJson(auditTemplatePath);
  const dependency = backendConfig.function.teamgetLogs.dependsOn.find((d) => d.category === "custom");
  assert.deepEqual(dependency, { attributes: ["AuditLogGroupName"], category: "custom", resourceName: "auditLogs" });
  assert.ok(auditTemplate.Outputs.AuditLogGroupName);
  assert.deepEqual(getLogsTemplate.Parameters.customauditLogsAuditLogGroupName, { Type: "String" });
  assert.deepEqual(envVars(getLogsTemplate).AUDIT_LOG_GROUP, { Ref: "customauditLogsAuditLogGroupName" });
  assert.equal(envVars(getLogsTemplate).EVENT_DATA_STORE, undefined);
});

test("teamqueryLogs no longer depends on a custom resource", () => {
  const dependencies = backendConfig.function.teamqueryLogs.dependsOn ?? [];
  assert.equal(dependencies.some((d) => d.category === "custom"), false);
  assert.equal(queryLogsTemplate.Parameters.customcloudtrailLakeEventDataStoreOutput, undefined);
  assert.equal(envVars(queryLogsTemplate).EVENT_DATA_STORE, undefined);
});

test("auditLogs parameters.json sets every template parameter without a default", () => {
  const auditTemplate = readJson(auditTemplatePath);
  const parameters = readJson("amplify/backend/custom/auditLogs/parameters.json");
  for (const [name, definition] of Object.entries(auditTemplate.Parameters)) {
    if (name === "env" || "Default" in definition) continue;
    assert.ok(name in parameters, `parameters.json sets ${name}`);
  }
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm run test:lambdas`
Expected: FAIL — the 4 wiring tests fail (`cloudtrailLake` still present, `auditLogs` template missing).

- [ ] **Step 5: Create the `auditLogs` template and parameters**

Create `amplify/backend/custom/auditLogs/auditLogs-cloudformation-template.json`:

```json
{
  "AWSTemplateFormatVersion": "2010-09-09",
  "Description": "TEAM session audit logs: CloudTrail events delivered to Amazon CloudWatch Logs and centralized into the TEAM account",
  "Parameters": {
    "env": {
      "Type": "String"
    },
    "CloudTrailAuditLogs": {
      "Type": "String",
      "AllowedValues": ["read", "write", "read_write", "none"],
      "Default": "read",
      "Description": "CloudTrail management events to collect: read, write, read_write, or none"
    },
    "OrganizationId": {
      "Type": "String",
      "AllowedPattern": "^o-[a-z0-9]{10,32}$",
      "Description": "AWS Organizations ID whose accounts are centralized"
    },
    "SourceRegions": {
      "Type": "CommaDelimitedList",
      "Description": "Regions to centralize CloudTrail log groups from"
    },
    "SourceRetentionInDays": {
      "Type": "Number",
      "Default": 7,
      "AllowedValues": [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653],
      "Description": "Retention of the managed aws/cloudtrail/* log groups in each member account"
    },
    "AuditLogRetentionInDays": {
      "Type": "Number",
      "Default": 30,
      "AllowedValues": [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653],
      "Description": "Retention of the central TEAM audit log group"
    }
  },
  "Conditions": {
    "IsAuditLogsEnabled": {
      "Fn::Not": [{ "Fn::Equals": [{ "Ref": "CloudTrailAuditLogs" }, "none"] }]
    },
    "IsReadAndWrite": {
      "Fn::Equals": [{ "Ref": "CloudTrailAuditLogs" }, "read_write"]
    },
    "IsReadOnly": {
      "Fn::Equals": [{ "Ref": "CloudTrailAuditLogs" }, "read"]
    }
  },
  "Resources": {
    "AuditLogGroup": {
      "Type": "AWS::Logs::LogGroup",
      "Properties": {
        "LogGroupName": { "Fn::Sub": "team-audit-${env}-cloudtrail" },
        "RetentionInDays": { "Ref": "AuditLogRetentionInDays" }
      }
    },
    "CloudTrailTelemetryRule": {
      "Type": "AWS::ObservabilityAdmin::OrganizationTelemetryRule",
      "Condition": "IsAuditLogsEnabled",
      "Properties": {
        "RuleName": { "Fn::Sub": "team-${env}-cloudtrail" },
        "Rule": {
          "ResourceType": "AWS::CloudTrail",
          "TelemetryType": "Logs",
          "AllRegions": true,
          "DestinationConfiguration": {
            "DestinationType": "cloud-watch-logs",
            "RetentionInDays": { "Ref": "SourceRetentionInDays" },
            "CloudtrailParameters": {
              "AdvancedEventSelectors": [
                {
                  "Fn::If": [
                    "IsReadAndWrite",
                    {
                      "Name": "TEAM management events",
                      "FieldSelectors": [
                        { "Field": "eventCategory", "Equals": ["Management"] }
                      ]
                    },
                    {
                      "Name": "TEAM management events",
                      "FieldSelectors": [
                        { "Field": "eventCategory", "Equals": ["Management"] },
                        { "Field": "readOnly", "Equals": [{ "Fn::If": ["IsReadOnly", "true", "false"] }] }
                      ]
                    }
                  ]
                }
              ]
            }
          }
        }
      }
    },
    "AuditLogCentralizationRule": {
      "Type": "AWS::ObservabilityAdmin::OrganizationCentralizationRule",
      "Condition": "IsAuditLogsEnabled",
      "Properties": {
        "RuleName": { "Fn::Sub": "team-${env}-cloudtrail" },
        "Rule": {
          "Source": {
            "Regions": { "Ref": "SourceRegions" },
            "Scope": { "Fn::Sub": "OrganizationId = '${OrganizationId}'" },
            "SourceLogsConfiguration": {
              "LogGroupSelectionCriteria": "LogGroupName LIKE 'aws/cloudtrail/%'",
              "EncryptedLogGroupStrategy": "SKIP"
            }
          },
          "Destination": {
            "Account": { "Ref": "AWS::AccountId" },
            "Region": { "Ref": "AWS::Region" },
            "DestinationLogsConfiguration": {
              "LogGroupNameConfiguration": {
                "LogGroupNamePattern": { "Ref": "AuditLogGroup" }
              }
            }
          }
        }
      }
    }
  },
  "Outputs": {
    "AuditLogGroupName": {
      "Description": "Central log group holding CloudTrail events from every account in the organization",
      "Value": { "Ref": "AuditLogGroup" }
    }
  }
}
```

Create `amplify/backend/custom/auditLogs/parameters.json` (Task 5's `parameters.js` overwrites `CloudTrailAuditLogs` and `OrganizationId` at build time):

```json
{
    "CloudTrailAuditLogs": "read",
    "OrganizationId": "",
    "SourceRegions": "ap-northeast-1,ap-northeast-2,ap-northeast-3,ap-south-1,ap-southeast-1,ap-southeast-2,ca-central-1,eu-central-1,eu-north-1,eu-west-1,eu-west-2,eu-west-3,sa-east-1,us-east-1,us-east-2,us-west-1,us-west-2",
    "SourceRetentionInDays": 7,
    "AuditLogRetentionInDays": 30
}
```

Delete the old resource:

```bash
git rm -r amplify/backend/custom/cloudtrailLake
```

- [ ] **Step 6: Rewire Amplify**

```bash
python3 - <<'PY'
import json, pathlib

def edit(path, change, indent):
    p = pathlib.Path(path)
    data = json.loads(p.read_text())
    change(data)
    p.write_text(json.dumps(data, indent=indent) + "\n")

def backend(config):
    custom = config["custom"]
    custom["auditLogs"] = custom.pop("cloudtrailLake")
    config["custom"] = dict(sorted(custom.items()))
    get_logs = config["function"]["teamgetLogs"]["dependsOn"]
    for dep in get_logs:
        if dep["category"] == "custom":
            dep.update(attributes=["AuditLogGroupName"], resourceName="auditLogs")
    query_logs = config["function"]["teamqueryLogs"]
    query_logs.pop("dependsOn")

def get_logs_template(t):
    t["Parameters"].pop("customcloudtrailLakeEventDataStoreOutput")
    t["Parameters"]["customauditLogsAuditLogGroupName"] = {"Type": "String"}
    env = t["Resources"]["LambdaFunction"]["Properties"]["Environment"]["Variables"]
    env.pop("EVENT_DATA_STORE")
    env["AUDIT_LOG_GROUP"] = {"Ref": "customauditLogsAuditLogGroupName"}

def query_logs_template(t):
    t["Parameters"].pop("customcloudtrailLakeEventDataStoreOutput")
    t["Resources"]["LambdaFunction"]["Properties"]["Environment"]["Variables"].pop("EVENT_DATA_STORE")

edit("amplify/backend/backend-config.json", backend, 2)
edit("amplify/backend/function/teamgetLogs/teamgetLogs-cloudformation-template.json", get_logs_template, 2)
edit("amplify/backend/function/teamqueryLogs/teamqueryLogs-cloudformation-template.json", query_logs_template, 2)
PY
git diff --stat amplify/backend
```

Expected: the diffs touch only the renamed keys, the dependency entries, the parameter and the environment variable. If a file was reformatted wholesale, match its original indentation (use the indent the file already uses) and re-run.

In `amplify/backend/types/amplify-dependent-resources-ref.d.ts`, replace:

```ts
    "cloudtrailLake": {
      "EventDataStoreOutput": "string"
    },
```

with:

```ts
    "auditLogs": {
      "AuditLogGroupName": "string"
    },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test:lambdas`
Expected: PASS — 26 tests, 0 failures.

- [ ] **Step 8: Lint the templates**

Run:

```bash
cfn-lint amplify/backend/custom/auditLogs/auditLogs-cloudformation-template.json
cfn-lint amplify/backend/function/teamgetLogs/teamgetLogs-cloudformation-template.json amplify/backend/function/teamqueryLogs/teamqueryLogs-cloudformation-template.json | diff /tmp/cfnlint-baseline.txt - && echo "no new findings"
grep -rn "cloudtrailLake\|EventDataStore\|EVENT_DATA_STORE" amplify parameters.js || echo "no stale references in amplify/"
```

Expected: no errors on the new template (fix any `E` findings before continuing); "no new findings"; `parameters.js` is still listed (fixed in Task 5).

- [ ] **Step 9: Commit**

```bash
git add package.json tests/audit-logs-wiring.test.mjs amplify/backend
git commit -m "feat: replace CloudTrail Lake EDS with CloudWatch telemetry and centralization rules"
```

---

### Task 5: Build-time parameters for `auditLogs`

**Files:**
- Modify: `parameters.js`
- Create: `tests/parameters.test.mjs`

**Interfaces:**
- Consumes: `amplify/backend/custom/auditLogs/parameters.json` keys from Task 4.
- Produces (CommonJS exports of `parameters.js`):
  - `buildAuditLogParameters(current: object, { cloudTrailAuditLogs?: string, organizationId: string, sourceRegions?: string }) → object` — throws on invalid input.
  - `resolveOrganizationId({ organizationId?: string, run?: (args: string[]) => string }) → string`

- [ ] **Step 1: Guard the script's side effects**

> Do not import `parameters.js` from a test before this step: the unguarded script rewrites `src/parameters.json`, Amplify `cli-inputs.json` and other tracked files as soon as it loads.

Replace the trailing calls at the end of `parameters.js` (`update_auth_parameters();` … `update_cloudtrail_parameters();`) with:

```js
if (require.main === module) {
  update_auth_parameters();
  update_react_parameters();
  update_groups_parameters();
  update_router_parameters();
  update_tag_parameters();
  update_cloudtrail_parameters();
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/parameters.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import parameters from "../parameters.js";

const { buildAuditLogParameters, resolveOrganizationId } = parameters;

const committed = {
  CloudTrailAuditLogs: "read",
  OrganizationId: "",
  SourceRegions: "us-east-1,ap-southeast-2",
  SourceRetentionInDays: 7,
  AuditLogRetentionInDays: 30,
};

test("sets the audit mode and organization while keeping committed defaults", () => {
  assert.deepEqual(
    buildAuditLogParameters(committed, { cloudTrailAuditLogs: "read_write", organizationId: "o-exampleorg1" }),
    { ...committed, CloudTrailAuditLogs: "read_write", OrganizationId: "o-exampleorg1" },
  );
});

test("keeps the committed audit mode when CLOUDTRAIL_AUDIT_LOGS is empty", () => {
  const next = buildAuditLogParameters(committed, { cloudTrailAuditLogs: "", organizationId: "o-exampleorg1" });
  assert.equal(next.CloudTrailAuditLogs, "read");
});

test("rejects CloudTrail Lake event data store ARNs", () => {
  assert.throws(
    () => buildAuditLogParameters(committed, {
      cloudTrailAuditLogs: "arn:aws:cloudtrail:us-east-1:123456789012:eventdatastore/abc",
      organizationId: "o-exampleorg1",
    }),
    /CLOUDTRAIL_AUDIT_LOGS must be one of read, write, read_write, none/,
  );
});

test("rejects a malformed organization ID", () => {
  assert.throws(
    () => buildAuditLogParameters(committed, { cloudTrailAuditLogs: "read", organizationId: "None" }),
    /Invalid organization ID/,
  );
});

test("AUDIT_LOG_REGIONS overrides the committed Region list", () => {
  const next = buildAuditLogParameters(committed, {
    cloudTrailAuditLogs: "read",
    organizationId: "o-exampleorg1",
    sourceRegions: " us-east-1, eu-west-1 ",
  });
  assert.equal(next.SourceRegions, "us-east-1,eu-west-1");
});

test("rejects an invalid AUDIT_LOG_REGIONS value", () => {
  assert.throws(
    () => buildAuditLogParameters(committed, { cloudTrailAuditLogs: "read", organizationId: "o-exampleorg1", sourceRegions: "us-east-1,mars" }),
    /Invalid AUDIT_LOG_REGIONS/,
  );
});

test("resolveOrganizationId prefers an explicit ID", () => {
  assert.equal(resolveOrganizationId({ organizationId: "o-exampleorg1", run: () => assert.fail("must not call AWS") }), "o-exampleorg1");
});

test("resolveOrganizationId asks AWS Organizations otherwise", () => {
  let calledWith;
  const id = resolveOrganizationId({ organizationId: "", run: (args) => { calledWith = args; return "o-exampleorg1\n"; } });
  assert.equal(id, "o-exampleorg1");
  assert.deepEqual(calledWith, ["organizations", "describe-organization", "--query", "Organization.Id", "--output", "text"]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:lambdas; git status --short`
Expected: FAIL — `TypeError: buildAuditLogParameters is not a function` (8 failures); `git status` shows no modified files outside `parameters.js` and the new test.

- [ ] **Step 4: Implement**

In `parameters.js`:

1. Add after `const path = require("path");`:

```js
const { execFileSync } = require("child_process");
```

2. Replace the `process.env` destructuring line with:

```js
const { AWS_APP_ID, AWS_BRANCH, SSO_LOGIN, TEAM_ADMIN_GROUP, TEAM_AUDITOR_GROUP, TAGS, CLOUDTRAIL_AUDIT_LOGS, TEAM_ACCOUNT, AMPLIFY_CUSTOM_DOMAIN, ORGANIZATION_ID, AUDIT_LOG_REGIONS } = process.env;

const AUDIT_LOG_MODES = ["read", "write", "read_write", "none"];
const ORGANIZATION_ID_PATTERN = /^o-[a-z0-9]{10,32}$/;
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/;
```

3. Delete **both** copies of `async function update_cloudtrail_parameters() { ... }` and add in their place:

```js
function buildAuditLogParameters(current, { cloudTrailAuditLogs, organizationId, sourceRegions }) {
  const mode = cloudTrailAuditLogs || current.CloudTrailAuditLogs;
  if (!AUDIT_LOG_MODES.includes(mode)) {
    throw new Error(`CLOUDTRAIL_AUDIT_LOGS must be one of ${AUDIT_LOG_MODES.join(", ")}; got "${mode}"`);
  }
  if (!ORGANIZATION_ID_PATTERN.test(organizationId || "")) {
    throw new Error(`Invalid organization ID "${organizationId}"`);
  }

  const next = { ...current, CloudTrailAuditLogs: mode, OrganizationId: organizationId };
  if (sourceRegions) {
    const regions = sourceRegions.split(",").map((region) => region.trim()).filter(Boolean);
    if (regions.length === 0 || !regions.every((region) => REGION_PATTERN.test(region))) {
      throw new Error(`Invalid AUDIT_LOG_REGIONS "${sourceRegions}"`);
    }
    next.SourceRegions = regions.join(",");
  }
  return next;
}

function runAwsCli(args) {
  return execFileSync("aws", args, { encoding: "utf8" });
}

function resolveOrganizationId({ organizationId = ORGANIZATION_ID, run = runAwsCli } = {}) {
  if (organizationId) return organizationId;
  return run(["organizations", "describe-organization", "--query", "Organization.Id", "--output", "text"]).trim();
}

async function update_audit_log_parameters() {
  console.log(`updating amplify/backend/custom/auditLogs/parameters.json"...`);

  const auditLogParametersJsonPath = path.resolve(
    `./amplify/backend/custom/auditLogs/parameters.json`
  );

  const auditLogParametersJson = buildAuditLogParameters(require(auditLogParametersJsonPath), {
    cloudTrailAuditLogs: CLOUDTRAIL_AUDIT_LOGS,
    organizationId: resolveOrganizationId(),
    sourceRegions: AUDIT_LOG_REGIONS,
  });

  fs.writeFileSync(
    auditLogParametersJsonPath,
    JSON.stringify(auditLogParametersJson, null, 4)
  );
}
```

4. Replace the guarded block from Step 1 with:

```js
if (require.main === module) {
  update_auth_parameters();
  update_react_parameters();
  update_groups_parameters();
  update_router_parameters();
  update_tag_parameters();
  update_audit_log_parameters();
}

module.exports = { buildAuditLogParameters, resolveOrganizationId };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:lambdas`
Expected: PASS — 34 tests, 0 failures.

- [ ] **Step 6: Smoke-test the script against a scratch copy**

```bash
tmp=$(mktemp -d) && git archive HEAD | tar -x -C "$tmp" && cp parameters.js "$tmp/" \
  && (cd "$tmp" && AWS_BRANCH=main AWS_APP_ID=d1234567890 SSO_LOGIN=https://example.awsapps.com/start \
      TEAM_ADMIN_GROUP=admins TEAM_AUDITOR_GROUP=auditors CLOUDTRAIL_AUDIT_LOGS=read_write \
      ORGANIZATION_ID=o-exampleorg1 node parameters.js \
  && cat amplify/backend/custom/auditLogs/parameters.json); rm -rf "$tmp"
```

Expected: the printed JSON has `"CloudTrailAuditLogs": "read_write"` and `"OrganizationId": "o-exampleorg1"`; the working tree is untouched (`git status` clean apart from `parameters.js` and the new test).

- [ ] **Step 7: Commit**

```bash
git add parameters.js tests/parameters.test.mjs
git commit -m "feat: write auditLogs build parameters including organization ID"
```

---

### Task 6: Deployment scripts and bootstrap template

**Files:**
- Create: `deployment/audit-logs-prereqs.sh`
- Modify: `deployment/init.sh`, `deployment/deploy.sh`, `deployment/update.sh`
- Modify: `deployment/template.yml` (`CloudTrailAuditLogs` parameter)
- Modify: `deployment/parameters-template.sh`, `deployment/parameters-mgmt-template.sh`

**Interfaces:**
- Produces (bash functions, sourced): `ensure_logs_centralization_role`, `ensure_org_telemetry_evaluation`, `ensure_cloudwatch_delegated_admin <account-id>`. All use the current `AWS_PROFILE` and `$REGION`, and are idempotent.

- [ ] **Step 1: Record the template lint baseline**

Run: `cfn-lint deployment/template.yml > /tmp/cfnlint-template-baseline.txt; cat /tmp/cfnlint-template-baseline.txt`

- [ ] **Step 2: Create the prerequisites helper**

Create `deployment/audit-logs-prereqs.sh`:

```bash
# Copyright 2022 Amazon Web Services, Inc
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Idempotent prerequisites for TEAM session audit logs in Amazon CloudWatch.
# Source this file; the functions use the current AWS_PROFILE and $REGION.

# Service-linked role used by CloudWatch Logs centralization rules.
ensure_logs_centralization_role() {
  if ! aws iam get-role --role-name AWSServiceRoleForObservabilityAdmin_LogsCentralization > /dev/null 2>&1; then
    aws iam create-service-linked-role --aws-service-name logs-centralization.observabilityadmin.amazonaws.com
  fi
}

# Organization-wide CloudWatch telemetry config in every Region; also turns on
# trusted access for CloudWatch. Must run in the management account.
ensure_org_telemetry_evaluation() {
  local status
  status=$(aws observabilityadmin get-telemetry-evaluation-status-for-organization --region "$REGION" --query Status --output text)
  if [ "$status" != "RUNNING" ] && [ "$status" != "STARTING" ]; then
    aws observabilityadmin start-telemetry-evaluation-for-organization --region "$REGION" --all-regions
  fi
}

# Lets the TEAM account manage organization telemetry and centralization rules.
ensure_cloudwatch_delegated_admin() {
  local account_id=$1
  local registered
  registered=$(aws organizations list-delegated-administrators --service-principal observabilityadmin.amazonaws.com \
    --query "DelegatedAdministrators[?Id=='${account_id}'].Id" --output text)
  if [ -z "$registered" ]; then
    aws organizations register-delegated-administrator \
      --account-id "$account_id" \
      --service-principal observabilityadmin.amazonaws.com
    echo "$account_id configured as delegated Admin for Amazon CloudWatch"
  else
    echo "$account_id is already configured as delegated Admin for Amazon CloudWatch"
  fi
}
```

- [ ] **Step 3: Update `init.sh`**

In `deployment/init.sh`:

1. Change the header comment line to:
   `# The script enables delegated admin for AWS Account Management, AWS IAM IdC and Amazon CloudWatch`
2. After `. "./parameters.sh"` add: `. "./audit-logs-prereqs.sh"`
3. Delete the `cloudtrail=...` and `serviceRole=...` variable lines.
4. Replace the whole block from `# Enable trusted access for cloudtrail` through the closing `fi` of `# Enable Delegated Admin for CloudTrail` with:

```bash
# Enable CloudWatch telemetry config for the organization (also enables trusted access for CloudWatch)
ensure_org_telemetry_evaluation
ensure_logs_centralization_role

# Enable Delegated Admin for CloudWatch (organization telemetry and centralization rules)
ensure_cloudwatch_delegated_admin "$TEAM_ACCOUNT"
```

- [ ] **Step 4: Update `deploy.sh` and `update.sh`**

In both `deployment/deploy.sh` and `deployment/update.sh`, insert directly after the `fi` that closes the `AWS_PROFILE` selection block (before `cd ..`):

```bash
. "./audit-logs-prereqs.sh"
ensure_logs_centralization_role
# Management-account deployments skip init.sh, so turn on organization telemetry here
if [ -z "$TEAM_ACCOUNT" ]; then
  ensure_org_telemetry_evaluation
fi
```

- [ ] **Step 5: Update `template.yml` and the parameter templates**

In `deployment/template.yml`, replace the `CloudTrailAuditLogs` parameter with:

```yaml
  CloudTrailAuditLogs:
    Type: "String"
    AllowedPattern: "^(read_write|read|write|none)?$"
    Description: CloudTrail management events delivered to Amazon CloudWatch Logs for TEAM session activity. Acceptable values are "read", "write", "read_write" and "none". Empty defaults to "read_write".
```

In `deployment/parameters-template.sh`, replace the `CLOUDTRAIL_AUDIT_LOGS=arn:...` line with:

```sh
# CloudTrail management events to collect for session activity: read, write, read_write or none
CLOUDTRAIL_AUDIT_LOGS=read_write
```

In `deployment/parameters-mgmt-template.sh`, put the same comment line directly above the existing `CLOUDTRAIL_AUDIT_LOGS=read_write`.

- [ ] **Step 6: Verify**

Run:

```bash
for f in deployment/*.sh; do bash -n "$f" || echo "SYNTAX ERROR: $f"; done
command -v shellcheck > /dev/null && shellcheck -S warning deployment/audit-logs-prereqs.sh
cfn-lint deployment/template.yml | diff /tmp/cfnlint-template-baseline.txt - && echo "no new findings"
grep -n -i "cloudtrail" deployment/*.sh deployment/template.yml
```

Expected: no syntax errors; no shellcheck warnings (if shellcheck is installed); "no new findings"; remaining `cloudtrail` matches are only `CLOUDTRAIL_AUDIT_LOGS` / `CloudTrailAuditLogs` names and comments.

- [ ] **Step 7: Commit**

```bash
git add deployment
git commit -m "feat: set up CloudWatch telemetry and centralization prerequisites in deployment scripts"
```

---

### Task 7: UI text, documentation and changelog

**Files:**
- Modify: `src/components/Navigation/ToolsDrawer.js:24`
- Modify: `docs/docs/deployment/prerequisites.md`, `docs/docs/deployment/deployment_process.md`, `docs/docs/overview/architecture.md`, `docs/docs/overview/cost.md`, `docs/docs/overview/security.md`
- Modify: `changelog.md`

- [ ] **Step 1: UI**

In `src/components/Navigation/ToolsDrawer.js`, replace `<li>AWS CloudTrail Lake</li>` with `<li>Amazon CloudWatch Logs</li>`.

- [ ] **Step 2: `prerequisites.md`**

Replace `  - CloudTrail Lake` (under "Dedicated TEAM account") with `  - Amazon CloudWatch (telemetry config and log centralization)`.

Replace the whole `### Cloudtrail Lake organization event datastore` section (heading plus its two lines) with:

```markdown
### CloudTrail events in Amazon CloudWatch
TEAM records the API activity of each elevated access session from AWS CloudTrail. The TEAM stack creates an organization-wide CloudWatch telemetry enablement rule that delivers CloudTrail management events to CloudWatch Logs in every account, and a centralization rule that copies those events into one log group in the TEAM account (`team-audit-<env>-cloudtrail`). No CloudTrail trail or CloudTrail Lake event data store is required.

`init.sh` turns on CloudWatch telemetry config for the organization and registers the TEAM account as the CloudWatch delegated administrator.

> Upgrading an existing TEAM deployment removes its CloudTrail Lake event data store. Export any history you need first with **CloudTrail console → Lake → Event data stores → Actions → Export to CloudWatch**.
{: .warning}
```

- [ ] **Step 3: `deployment_process.md`**

- Replace `- **CLOUDTRAIL_AUDIT_LOGS** - ARN of organization CloudTrail Lake event datastore` with `- **CLOUDTRAIL_AUDIT_LOGS** - CloudTrail management events to collect for session activity: \`read\`, \`write\`, \`read_write\` or \`none\``.
- In the example block replace the `CLOUDTRAIL_AUDIT_LOGS=arn:...` line with `CLOUDTRAIL_AUDIT_LOGS=read_write`.
- Replace `- Configures the **TEAM_ACCOUNT** as a delegated admin for cloudtrail management` with:

```markdown
- Turns on Amazon CloudWatch telemetry config for the organization in all Regions and creates the CloudWatch Logs centralization service-linked role
- Configures the **TEAM_ACCOUNT** as a delegated admin for Amazon CloudWatch
```

- Replace `$ 123456789101 configured as delegated Admin for cloudtrail` with `$ 123456789101 configured as delegated Admin for Amazon CloudWatch`.
- Under **Optional:** add:

```markdown
- **AUDIT_LOG_REGIONS** - Comma-separated Regions to centralize CloudTrail events from, set as an Amplify environment variable on the `main` branch (default: the 17 Regions enabled by default in commercial AWS). CloudTrail records global-service events such as IAM and STS in `us-east-1`, so keep it in the list.
```

- [ ] **Step 4: `architecture.md`, `cost.md`, `security.md`**

`architecture.md`:
- Replace the "Auditing and visibility component ..." bullet with: `- Auditing and visibility component powered by [AWS CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html) events delivered to [Amazon CloudWatch Logs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/telemetry-config-rules.html) and centralized into the TEAM account, queried with [CloudWatch Logs Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AnalyzingLogData.html) for viewing elevated access session activity logs.`
- In the **Session Table** bullet replace `an [AWS CloudTrail Lake](...) query` with `a [CloudWatch Logs Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AnalyzingLogData.html) query`.

`cost.md`:
- Replace `- [AWS CloudTrail Lake](https://aws.amazon.com/cloudtrail/pricing/)` with:

```markdown
- [AWS CloudTrail](https://aws.amazon.com/cloudtrail/pricing/) (service-linked channel event delivery)
- [Amazon CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) (Logs ingestion, storage and Logs Insights queries)
```

- Replace the `## Managing CloudTrail Lake cost` section (heading and both paragraphs) with:

```markdown
## Managing audit log cost

TEAM delivers CloudTrail management events to CloudWatch Logs in every account through a [telemetry enablement rule](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/telemetry-config-rules.html) and copies them into one log group in the TEAM account with a [centralization rule](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CloudWatchLogs_Centralization.html). You pay CloudTrail event delivery, CloudWatch Logs ingestion and storage for the member-account and central copies, and Logs Insights for the data each session query scans.

To reduce cost:
- Set **CLOUDTRAIL_AUDIT_LOGS** to `write` to record only mutating calls, or `none` to turn audit logs off.
- Lower `SourceRetentionInDays` (default 7) and `AuditLogRetentionInDays` (default 30) in `amplify/backend/custom/auditLogs/parameters.json`.
- Limit **AUDIT_LOG_REGIONS** to the Regions your organization uses (keep `us-east-1`).
```

`security.md`: replace the two paragraphs under `## Audit logs` with:

```markdown
TEAM records the API activity of each elevated access session from [AWS CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html). CloudTrail management events are delivered to CloudWatch Logs in every account in the organization and centralized into the `team-audit-<env>-cloudtrail` log group in the TEAM account, where TEAM queries them with CloudWatch Logs Insights.
TEAM collects [management events](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-management-events-with-cloudtrail.html) and no [data events](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-data-events-with-cloudtrail.html) by default. Depending on your organization's auditing and compliance requirements, set **CLOUDTRAIL_AUDIT_LOGS** to `read`, `write` or `read_write`, and adjust the log group retention periods. Restrict access to the TEAM account and the central log group, since it holds API activity for every account in the organization.
```

- [ ] **Step 5: `changelog.md`**

Under `## [Unreleased]` add:

```markdown
### Changed

- Session activity logs now use AWS CloudTrail events in Amazon CloudWatch Logs (organization telemetry enablement rule plus a centralization rule into the TEAM account) instead of AWS CloudTrail Lake, which closed to new customers on 2026-05-31.
- `CLOUDTRAIL_AUDIT_LOGS` accepts only `read`, `write`, `read_write` or `none`; CloudTrail Lake event data store ARNs are no longer supported.
- `init.sh` registers the TEAM account as the Amazon CloudWatch delegated administrator instead of the CloudTrail delegated administrator.

### Removed

- The `cloudtrailLake` Amplify custom resource. Upgrading deletes the existing event data store; export its data to CloudWatch first.
```

- [ ] **Step 6: Verify**

Run:

```bash
grep -rn -i "cloudtrail lake\|event datastore\|event data store" docs/docs src README.md
npm run test:lambdas
```

Expected: the only `CloudTrail Lake` / `event data store` mentions left are the upgrade warning in `prerequisites.md`; tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/Navigation/ToolsDrawer.js docs/docs changelog.md
git commit -m "docs: document CloudWatch-based session audit logs"
```

---

### Task 8: Organization bootstrap (live — management account)

All steps in this task change the organization. **Ask the user for confirmation before Steps 3, 4 and 5.**

**Files:**
- Create (gitignored): `deployment/parameters.sh`
- Modify (outside repo, with user approval): `~/.aws/config` (management account profile)

- [ ] **Step 1: Add a management-account profile (ask first)**

Show the user this block and, once they approve, append it to `~/.aws/config`:

```ini
[profile <MGMT_PROFILE>]
sso_session = <SSO_SESSION>
sso_account_id = <MGMT_ACCOUNT_ID>
sso_role_name = AdministratorAccess
region = <REGION>
output = json
```

Verify: `AWS_PROFILE=<MGMT_PROFILE> aws sts get-caller-identity --query Account --output text` → `<MGMT_ACCOUNT_ID>`.

- [ ] **Step 2: Pick the TEAM groups and login URL**

Run (read-only): `AWS_PROFILE=<TEAM_PROFILE> aws identitystore list-groups --identity-store-id <IDENTITY_STORE_ID> --region <REGION> --query 'Groups[].DisplayName' --output text`

Ask the user which groups are the TEAM admin and auditor groups (or whether to create `TEAM-Admins` / `TEAM-Auditors`), and confirm the access portal URL (default `https://<IDENTITY_STORE_ID>.awsapps.com/start`). Then create `deployment/parameters.sh`:

```sh
IDC_LOGIN_URL=https://<IDENTITY_STORE_ID>.awsapps.com/start
REGION=<REGION>
TEAM_ACCOUNT=<TEAM_ACCOUNT_ID>
ORG_MASTER_PROFILE=<MGMT_PROFILE>
TEAM_ACCOUNT_PROFILE=<TEAM_PROFILE>
TEAM_ADMIN_GROUP="<admin group chosen by the user>"
TEAM_AUDITOR_GROUP="<auditor group chosen by the user>"
TAGS="project=iam-identity-center-team environment=demo"
CLOUDTRAIL_AUDIT_LOGS=read_write
SECRET_NAME=TEAM-IDC-APP
CACHE_TTL=604800
```

Verify: `git status --short deployment/` shows nothing (`parameters.sh` is gitignored).

- [ ] **Step 3: Run `init.sh` (confirm first)**

Tell the user it will: enable trusted access + delegated admin for Account Management and IAM Identity Center (already set for IdC), start org telemetry evaluation in all Regions, create the centralization service-linked role in `<MGMT_ACCOUNT_ID>`, and register `<TEAM_ACCOUNT_ID>` as CloudWatch delegated admin. After approval:

```bash
cd deployment && ./init.sh; cd -
```

Expected output includes `<TEAM_ACCOUNT_ID> configured as delegated Admin for Amazon CloudWatch`.

- [ ] **Step 4: Verify org state (read-only)**

```bash
export AWS_PROFILE=<MGMT_PROFILE>
aws observabilityadmin get-telemetry-evaluation-status-for-organization --region <REGION>
aws organizations list-delegated-administrators --service-principal observabilityadmin.amazonaws.com --query 'DelegatedAdministrators[].Id'
aws iam get-role --role-name AWSServiceRoleForObservabilityAdmin_LogsCentralization --query Role.Arn
unset AWS_PROFILE
```

Expected: `Status` is `STARTING` then `RUNNING` (re-check every few minutes until `RUNNING`); delegated admins contain `<TEAM_ACCOUNT_ID>`; the role ARN prints.

- [ ] **Step 5: Probe the centralization rule shape from the TEAM account (confirm first)**

Creates and immediately deletes a rule that matches no log groups, using the full shape the `auditLogs` template uses (`Scope`, `LogGroupSelectionCriteria`, `EncryptedLogGroupStrategy`, `DestinationLogsConfiguration`):

```bash
export AWS_PROFILE=<TEAM_PROFILE>
aws observabilityadmin create-centralization-rule-for-organization --region <REGION> \
  --rule-name team-scope-probe \
  --rule '{"Source":{"Regions":["<REGION>"],"Scope":"OrganizationId = '"'"'<ORG_ID>'"'"'","SourceLogsConfiguration":{"LogGroupSelectionCriteria":"LogGroupName LIKE '"'"'team-scope-probe-none/%'"'"'","EncryptedLogGroupStrategy":"SKIP"}},"Destination":{"Region":"<REGION>","Account":"<TEAM_ACCOUNT_ID>","DestinationLogsConfiguration":{"LogGroupNameConfiguration":{"LogGroupNamePattern":"team-scope-probe-dest"}}}}'
aws observabilityadmin list-centralization-rules-for-organization --region <REGION>
aws observabilityadmin delete-centralization-rule-for-organization --region <REGION> --rule-identifier team-scope-probe
unset AWS_PROFILE
```

Expected: create returns a `RuleArn`; the rule is listed; delete succeeds (always delete the probe rule, even if a later check fails). If create rejects the `Scope`, retry once with `"Scope":"*"` and then without `Scope`; put the first accepted form into `AuditLogCentralizationRule.Properties.Rule.Source.Scope` in the `auditLogs` template (remove the property if omission worked), re-run `npm run test:lambdas` and `cfn-lint`, and commit `fix: use accepted centralization scope syntax`.

- [ ] **Step 6: Create the TEAM-account service-linked role**

```bash
AWS_PROFILE=<TEAM_PROFILE> bash -c '. deployment/audit-logs-prereqs.sh && ensure_logs_centralization_role'
AWS_PROFILE=<TEAM_PROFILE> aws iam get-role --role-name AWSServiceRoleForObservabilityAdmin_LogsCentralization --query Role.Arn
```

Expected: role ARN in `<TEAM_ACCOUNT_ID>` prints (`deploy.sh` would also do this; doing it now surfaces permission problems early).

- [ ] **Step 7: Validate the session query syntax (confirm first)**

Proves the Logs Insights query built by `buildSessionQuery` is accepted and matches only the intended principal. Everything created here is deleted at the end.

```bash
export AWS_PROFILE=<TEAM_PROFILE>
LG=team-audit-probe-cloudtrail
aws logs create-log-group --region <REGION> --log-group-name "$LG"
aws logs create-log-stream --region <REGION> --log-group-name "$LG" --log-stream-name probe
NOW_MS=$(( $(date +%s) * 1000 ))
EVENT=$(cat <<JSON
{"recipientAccountId":"<TEAM_ACCOUNT_ID>","eventID":"11111111-2222-3333-4444-555555555555","eventName":"ListBuckets","eventSource":"s3.amazonaws.com","eventTime":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","userIdentity":{"principalId":"AROAEXAMPLE:jane.doe@example.com","sessionContext":{"sessionIssuer":{"arn":"arn:aws:iam::<TEAM_ACCOUNT_ID>:role/aws-reserved/sso.amazonaws.com/<REGION>/AWSReservedSSO_ReadOnlyAccess_0123456789abcdef"}}}}
JSON
)
aws logs put-log-events --region <REGION> --log-group-name "$LG" --log-stream-name probe \
  --log-events "timestamp=$NOW_MS,message=$(printf '%s' "$EVENT" | jq -Rs .)"
# Generate the exact query text (run from the repo root)
Q=$(node --input-type=module -e 'import { buildSessionQuery } from "./amplify/backend/function/teamgetLogs/src/query.js"; process.stdout.write(buildSessionQuery({ accountId: "<TEAM_ACCOUNT_ID>", role: "ReadOnlyAccess", username: "jane.doe@example.com" }))')
QID=$(aws logs start-query --region <REGION> --log-group-name "$LG" \
  --start-time $(( $(date +%s) - 600 )) --end-time $(( $(date +%s) + 600 )) --query-string "$Q" --query queryId --output text)
sleep 15; aws logs get-query-results --region <REGION> --query-id "$QID" --query '[status, results]'
```

Expected: `Complete` with exactly the one synthetic event (allow a few retries; CloudWatch may take a minute to index a new event). Then repeat with `username: "jane"` (a prefix of the real username) and expect `Complete` with zero rows. Finally clean up:

```bash
aws logs delete-log-group --region <REGION> --log-group-name "$LG"
unset AWS_PROFILE
```

If the query is rejected (`MalformedQueryException`), switch the principal filter to `like /(?i):<escaped username>$/` without `tolower()` (adjust the tests in `amplify/backend/function/teamgetLogs/test/`), re-run `npm run test:lambdas`, and commit the fix before deploying.

---

---

### Task 9: Deploy TEAM to the Demo account from the fork (live)

**Ask the user for confirmation before Steps 1, 2 and 4.**

- [ ] **Step 1: Push and merge into the fork's `main` (confirm first)**

Amplify builds the `main` branch. After approval:

```bash
npm run test:lambdas
git push -u origin feat/cloudwatch-audit-logs
gh pr create --repo debojitroy/iam-identity-center-team --base main --head feat/cloudwatch-audit-logs \
  --title "feat: replace CloudTrail Lake with CloudWatch for session audit logs" \
  --body-file docs/superpowers/specs/2026-10-14-cloudwatch-audit-logs-design.md
gh pr merge feat/cloudwatch-audit-logs --repo debojitroy/iam-identity-center-team --merge --delete-branch=false
git fetch origin && git log --oneline -1 origin/main
```

Expected: PR URL on `github.com/debojitroy/iam-identity-center-team`; `origin/main` points at the merge commit.

- [ ] **Step 2: Store the GitHub token (user action)**

TEAM's deployment docs require a **classic** personal access token for GitHub. Ask the user to create one at <https://github.com/settings/tokens> with scopes `repo` and `admin:repo_hook`, then run **in their own terminal** (so the token never enters this session or shell history used here):

```bash
aws secretsmanager create-secret --profile <TEAM_PROFILE> --region <REGION> \
  --name TEAM-IDC-APP \
  --secret-string '{"url":"https://github.com/debojitroy/iam-identity-center-team","AccessToken":"<token>"}'
```

Verify (no secret value printed): `AWS_PROFILE=<TEAM_PROFILE> aws secretsmanager describe-secret --secret-id TEAM-IDC-APP --region <REGION> --query Name`.

- [ ] **Step 3: Pre-flight (read-only)**

```bash
cfn-lint deployment/template.yml
AWS_PROFILE=<TEAM_PROFILE> aws observabilityadmin list-centralization-rules-for-organization --region <REGION>
```

Expected: no new lint errors; the list call succeeds (proves delegated admin works).

- [ ] **Step 4: Run `deploy.sh` (confirm first)**

```bash
cd deployment && ./deploy.sh 2>&1 | tee /tmp/team-deploy.log | tail -40; cd -
```

Expected: stack `TEAM-IDC-APP` reaches `CREATE_COMPLETE` and triggers an Amplify build.

- [ ] **Step 5: Watch the Amplify build**

```bash
export AWS_PROFILE=<TEAM_PROFILE>
APP_ID=$(aws amplify list-apps --region <REGION> --query "apps[?name=='TEAM-IDC-APP'].appId | [0]" --output text)
aws amplify list-jobs --app-id "$APP_ID" --branch-name main --region <REGION> --max-items 1 --query 'jobSummaries[0].[jobId,status]'
unset AWS_PROFILE
```

Re-check every 5 minutes until `SUCCEED` or `FAILED` (a full build takes 20–40 minutes). If the stack's app name differs, list apps without the filter and pick the TEAM app. On `FAILED`: fetch the step logs with `aws amplify get-job --app-id "$APP_ID" --branch-name main --job-id <id>` (follow the `logUrl` of the failed step), use superpowers:systematic-debugging to find the root cause, fix it on a new branch in the fork, and repeat Step 1 (PR + merge) — Amplify rebuilds on merge.

- [ ] **Step 6: Verify the audit-log resources (read-only)**

```bash
export AWS_PROFILE=<TEAM_PROFILE>
aws logs describe-log-groups --log-group-name-prefix team-audit-main-cloudtrail --region <REGION> --query 'logGroups[].[logGroupName,retentionInDays]'
aws observabilityadmin list-telemetry-rules-for-organization --region <REGION>
aws observabilityadmin list-centralization-rules-for-organization --region <REGION>
aws lambda get-function-configuration --function-name teamgetLogs-main --region <REGION> --query 'Environment.Variables.AUDIT_LOG_GROUP'
unset AWS_PROFILE
```

Expected: log group `team-audit-main-cloudtrail` with 30-day retention; one telemetry rule `team-main-cloudtrail`; one centralization rule `team-main-cloudtrail` with a healthy status; Lambda env `team-audit-main-cloudtrail`.

- [ ] **Step 7: Post-deployment configuration**

Follow `docs/docs/deployment/configuration/idc.md` (IAM Identity Center SAML application for TEAM) and run `deployment/cognito.sh` as described in `docs/docs/deployment/deployment_process.md`. The SAML application steps happen in the IAM Identity Center console: give the user the exact values from the script output and wait for them to confirm.

---

### Task 10: End-to-end verification (live)

- [ ] **Step 1: Confirm events are arriving centrally**

Telemetry discovery can take up to 24 hours on first rollout. Check (read-only):

```bash
export AWS_PROFILE=<TEAM_PROFILE>
QID=$(aws logs start-query --region <REGION> --log-group-identifiers team-audit-main-cloudtrail \
  --start-time $(( $(date +%s) - 3600 )) --end-time $(date +%s) \
  --query-string 'stats count(*) as events by @aws.account, @aws.region | sort events desc' --query queryId --output text)
sleep 10; aws logs get-query-results --region <REGION> --query-id "$QID" --query '[status, results]'
unset AWS_PROFILE
```

Also confirm that events from the TEAM account itself and from the management account appear (they are the easiest accounts to miss): re-run the query with `--query-string 'stats count(*) by @aws.account'` and check that both `<TEAM_ACCOUNT_ID>` and `<MGMT_ACCOUNT_ID>` are present. Note the result for the Step 4 report.

Expected: `Complete` with rows from more than one account and from `us-east-1`. If empty, check `aws logs describe-log-groups --log-group-name-prefix aws/cloudtrail` in the TEAM account and the centralization rule health, then wait and retry.

- [ ] **Step 2: Run a TEAM session (user + agent)**

With the user, in the TEAM web app: as TEAM admin create an eligibility policy and an approver policy for a test account and permission set; as a requester submit a request; as an approver approve it; as the requester open the AWS access portal, assume the granted permission set in the target account and make a few API calls (for example list S3 buckets and describe EC2 instances in the console).

- [ ] **Step 3: Verify the session logs page**

After the session ends (or while it is in progress), open the request's session activity logs in TEAM. Expected: the table lists the requester's events (`eventName`, `eventSource`, `eventTime`) for the target account only. Cross-check (read-only):

```bash
AWS_PROFILE=<TEAM_PROFILE> aws logs tail /aws/lambda/teamgetLogs-main --region <REGION> --since 2h | grep -E "finished for session|ended with status|Skipping"
```

Expected: `Query <id> finished for session <id>`; no `ended with status` or `Skipping` lines for the test session. If the page stays empty, run the same Logs Insights query manually from `buildSessionQuery` output (copy it from a Node REPL with the session values) to separate ingestion delay from a query bug.

- [ ] **Step 4: Record results**

Report to the user: build ID, stack status, rule statuses, the event count from Step 1, and a screenshot/description of the session logs page. Then invoke superpowers:finishing-a-development-branch.
