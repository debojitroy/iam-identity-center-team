import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/index.js";

const LOG_GROUP = "team-audit-test-cloudtrail";
const image = (overrides = {}) => ({
  id: { S: "session-1" },
  startTime: { S: "2026-10-14T01:00:00.000Z" },
  endTime: { S: "2026-10-14T02:00:00.000Z" },
  username: { S: "idc_jane@example.com" },
  accountId: { S: "123456789012" },
  role: { S: "ReadOnlyAccess" },
  ...overrides,
});
const streamEvent = (...images) => ({ Records: images.map((NewImage) => ({ dynamodb: { NewImage } })) });
const context = (remainingMs = 60000) => ({ getRemainingTimeInMillis: () => remainingMs });

function fakeLogsClient(statuses = ["Complete"], { startError } = {}) {
  const calls = [];
  const pending = [...statuses];
  let started = 0;
  return {
    calls,
    async send(command) {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });
      if (name === "StartQueryCommand") {
        if (startError) throw startError;
        started += 1;
        return { queryId: `q-${started}` };
      }
      return { status: pending.shift() ?? "Running" };
    },
  };
}

function setup(statuses, options) {
  const logsClient = fakeLogsClient(statuses, options);
  const saved = [];
  const waits = [];
  const handler = createHandler({
    logsClient,
    logGroupName: LOG_GROUP,
    saveQueryId: async (id, queryId) => saved.push({ id, queryId }),
    wait: async (ms) => waits.push(ms),
  });
  return { handler, logsClient, saved, waits };
}

test("starts a query over the session window and saves the queryId once complete", async () => {
  const { handler, logsClient, saved, waits } = setup(["Running", "Complete"]);

  await handler(streamEvent(image()), context());

  const start = logsClient.calls[0];
  assert.equal(start.name, "StartQueryCommand");
  assert.deepEqual(start.input.logGroupIdentifiers, [LOG_GROUP]);
  assert.equal(start.input.startTime, 1791939600);
  assert.equal(start.input.endTime, 1791943200);
  assert.match(start.input.queryString, /recipientAccountId = "123456789012"/);
  assert.deepEqual(logsClient.calls.slice(1).map((c) => c.input), [{ queryId: "q-1" }, { queryId: "q-1" }]);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(saved, [{ id: "session-1", queryId: "q-1" }]);
});

test("rejects and does not save the queryId when the query fails", async () => {
  const { handler, saved } = setup(["Failed"]);
  await assert.rejects(handler(streamEvent(image()), context()), /ended with status Failed/);
  assert.deepEqual(saved, []);
});

test("rejects and does not save when the service reports status Timeout", async () => {
  const { handler, saved } = setup(["Timeout"]);
  await assert.rejects(handler(streamEvent(image()), context()), /ended with status Timeout/);
  assert.deepEqual(saved, []);
});

test("rejects when saving the queryId fails", async () => {
  const logsClient = fakeLogsClient(["Complete"]);
  const handler = createHandler({
    logsClient,
    logGroupName: LOG_GROUP,
    saveQueryId: async () => { throw new Error("appsync down"); },
    wait: async () => {},
  });
  await assert.rejects(handler(streamEvent(image()), context()), /appsync down/);
});

test("skips invalid session records without calling CloudWatch", async () => {
  const { handler, logsClient, saved } = setup();
  await handler(streamEvent(image({ accountId: { S: "not-an-account" } })), context());
  assert.deepEqual(logsClient.calls, []);
  assert.deepEqual(saved, []);
});

test("processes every record in the batch", async () => {
  const { handler, saved } = setup(["Complete", "Complete"]);
  await handler(streamEvent(image(), image({ id: { S: "session-2" } })), context());
  assert.deepEqual(saved, [
    { id: "session-1", queryId: "q-1" },
    { id: "session-2", queryId: "q-2" },
  ]);
});

test("saves the queryId and stops polling when the Lambda is about to time out", async () => {
  const { handler, logsClient, saved } = setup(["Running"]);
  await handler(streamEvent(image()), context(1000));
  assert.deepEqual(logsClient.calls.map((c) => c.name), ["StartQueryCommand"]);
  assert.deepEqual(saved, [{ id: "session-1", queryId: "q-1" }]);
});

test("propagates StartQuery errors so the stream retries", async () => {
  const { handler } = setup([], { startError: new Error("throttled") });
  await assert.rejects(handler(streamEvent(image()), context()), /throttled/);
});
