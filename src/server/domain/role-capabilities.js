const unique = (capabilities) => [...new Set(capabilities)];

export const employeeCapabilities = [
  "attendance:write",
  "attendance-adjustments:write",
  "leave:write",
  "leave-requests:write",
  "overtime-requests:write",
];

export const roleCapabilities = {
  Employee: employeeCapabilities,
  "Reporting Manager": unique([
    ...employeeCapabilities,
    "attendance:approve",
    "leave:approve",
    "overtime:approve",
    "alerts:write",
  ]),
  "HR Manager": unique([
    ...employeeCapabilities,
    "users:write", "departments:write", "job-profiles:write", "leave-types:write",
    "job-leave-policies:write", "leave-balances:write", "leave-ledger-entries:write",
    "leave:approve", "attendance:approve", "attendance:override",
    "overtime:approve", "attachments:write", "alerts:write",
  ]),
};

// Elevated tenant roles always retain normal personal employee actions. This
// also keeps older stored role assignments working until their migration runs.
export const effectiveCapabilities = (capabilities = []) =>
  capabilities.includes("leave:approve") || capabilities.includes("users:write")
    ? unique([...capabilities, ...employeeCapabilities])
    : capabilities;
