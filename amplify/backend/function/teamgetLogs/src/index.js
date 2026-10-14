//  © 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
//  This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
//  http: // aws.amazon.com/agreement or other written agreement between Customer and either
//  Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.

/* Amplify Params - DO NOT EDIT
	API_TEAM_GRAPHQLAPIENDPOINTOUTPUT
	API_AWSPIM_GRAPHQLAPIIDOUTPUT
	ENV
	REGION
Amplify Params - DO NOT EDIT */
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { parseSessionImage, buildSessionQuery, isTerminalStatus } from './query.js';
import { updateSessionQueryId } from './appsync.js';

const POLL_INTERVAL_MS = 1000;
// Stop polling while there is still time left to write the result back.
const MIN_REMAINING_MS = 5000;
// Returned by waitForQuery when the Lambda ran out of time, as opposed to the
// Logs Insights service status "Timeout".
const LAMBDA_TIME_EXHAUSTED = "LAMBDA_TIME_EXHAUSTED";

export function createHandler({ logsClient, logGroupName, saveQueryId, wait = sleep }) {
  async function waitForQuery(queryId, context) {
    while (context.getRemainingTimeInMillis() > MIN_REMAINING_MS) {
      const { status } = await logsClient.send(new GetQueryResultsCommand({ queryId }));
      if (isTerminalStatus(status)) return status;
      await wait(POLL_INTERVAL_MS);
    }
    return LAMBDA_TIME_EXHAUSTED;
  }

  async function processRecord(record, context) {
    let session;
    try {
      session = parseSessionImage(record.dynamodb?.NewImage);
    } catch (err) {
      console.error("Skipping session record:", err.message);
      return;
    }

    try {
      const { queryId } = await logsClient.send(new StartQueryCommand({
        logGroupIdentifiers: [logGroupName],
        startTime: session.startTime,
        endTime: session.endTime,
        queryString: buildSessionQuery(session),
      }));

      const status = await waitForQuery(queryId, context);
      if (status === LAMBDA_TIME_EXHAUSTED) {
        // teamqueryLogs returns [] while the query runs; the page re-reads by queryId on refresh.
        await saveQueryId(session.id, queryId);
        console.log(`Query ${queryId} for session ${session.id} still running; saved queryId for later retrieval`);
        return;
      }
      if (status !== "Complete") {
        throw new Error(`Query ${queryId} for session ${session.id} ended with status ${status}`);
      }
      await saveQueryId(session.id, queryId);
      console.log(`Query ${queryId} finished for session ${session.id}`);
    } catch (err) {
      console.error(`Session ${session.id}: audit log query failed`, err);
      throw err;
    }
  }

  return async (event, context) => {
    for (const record of event.Records ?? []) {
      await processRecord(record, context);
    }
  };
}

const REGION = process.env.REGION;

export const handler = createHandler({
  logsClient: new CloudWatchLogsClient({ region: REGION }),
  logGroupName: process.env.AUDIT_LOG_GROUP,
  saveQueryId: (id, queryId) => updateSessionQueryId({
    endpoint: process.env.API_TEAM_GRAPHQLAPIENDPOINTOUTPUT,
    region: REGION,
    id,
    queryId,
  }),
});
