import assert from "node:assert/strict";
import { transitions } from "../../src/server/services/workflow-service.js";
import { schema } from "../../src/server/validation/schema-validator.js";

assert.deepEqual(transitions.leave.submit, ["draft", "pending"]);
assert.deepEqual(transitions.leave.approve, ["pending", "approved"]);
assert.deepEqual(transitions.leave.cancel, ["approved", "cancelled"]);
assert.deepEqual(transitions.adjustment.reject, ["pending", "rejected"]);
assert.deepEqual(transitions.alert.resolve, ["acknowledged", "resolved"]);
assert.equal(schema.$defs.LeaveBalance.properties.remaining.type, "number");
assert.equal(schema.$defs.AttendanceSession.properties.version.type, "integer");
assert.equal(schema.$defs.User.properties.capabilities.type, "array");
console.log("Domain transition and canonical type assertions passed.");
