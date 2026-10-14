# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Session activity logs now use AWS CloudTrail events in Amazon CloudWatch Logs (organization telemetry enablement rule plus a centralization rule into the TEAM account) instead of AWS CloudTrail Lake, which closed to new customers on 2026-05-31.
- `CLOUDTRAIL_AUDIT_LOGS` accepts only `read`, `write`, `read_write` or `none`; CloudTrail Lake event data store ARNs are no longer supported.
- `init.sh` registers the TEAM account as the Amazon CloudWatch delegated administrator instead of the CloudTrail delegated administrator.
- `init.sh` waits for CloudWatch telemetry config to reach RUNNING in all Regions and retries once when the first start fails while CloudWatch's service-linked role propagates.

### Security

- Session activity log queries match only the session's own principal and permission set (anchored, case-insensitive match) and validate every value before it reaches the query; the previous CloudTrail Lake SQL interpolated unvalidated values and used substring matches that could include other users' events.
- `uuid` in the `teamgetLogs` and `teamStatus` Lambdas: 8.3.2 -> 11.1.1 (GHSA-w5hq-g745-h8pq).
- `urllib3` in the `teamRouter` and `teamNotifications` Lambdas: 2.7.0 -> 2.8.0 (GHSA-vxq7-64xx-v4gw, GHSA-8988-9cw3-xx77, GHSA-gh4c-6fx4-qh6g).
- `shell-quote` in the frontend: 1.10.0 -> 1.11.0 (command injection via a line terminator in a token after a comment token).
- `proxy-addr` in the frontend: 2.0.7 -> 2.0.8 (IP spoofing via IPv4-mapped IPv6 trust subnet).
- `lodash` in the frontend: 4.17.21 -> 4.18.1 (GHSA-r5fr-rjxr-66jc, GHSA-f23m-r3pf-42rh).

### Removed

- The `cloudtrailLake` Amplify custom resource. Upgrading deletes the existing event data store; export its data to CloudWatch first.

## [1.0.0] - 2023-05-24

### Added

- Initial release