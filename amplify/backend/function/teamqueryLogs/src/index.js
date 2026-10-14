//  © 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
//  This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
//  http: // aws.amazon.com/agreement or other written agreement between Customer and either
//  Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
const {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
} = require("@aws-sdk/client-cloudwatch-logs");
const { mapQueryResults } = require("./results");

// Logs Insights keeps query results for 7 days; older or unknown IDs return these errors.
const EXPIRED_QUERY_ERRORS = new Set(["ResourceNotFoundException", "InvalidParameterException"]);

function createHandler({ logsClient }) {
  return async (event) => {
    const queryId = event?.arguments?.queryId;
    if (!queryId) return [];

    try {
      const { status, results } = await logsClient.send(new GetQueryResultsCommand({ queryId }));
      if (status !== "Complete") {
        console.warn(`Query ${queryId} is ${status}; returning no rows`);
        return [];
      }
      return mapQueryResults(results);
    } catch (err) {
      if (EXPIRED_QUERY_ERRORS.has(err.name)) {
        console.warn(`Query ${queryId} is unavailable: ${err.message}`);
        return [];
      }
      throw err;
    }
  };
}

const handler = createHandler({
  logsClient: new CloudWatchLogsClient({ region: process.env.REGION }),
});

module.exports = { handler, createHandler };
