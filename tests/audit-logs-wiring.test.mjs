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
