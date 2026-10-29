import { HttpError } from "../views/problem-view.js";

export const resources = {
  tenants: ["Tenant", "tenants", "tenant_id"],
  users: ["User", "users", "user_id"],
  employees: ["Employee", "employees", "employee_id"],
  departments: ["Department", "departments", "department_id"],
  locations: ["Location", "locations", "location_id"],
  "work-schedules": ["WorkSchedule", "work_schedules", "schedule_id"],
  "job-profiles": ["JobProfile", "job_profiles", "job_id"],
  "attendance-sessions": [
    "AttendanceSession",
    "attendance_sessions",
    "session_id",
  ],
  "attendance-summaries": [
    "AttendanceSummary",
    "attendance_summaries",
    "summary_id",
  ],
  "attendance-adjustments": [
    "AttendanceAdjustment",
    "attendance_adjustments",
    "adjustment_id",
  ],
  "leave-types": ["LeaveType", "leave_types", "leave_type_id"],
  "job-leave-policies": ["JobLeavePolicy", "job_leave_policies", "policy_id"],
  "leave-balances": ["LeaveBalance", "leave_balances", "balance_id"],
  "leave-ledger-entries": [
    "LeaveLedgerEntry",
    "leave_ledger_entries",
    "entry_id",
  ],
  "leave-requests": ["LeaveRequest", "leave_requests", "request_id"],
  "overtime-requests": ["OvertimeRequest", "overtime_requests", "overtime_request_id"],
  attachments: ["Attachment", "attachments", "attachment_id"],
  "holiday-calendars": [
    "HolidayCalendar",
    "holiday_calendars",
    "holiday_calendar_id",
  ],
  holidays: ["Holiday", "holidays", "holiday_id"],
  alerts: ["Alert", "alerts", "alert_id"],
  "audit-events": ["AuditEvent", "audit_events", "event_id"],
};

const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
const sortable = new Set([
  "created_at",
  "occurred_at",
  "clock_in_at",
  "local_date",
  "start_date",
  "end_date",
  "name",
  "status",
]);
const defaultSortByTable = {
  attendance_sessions: "clock_in_at",
  attendance_summaries: "local_date",
  leave_requests: "start_date",
};

const listOrder = async (client, table, idColumn, query) => {
  const requested = sortable.has(query.sort) ? query.sort : null;
  const preferred = requested || defaultSortByTable[table];
  const column = preferred && await hasColumn(client, table, preferred)
    ? preferred
    : idColumn;
  return {
    order: quote(column),
    direction: String(query.direction).toLowerCase() === "asc" ? "ASC" : "DESC",
  };
};

export const list = async (client, resource, tenantId, query = {}) => {
  const [, table] = resources[resource] || [];
  if (!table) throw new HttpError(404, "Not Found", "Unknown resource.");
  const limit = Math.min(Math.max(Number(query.page_size || query.limit || 100), 1), 500);
  const offset = query.page
    ? Math.max((Number(query.page) - 1) * limit, 0)
    : Math.max(Number(query.offset || 0), 0);
  const { order, direction } = await listOrder(
    client,
    table,
    resources[resource][2],
    query,
  );
  const { where, values } = await listFilters(client, resource, table, query, [tenantId]);
  const result = await client.query(
    `SELECT *, count(*) OVER() AS __total_count FROM ${quote(table)} WHERE ${where.join(" AND ")} ORDER BY ${order} ${direction}, ${quote(resources[resource][2])} ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );
  const total = Number(result.rows[0]?.__total_count || 0);
  return {
    rows: result.rows.map(({ __total_count, ...row }) => row),
    total,
    limit,
    offset,
  };
};

export const listForEmployees = async (
  client,
  resource,
  tenantId,
  employeeIds,
  query = {},
) => {
  const [, table, idColumn] = resources[resource] || [];
  if (!table) throw new HttpError(404, "Not Found", "Unknown resource.");
  const limit = Math.min(Math.max(Number(query.page_size || query.limit || 100), 1), 500);
  const offset = query.page
    ? Math.max((Number(query.page) - 1) * limit, 0)
    : Math.max(Number(query.offset || 0), 0);
  const { where, values } = await listFilters(
    client,
    resource,
    table,
    query,
    [tenantId, employeeIds],
    { employeeScope: true },
  );
  const { order, direction } = await listOrder(client, table, idColumn, query);
  const result = await client.query(
    `SELECT *, count(*) OVER() AS __total_count FROM ${quote(table)} WHERE ${where.join(" AND ")} ORDER BY ${order} ${direction}, ${quote(idColumn)} ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );
  const total = Number(result.rows[0]?.__total_count || 0);
  return {
    rows: result.rows.map(({ __total_count, ...row }) => row),
    total,
    limit,
    offset,
  };
};

const searchColumns = {
  employees: ["employee_id", "employee_number", "name"],
  departments: ["department_id", "name", "code"],
  locations: ["location_id", "name"],
  job_profiles: ["job_id", "title"],
  leave_types: ["leave_type_id", "name", "code", "description"],
  leave_requests: ["request_id", "employee_id", "leave_type_id", "reason", "status"],
  overtime_requests: ["overtime_request_id", "employee_id", "reason", "status"],
  attendance_summaries: ["summary_id", "employee_id", "status"],
  attendance_adjustments: ["adjustment_id", "employee_id", "reason", "status"],
  attendance_sessions: ["session_id", "employee_id", "status"],
  holidays: ["holiday_id", "name", "description", "observance_type"],
  alerts: ["alert_id", "employee_id", "type", "severity", "status"],
  audit_events: ["event_id", "action", "target_type", "target_id", "reason"],
};

const filterMap = {
  employee_id: "employee_id",
  manager_id: "manager_id",
  department_id: "department_id",
  job_id: "job_id",
  location_id: "location_id",
  leave_type_id: "leave_type_id",
  status: "status",
  severity: "severity",
  local_date: "local_date",
};

const listFilters = async (client, resource, table, query, initialValues, options = {}) => {
  const values = [...initialValues];
  const where = ["tenant_id = $1"];
  if (options.employeeScope) where.push(`employee_id = ANY($2::text[])`);
  const add = (sql, value) => {
    values.push(value);
    where.push(sql.replace("$VALUE", `$${values.length}`));
  };
  for (const [key, column] of Object.entries(filterMap)) {
    if (query[key] !== undefined && query[key] !== "" && await hasColumn(client, table, column))
      add(`${quote(column)} = $VALUE`, String(query[key]));
  }
  if (query.q) {
    const columns = [];
    for (const column of searchColumns[table] || [])
      if (await hasColumn(client, table, column)) columns.push(column);
    if (columns.length) {
      values.push(`%${String(query.q).slice(0, 120)}%`);
      const parameter = `$${values.length}`;
      where.push(`(${columns.map((column) => `${quote(column)}::text ILIKE ${parameter}`).join(" OR ")})`);
    }
  }
  for (const [key, operator] of [["from", ">="], ["to", "<="]]) {
    const column = resource === "attendance-summaries" || resource === "attendance-sessions" ? "local_date" : resource === "leave-requests" ? (key === "from" ? "end_date" : "start_date") : "local_date";
    if (query[key] && await hasColumn(client, table, column)) add(`${quote(column)} ${operator} $VALUE`, query[key]);
  }
  return { where, values };
};

const columnCache = new Map();
const hasColumn = async (client, table, column) => {
  const key = `${table}:${column}`;
  if (columnCache.has(key)) return columnCache.get(key);
  const result = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
    [table, column],
  );
  const found = result.rowCount > 0;
  columnCache.set(key, found);
  return found;
};

export const findOne = async (
  client,
  resource,
  tenantId,
  id,
  { forUpdate = false } = {},
) => {
  const [, table, idColumn] = resources[resource] || [];
  if (!table) throw new HttpError(404, "Not Found", "Unknown resource.");
  const result = await client.query(
    `SELECT * FROM ${quote(table)} WHERE tenant_id = $1 AND ${quote(idColumn)} = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, id],
  );
  if (!result.rowCount)
    throw new HttpError(404, "Not Found", "Resource not found.");
  return result.rows[0];
};

export const insert = async (client, resource, tenantId, entity) => {
  const [entityName, table] = resources[resource] || [];
  if (!table) throw new HttpError(404, "Not Found", "Unknown resource.");
  const payload = { ...entity, tenant_id: tenantId };
  const fields = Object.keys(payload);
  const values = fields.map((field) => payload[field]);
  const result = await client.query(
    `INSERT INTO ${quote(table)} (${fields.map(quote).join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
    values,
  );
  return result.rows[0];
};

export const replace = async (
  client,
  resource,
  tenantId,
  id,
  entity,
  expectedVersion,
) => {
  const [entityName, table, idColumn] = resources[resource] || [];
  if (!table) throw new HttpError(404, "Not Found", "Unknown resource.");
  const payload = { ...entity, tenant_id: tenantId };
  delete payload[idColumn];
  delete payload.tenant_id;
  const fields = Object.keys(payload);
  const values = fields.map((field) => payload[field]);
  const versioned = Object.prototype.hasOwnProperty.call(payload, "version");
  const where = [
    `tenant_id = $${values.length + 1}`,
    `${quote(idColumn)} = $${values.length + 2}`,
  ];
  const whereValues = [tenantId, id];
  if (versioned && expectedVersion !== undefined) {
    where.push(`version = $${values.length + 3}`);
    whereValues.push(expectedVersion);
  }
  const sets = fields.map((field, i) => `${quote(field)} = $${i + 1}`);
  const result = await client.query(
    `UPDATE ${quote(table)} SET ${sets.join(",")} WHERE ${where.join(" AND ")} RETURNING *`,
    [...values, ...whereValues],
  );
  if (!result.rowCount)
    throw new HttpError(
      versioned && expectedVersion !== undefined ? 409 : 404,
      versioned ? "Stale Resource" : "Not Found",
      versioned
        ? "The resource changed; refresh before retrying."
        : "Resource not found.",
    );
  return result.rows[0];
};

export const remove = async (
  client,
  resource,
  tenantId,
  id,
  expectedVersion,
) => {
  const [, table, idColumn] = resources[resource] || [];
  if (!table) throw new HttpError(404, "Not Found", "Unknown resource.");
  const values = [tenantId, id];
  const where = ["tenant_id = $1", `${quote(idColumn)} = $2`];
  if (expectedVersion !== undefined) {
    values.push(expectedVersion);
    where.push(`version = $3`);
  }
  const result = await client.query(
    `DELETE FROM ${quote(table)} WHERE ${where.join(" AND ")} RETURNING *`,
    values,
  );
  if (!result.rowCount)
    throw new HttpError(
      expectedVersion === undefined ? 404 : 409,
      expectedVersion === undefined ? "Not Found" : "Stale Resource",
      expectedVersion === undefined
        ? "Resource not found."
        : "The resource changed; refresh before retrying.",
    );
  return result.rows[0];
};
