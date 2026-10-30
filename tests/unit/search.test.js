import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSearchQuery } from "../../src/shared/search.js";

test("report searches normalize whitespace and control characters", () => {
  assert.equal(normalizeSearchQuery("  Je\n\tRegalado  "), "Je Regalado");
});

test("report searches normalize Unicode and enforce a safe length", () => {
  assert.equal(normalizeSearchQuery("\uFF2A\uFF45", 10), "Je");
  assert.equal(normalizeSearchQuery("x".repeat(120)).length, 100);
});

test("report searches preserve wildcard characters as literal input", () => {
  assert.equal(normalizeSearchQuery("Aki_100%"), "Aki_100%");
});
