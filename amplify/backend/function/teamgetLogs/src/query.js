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

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const assertIdentity = (value, label) => {
  if (!IDENTITY_PATTERN.test(value)) throw new Error(`invalid ${label}`);
};

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
  // Re-validate here: this builder is exported and must be safe on its own.
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("invalid accountId");
  assertIdentity(role, "role");
  assertIdentity(username, "username");

  // Anchored regexes: a substring match would leak other users' or permission
  // sets' events (":jane" matches ":janet", "Admin" matches "Admin_Extra").
  const roleMatch = `/\\/AWSReservedSSO_${escapeRegex(role)}_[0-9A-Za-z]+$/`;
  // Logs Insights rejects tolower() inside a filter like, so match case-insensitively with (?i).
  const usernameMatch = `/(?i):${escapeRegex(username.toLowerCase())}$/`;

  return [
    "fields eventID, eventName, eventSource, eventTime",
    `| filter recipientAccountId = "${accountId}"`,
    `| filter userIdentity.sessionContext.sessionIssuer.arn like ${roleMatch}`,
    `| filter userIdentity.principalId like ${usernameMatch}`,
    "| sort eventTime asc",
    `| limit ${MAX_RESULTS}`,
  ].join("\n");
}

export const isTerminalStatus = (status) => TERMINAL_STATUSES.has(status);
