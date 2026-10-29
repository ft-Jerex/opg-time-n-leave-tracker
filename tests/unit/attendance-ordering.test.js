import test from "node:test";
import assert from "node:assert/strict";
import { list } from "../../src/server/models/resource-model.js";

const listingClient = (row) => {
  const statements = [];
  return {
    statements,
    async query(sql) {
      statements.push(sql);
      if (sql.includes("information_schema.columns"))
        return { rowCount: 1, rows: [{ present: 1 }] };
      return { rowCount: 1, rows: [{ ...row, __total_count: "1" }] };
    },
  };
};

test("attendance summaries load newest dates first so fresh overrides stay visible", async () => {
  const client = listingClient({ summary_id: "summary-1" });
  await list(client, "attendance-summaries", "tenant-1");
  assert.match(client.statements.at(-1), /ORDER BY "local_date" DESC/);
});

test("attendance sessions load newest clock-ins first so fresh punches stay visible", async () => {
  const client = listingClient({ session_id: "session-1" });
  await list(client, "attendance-sessions", "tenant-1");
  assert.match(client.statements.at(-1), /ORDER BY "clock_in_at" DESC/);
});
