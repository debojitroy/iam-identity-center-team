import { test } from "node:test";
import assert from "node:assert/strict";
import queryLogs from "../src/index.js";

const { createHandler } = queryLogs;

const clientReturning = (response) => {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command.input);
      if (response instanceof Error) throw response;
      return response;
    },
  };
};
const namedError = (name) => Object.assign(new Error(name), { name });

test("returns mapped rows for a completed query", async () => {
  const logsClient = clientReturning({ status: "Complete", results: [[{ field: "eventID", value: "e-1" }]] });
  const rows = await createHandler({ logsClient })({ arguments: { queryId: "q-1" } });
  assert.deepEqual(logsClient.calls, [{ queryId: "q-1" }]);
  assert.deepEqual(rows, [{ eventID: "e-1" }]);
});

test("returns no rows while the query is still running", async () => {
  const logsClient = clientReturning({ status: "Running", results: [] });
  assert.deepEqual(await createHandler({ logsClient })({ arguments: { queryId: "q-1" } }), []);
});

test("returns no rows without calling CloudWatch when queryId is missing", async () => {
  const logsClient = clientReturning({ status: "Complete", results: [] });
  assert.deepEqual(await createHandler({ logsClient })({ arguments: {} }), []);
  assert.deepEqual(logsClient.calls, []);
});

test("returns no rows for expired or unknown query IDs", async () => {
  for (const name of ["ResourceNotFoundException", "InvalidParameterException"]) {
    const logsClient = clientReturning(namedError(name));
    assert.deepEqual(await createHandler({ logsClient })({ arguments: { queryId: "q-old" } }), [], name);
  }
});

test("rethrows unexpected errors", async () => {
  const logsClient = clientReturning(namedError("ServiceUnavailableException"));
  await assert.rejects(createHandler({ logsClient })({ arguments: { queryId: "q-1" } }), /ServiceUnavailableException/);
});
