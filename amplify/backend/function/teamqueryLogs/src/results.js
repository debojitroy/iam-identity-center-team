//  © 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
//  This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
//  http: // aws.amazon.com/agreement or other written agreement between Customer and either
//  Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.

// Logs Insights adds an opaque pointer to every row; the UI has no use for it.
const POINTER_FIELD = "@ptr";

function mapQueryResults(rows = []) {
  return rows.map((row) =>
    Object.fromEntries(
      row
        .filter(({ field }) => field !== POINTER_FIELD)
        .map(({ field, value }) => [field, value])
    )
  );
}

module.exports = { mapQueryResults };
