# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Session activity logs now use AWS CloudTrail events in Amazon CloudWatch Logs (organization telemetry enablement rule plus a centralization rule into the TEAM account) instead of AWS CloudTrail Lake, which closed to new customers on 2026-05-31.
- `CLOUDTRAIL_AUDIT_LOGS` accepts only `read`, `write`, `read_write` or `none`; CloudTrail Lake event data store ARNs are no longer supported.
- `init.sh` registers the TEAM account as the Amazon CloudWatch delegated administrator instead of the CloudTrail delegated administrator.

### Removed

- The `cloudtrailLake` Amplify custom resource. Upgrading deletes the existing event data store; export its data to CloudWatch first.

## [1.0.0] - 2023-05-24

### Added

- Initial release