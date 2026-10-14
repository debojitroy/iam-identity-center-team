---
layout: default
title: Update
nav_order: 5
parent: Solution deployment
---

# Update TEAM solution

Ensure that the **parameters.sh** in the **deployment** folder is up to date before updating the TEAM solution
{: .note}

## Upgrading from CloudTrail Lake

Earlier versions of TEAM read session activity from a CloudTrail Lake event data store. This version reads it from Amazon CloudWatch Logs. Complete these steps before running the normal update:

1. Export any CloudTrail Lake history you need (**CloudTrail console -> Lake -> Event data stores -> Actions -> Export to CloudWatch**).
   > The upgrade deletes the TEAM event data store. Its history cannot be recovered after the update.
   {: .warning}
2. Pull the new **init.sh** changes and re-run `./init.sh` from the organization management account. This registers the TEAM account as the CloudWatch delegated administrator and starts organization telemetry configuration. The auditLogs stack fails without it.
   > For management-account deployments, **update.sh** performs this step.
   {: .note}
3. In **parameters.sh**, change `CLOUDTRAIL_AUDIT_LOGS` from an event data store ARN to `read`, `write`, `read_write` or `none`. ARNs are rejected.
4. Run `./update.sh` as described below.

## Update steps

Run the **update.sh** bash script in the **deployment** folder to update the TEAM application to the latest version.

The **update.sh** bash script performs the following actions:

- Adds the AWS samples github repo as a git remote
- Pulls the latest version of the TEAM code
- Push the latest version to the TEAM code commit repo
- Deploys an AWS CloudFormation stack which triggers the amplify build and deployment
- Removes the AWS samples github repo as a git remote

  > Ensure that the named profile for the **TEAM Deployment account** has sufficient permissions before executing the **update.sh** script

Execute the following command in the root directory to deploy the script

```
cd deployment
./update.sh
```

Once the upgrade script has completed execution, go to the AWS Amplify console to monitor the status of the TEAM application build and deployment.


## Verify app deployment
Go to Amplify console: **AWS Amplify -> All apps -> TEAM-IDC-APP -> Hosting environments**. On the **Hosting environments** tab, click on the application URL to confirm that it was deployed successfully and you can access the TEAM application landing page as shown in the video below:

<video width="750" height="420" frameborder="0" allowfullscreen controls>
<source src="https://d3f99z5n3ls8r1.cloudfront.net/videos/deployment/successful_app_deployment.mov" type="video/mp4">
</video>

{: .no_toc}
