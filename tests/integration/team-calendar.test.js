import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

test("team calendar includes denied requests without adding them to dashboard coverage", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.JWT_SECRET ||= "integration-jwt-secret-that-is-long-enough";
  process.env.CSRF_SECRET ||= "integration-csrf-secret-that-is-long-enough";
  const { createApp } = await import("../../src/server/app.js");
  const manager = request.agent(createApp());
  const login = await manager.post("/api/v1/auth/login").send({
    email: "manager@dev.local",
    password: process.env.SEED_USER_PASSWORD,
  });
  assert.equal(login.status, 200);

  const calendar = await manager.get("/api/v1/team/calendar");
  assert.equal(calendar.status, 200);
  assert.ok(calendar.body.some((row) => row.request_id === "leave-jamie-rejected" && row.status === "rejected"));

  const dashboard = await manager.get("/api/v1/team/dashboard");
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.body.upcoming_leave.every((row) => row.status !== "rejected"));
});
