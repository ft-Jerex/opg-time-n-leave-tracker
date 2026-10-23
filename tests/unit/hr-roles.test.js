import test from "node:test";
import assert from "node:assert/strict";
import {
  accountCapabilities,
  accountRoles,
  roleCapabilities,
} from "../../src/server/services/hr-service.js";

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
});

test("stored capabilities resolve to the role shown in the directory", () => {
  assert.deepEqual(accountRoles(roleCapabilities.Employee), ["Employee"]);
  assert.deepEqual(
    accountRoles(roleCapabilities["Reporting Manager"]),
    ["Reporting Manager"],
  );
  assert.deepEqual(accountRoles(roleCapabilities["HR Manager"]), ["HR Manager"]);
});
