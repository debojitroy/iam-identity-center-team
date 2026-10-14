// © 2021 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
// This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
// http://aws.amazon.com/agreement or other written agreement between Customer and either
// Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { AWS_APP_ID, AWS_BRANCH, SSO_LOGIN, TEAM_ADMIN_GROUP, TEAM_AUDITOR_GROUP, TAGS, CLOUDTRAIL_AUDIT_LOGS, TEAM_ACCOUNT, AMPLIFY_CUSTOM_DOMAIN, ORGANIZATION_ID, AUDIT_LOG_REGIONS } = process.env;

const AUDIT_LOG_MODES = ["read", "write", "read_write", "none"];
const ORGANIZATION_ID_PATTERN = /^o-[a-z0-9]{10,32}$/;
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/;

async function update_auth_parameters() {
  console.log(`updating amplify config for branch "${AWS_BRANCH}"...`);
  // update callback/logout redirect urls for build url
  const backendConfig = require(path.resolve(
    "./amplify/backend/backend-config.json"
  ));
  const authResourceName = Object.keys(backendConfig.auth)[0];
  const authParametersJsonPath = path.resolve(
    `./amplify/backend/auth/${authResourceName}/cli-inputs.json`
  );
  const authParametersJson = require(authParametersJsonPath);
  const oAuthMetadata = JSON.parse(
    authParametersJson.cognitoConfig.oAuthMetadata
  );
  oAuthMetadata.CallbackURLs.pop();
  oAuthMetadata.LogoutURLs.pop();

  const amplifyDomain = AMPLIFY_CUSTOM_DOMAIN ? `https://${AMPLIFY_CUSTOM_DOMAIN}/` :`https://${AWS_BRANCH}.${AWS_APP_ID}.amplifyapp.com/`

  console.log("domain",amplifyDomain)
  oAuthMetadata.CallbackURLs.push(amplifyDomain);
  oAuthMetadata.LogoutURLs.push(amplifyDomain);

  authParametersJson.cognitoConfig.oAuthMetadata =
    JSON.stringify(oAuthMetadata);

  authParametersJson.cognitoConfig.hostedUIDomainName = AWS_APP_ID;

  fs.writeFileSync(
    authParametersJsonPath,
    JSON.stringify(authParametersJson, null, 4)
  );
}
async function update_react_parameters() {
  console.log(`updating react parameters"...`);
  const reactParametersJsonPath = path.resolve(`./src/parameters.json`);
  const reactParametersJson = require(reactParametersJsonPath);
  reactParametersJson.Login = SSO_LOGIN;

  console.log("Team Account param:");
  console.log(TEAM_ACCOUNT);
  if (TEAM_ACCOUNT === undefined) {
    reactParametersJson.DeploymentType = "management"
  } else {
    reactParametersJson.DeploymentType = "delegated"
  };

  reactParametersJson.teamAdminGroup = TEAM_ADMIN_GROUP;
  reactParametersJson.teamAuditorGroup = TEAM_AUDITOR_GROUP;


  fs.writeFileSync(
    reactParametersJsonPath,
    JSON.stringify(reactParametersJson, null, 4)
  );
}

async function update_groups_parameters() {
  console.log(`updating team06dbb7fcPreTokenGeneration lambda parameters"...`);

  const groupsParametersJsonPath = path.resolve(
    `./amplify/backend/function/team06dbb7fcPreTokenGeneration/parameters.json`
  );
  const groupsParametersJson = require(groupsParametersJsonPath);

  groupsParametersJson.teamAdminGroup = TEAM_ADMIN_GROUP;
  groupsParametersJson.teamAuditorGroup = TEAM_AUDITOR_GROUP;

  fs.writeFileSync(
    groupsParametersJsonPath,
    JSON.stringify(groupsParametersJson, null, 4)
  );
}

async function update_router_parameters() {
  console.log(`updating teamRouter lambda parameters"...`);

  const routerParametersJsonPath = path.resolve(
    `./amplify/backend/function/teamRouter/parameters.json`
  );
  const routerParametersJson = require(routerParametersJsonPath);

  routerParametersJson.SSOLoginUrl = SSO_LOGIN;

  fs.writeFileSync(
    routerParametersJsonPath,
    JSON.stringify(routerParametersJson, null, 4)
  );
}

async function update_tag_parameters() {
  console.log(`updating amplify/backend/tags.json"...`);

  const tagsParametersJsonPath = path.resolve(
    `./amplify/backend/tags.json`
  );

  const tagsArray = TAGS ? TAGS.split(' ').map((tag) => {
    const [key, value] = tag.split('=');
    return {
      Key: key,
      Value: value,
    };
  }) : [];

  fs.writeFileSync(tagsParametersJsonPath, JSON.stringify(tagsArray, null, 2));
}

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
    next.SourceRegions = [...new Set(regions)].join(",");
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

if (require.main === module) {
  update_auth_parameters();
  update_react_parameters();
  update_groups_parameters();
  update_router_parameters();
  update_tag_parameters();
  update_audit_log_parameters();
}

module.exports = { buildAuditLogParameters, resolveOrganizationId };
