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

test("AUDIT_LOG_REGIONS drops duplicate Regions and keeps first-seen order", () => {
  const next = buildAuditLogParameters(committed, {
    cloudTrailAuditLogs: "read",
    organizationId: "o-exampleorg1",
    sourceRegions: " us-east-1,eu-west-1,us-east-1 ",
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
