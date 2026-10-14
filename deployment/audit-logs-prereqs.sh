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
    aws iam create-service-linked-role --aws-service-name logs-centralization.observabilityadmin.amazonaws.com || return 1
  fi
}

# Current status of the organization telemetry evaluation.
get_org_telemetry_status() {
  aws observabilityadmin get-telemetry-evaluation-status-for-organization --region "$REGION" --query Status --output text || return 1
}

# Starts the evaluation in all Regions. An already running multi-Region
# operation is not an error; the caller goes straight to waiting.
start_org_telemetry_evaluation() {
  local output
  if output=$(aws observabilityadmin start-telemetry-evaluation-for-organization --region "$REGION" --all-regions 2>&1); then
    return 0
  fi
  if echo "$output" | grep -qi "multi-region operation is currently in progress"; then
    echo "A multi-Region telemetry operation is already in progress; waiting for it to finish"
    return 0
  fi
  echo "$output" >&2
  return 1
}

# Polls every 30 s, up to 20 times, until the status is neither NOT_STARTED
# nor STARTING. The rollout can report NOT_STARTED for several minutes.
# Prints the last status seen.
wait_org_telemetry_settled() {
  local status
  local polls=0
  while [ "$polls" -lt 20 ]; do
    status=$(get_org_telemetry_status) || return 1
    if [ "$status" != "NOT_STARTED" ] && [ "$status" != "STARTING" ]; then
      break
    fi
    polls=$((polls + 1))
    if [ "$polls" -lt 20 ]; then
      sleep 30
    fi
  done
  echo "$status"
}

# Organization-wide CloudWatch telemetry config in every Region; also turns on
# trusted access for CloudWatch. Must run in the management account.
ensure_org_telemetry_evaluation() {
  local status
  local attempt
  status=$(get_org_telemetry_status) || return 1
  if [ "$status" = "RUNNING" ]; then
    return 0
  fi
  for attempt in 1 2; do
    start_org_telemetry_evaluation || return 1
    status=$(wait_org_telemetry_settled) || return 1
    if [ "$status" = "RUNNING" ]; then
      return 0
    fi
    # On a fresh organization the first start creates the service-linked role while fanning out, which can fail with SLR_NOT_READY; a retry succeeds.
    if [ "$status" = "FAILED_START" ] && [ "$attempt" -eq 1 ]; then
      sleep 30
      continue
    fi
    break
  done
  echo "Organization telemetry evaluation did not reach RUNNING (status: $status)" >&2
  return 1
}

# Lets the TEAM account manage organization telemetry and centralization rules.
ensure_cloudwatch_delegated_admin() {
  local account_id=$1
  local registered
  registered=$(aws organizations list-delegated-administrators --service-principal observabilityadmin.amazonaws.com \
    --query "DelegatedAdministrators[?Id=='${account_id}'].Id" --output text) || return 1
  if [ -z "$registered" ]; then
    if aws organizations register-delegated-administrator \
      --account-id "$account_id" \
      --service-principal observabilityadmin.amazonaws.com; then
      echo "$account_id configured as delegated Admin for Amazon CloudWatch"
    else
      echo "Failed to register $account_id as delegated Admin for Amazon CloudWatch" >&2
      return 1
    fi
  else
    echo "$account_id is already configured as delegated Admin for Amazon CloudWatch"
  fi
}
