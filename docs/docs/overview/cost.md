---
layout: default
title: Cost considerations
nav_order: 5
parent: Solution overview
---

# Cost considerations

The TEAM solution consists of numerous AWS serverless services. As cost is accrued based on usage of these services there is no consistent cost evaluation that would address all levels of potential usage. In order to get a better understanding of what running this application in your environment may cost, please leverage the [AWS Pricing Calculator](https://calculator.aws).

## AWS services pricing
- [AWS Amplify](https://aws.amazon.com/amplify/pricing/)
- [AWS Appsync](https://aws.amazon.com/appsync/pricing/)
- [Amazon DynamoDB](https://aws.amazon.com/dynamodb/pricing)
- [AWS Lambda](https://aws.amazon.com/lambda/pricing)
- [AWS Step Functions](https://aws.amazon.com/step-functions/pricing)
- [Amazon Cognito](https://aws.amazon.com/cognito/pricing)
- [AWS CloudTrail](https://aws.amazon.com/cloudtrail/pricing/) (service-linked channel event delivery)
- [Amazon CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) (Logs ingestion, storage and Logs Insights queries)
- [AWS IAM Identity Center](https://aws.amazon.com/iam/identity-center/) (free)
- [AWS Secret Manager](https://aws.amazon.com/secrets-manager/)

## Managing audit log cost

TEAM delivers CloudTrail management events to CloudWatch Logs in every account through a [telemetry enablement rule](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/telemetry-config-rules.html) and copies them into one log group in the TEAM account with a [centralization rule](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CloudWatchLogs_Centralization.html). You pay CloudTrail event delivery, CloudWatch Logs ingestion and storage for the member-account and central copies, and Logs Insights for the data each session query scans.

To reduce cost:
- Set **CLOUDTRAIL_AUDIT_LOGS** to `write` to record only mutating calls, or `none` to turn audit logs off.
- Lower `SourceRetentionInDays` (default 7) and `AuditLogRetentionInDays` (default 30) in `amplify/backend/custom/auditLogs/parameters.json`.
- Limit `SourceRegions` (**AUDIT_LOG_REGIONS**) to the Regions your organization uses (keep `us-east-1`). This only reduces the centralized copy and its storage; the telemetry rule collects CloudTrail in all Regions of the organization (`AllRegions`), so member-account ingestion still happens in every Region. Only Regions in `SourceRegions` are centralized into TEAM, so add opt-in Regions explicitly if your organization uses them.
