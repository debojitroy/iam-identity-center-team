import { test } from "node:test";
import assert from "node:assert/strict";
import results from "../src/results.js";

const { mapQueryResults } = results;

test("mapQueryResults turns field/value rows into objects without @ptr", () => {
  const rows = [
    [
      { field: "eventID", value: "e-1" },
      { field: "eventName", value: "ListBuckets" },
      { field: "eventSource", value: "s3.amazonaws.com" },
      { field: "eventTime", value: "2026-10-14T01:05:00Z" },
      { field: "@ptr", value: "opaque" },
    ],
  ];
  assert.deepEqual(mapQueryResults(rows), [
    { eventID: "e-1", eventName: "ListBuckets", eventSource: "s3.amazonaws.com", eventTime: "2026-10-14T01:05:00Z" },
  ]);
});

test("mapQueryResults returns an empty list when there are no rows", () => {
  assert.deepEqual(mapQueryResults(undefined), []);
  assert.deepEqual(mapQueryResults([]), []);
});
