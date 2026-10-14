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
      "| filter userIdentity.sessionContext.sessionIssuer.arn like /\\/AWSReservedSSO_AdministratorAccess_[0-9A-Za-z]+$/",
      "| filter userIdentity.principalId like /(?i):jane\\.doe\\+ops@example\\.com$/",
      "| sort eventTime asc",
      `| limit ${MAX_RESULTS}`,
    ].join("\n"),
  );
});

// Pull the regex literal back out of a generated filter line and compile it.
// Logs Insights' inline (?i) flag is not valid JavaScript, so strip it and use the i flag.
const regexInFilter = (query, filterMarker) => {
  const line = query.split("\n").find((candidate) => candidate.includes(filterMarker));
  const literal = line.slice(line.indexOf(" like ") + " like ".length);
  const body = literal.slice(1, literal.lastIndexOf("/"));
  const caseInsensitive = body.startsWith("(?i)");
  return new RegExp(caseInsensitive ? body.slice("(?i)".length) : body, caseInsensitive ? "i" : "");
};

test("role filter matches the exact permission set and not a longer name with the same prefix", () => {
  const roleRegex = regexInFilter(
    buildSessionQuery({ accountId: "123456789012", role: "Admin", username: "jane" }),
    "sessionIssuer.arn",
  );
  const arn = "arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/ap-southeast-2/AWSReservedSSO_Admin_0123456789abcdef";
  const longerArn = "arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/ap-southeast-2/AWSReservedSSO_Admin_Extra_0123456789abcdef";
  assert.equal(roleRegex.test(arn), true);
  assert.equal(roleRegex.test(longerArn), false);
});

test("username filter matches the exact principal and not a longer user name with the same prefix", () => {
  const usernameRegex = regexInFilter(
    buildSessionQuery({ accountId: "123456789012", role: "Admin", username: "jane" }),
    "principalId like",
  );
  assert.equal(usernameRegex.test("aroaexample:jane"), true);
  assert.equal(usernameRegex.test("aroaexample:janet"), false);
  assert.equal(usernameRegex.test("AROAEXAMPLE:Jane"), true);
});

test("buildSessionQuery rejects inputs that would break out of the query", () => {
  const valid = { accountId: "123456789012", role: "AdministratorAccess", username: "jane" };
  assert.throws(() => buildSessionQuery({ ...valid, role: 'Admin" | display @message' }), /invalid role/);
  assert.throws(() => buildSessionQuery({ ...valid, accountId: "12345" }), /invalid accountId/);
});

test("isTerminalStatus is true only for finished query states", () => {
  for (const status of ["Complete", "Failed", "Cancelled", "Timeout", "Unknown"]) {
    assert.equal(isTerminalStatus(status), true, status);
  }
  for (const status of ["Scheduled", "Running", undefined]) {
    assert.equal(isTerminalStatus(status), false, String(status));
  }
});
