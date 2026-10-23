import test from "node:test";
import assert from "node:assert/strict";
import {
  accountCapabilities,
  accountRoles,
  roleCapabilities,
} from "../../src/server/services/hr-service.js";
import { effectiveCapabilities } from "../../src/server/domain/role-capabilities.js";

test("portal roles resolve only to server-defined capabilities", () => {
  assert.deepEqual(accountCapabilities(["Employee"]), roleCapabilities.Employee);
  assert.deepEqual(
    accountCapabilities(["Reporting Manager"]),
    roleCapabilities["Reporting Manager"],
  );
  assert.deepEqual(
    accountCapabilities(["HR Manager"]),
    roleCapabilities["HR Manager"],
  );
  assert.throws(
    () => accountCapabilities(["Platform Administrator"]),
    (error) => error.status === 422,
  );
  for (const employeeCapability of roleCapabilities.Employee) {
    assert.ok(roleCapabilities["Reporting Manager"].includes(employeeCapability));
    assert.ok(roleCapabilities["HR Manager"].includes(employeeCapability));
  }
});

test("stored capabilities resolve to the role shown in the directory", () => {
  assert.deepEqual(accountRoles(roleCapabilities.Employee), ["Employee"]);
  assert.deepEqual(
    accountRoles(roleCapabilities["Reporting Manager"]),
    ["Reporting Manager"],
  );
  assert.deepEqual(accountRoles(roleCapabilities["HR Manager"]), ["HR Manager"]);
});

test("older elevated assignments regain personal employee actions at runtime", () => {
  assert.ok(effectiveCapabilities(["leave:approve"]).includes("attendance:write"));
  assert.ok(effectiveCapabilities(["users:write"]).includes("attendance:write"));
  assert.deepEqual(effectiveCapabilities([]), []);
});
