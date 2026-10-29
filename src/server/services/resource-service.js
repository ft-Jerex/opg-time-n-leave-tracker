import crypto from "node:crypto";
import { withTransaction } from "../config/database.js";
import { HttpError } from "../views/problem-view.js";
import {
  schema,
  validateEntity,
  validateOutput,
} from "../validation/schema-validator.js";
import * as repository from "../models/resource-model.js";
import { partialLeaveCharge } from "../../shared/leave.js";

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const employeeResources = new Set([
  "employees",
  "attendance-sessions",
  "attendance-summaries",
  "attendance-adjustments",
  "leave-balances",
  "leave-ledger-entries",
  "leave-requests",
  "overtime-requests",
  "alerts",
]);

const employeeScope = async (client, req) => {
  if (req.actor.capabilities.includes("users:write")) return null;
  if (req.actor.capabilities.includes("leave:approve") || req.actor.capabilities.includes("overtime:approve")) {
    const result = await client.query(
      "SELECT employee_id FROM employees WHERE tenant_id = $1 AND (employee_id = $2 OR manager_id = $2)",
      [req.tenantId, req.actor.employee_id],
    );
    return result.rows.map((row) => row.employee_id);
  }
  return [req.actor.employee_id];
};

const assertEmployeeScope = async (client, req, employeeId) => {
  if (!employeeId) return;
  const scope = await employeeScope(client, req);
  if (scope && !scope.includes(employeeId))
    throw new HttpError(
      403,
      "Forbidden",
      "The employee is outside your authorized scope.",
    );
};

const parseLocalTime = (value, field) => {
  if (typeof value !== "string" || !/^\d{2}:\d{2}(?::\d{2})?$/.test(value))
    throw new HttpError(422, "Invalid Request", `${field} must use HH:MM format.`);
  const [hours, minutes] = value.slice(0, 5).split(":").map(Number);
  if (hours > 23 || minutes > 59)
    throw new HttpError(422, "Invalid Request", `${field} is not a valid time.`);
  return hours * 60 + minutes;
};

const minutesBetween = (start, end) => parseLocalTime(end, "end_time") - parseLocalTime(start, "start_time");

const assertDomainInvariants = async (
  client,
  resource,
  tenantId,
  payload,
  currentId = null,
) => {
  if (resource === "employees" && payload.manager_id) {
    if (payload.manager_id === payload.employee_id)
      throw new HttpError(
        422,
        "Invalid Hierarchy",
        "An employee cannot manage itself.",
      );
    const cycle = await client.query(
      `WITH RECURSIVE chain(employee_id, manager_id) AS (SELECT employee_id, manager_id FROM employees WHERE tenant_id = $1 AND employee_id = $2 UNION ALL SELECT e.employee_id, e.manager_id FROM employees e JOIN chain c ON e.employee_id = c.manager_id WHERE e.tenant_id = $1) SELECT 1 FROM chain WHERE employee_id = $3 LIMIT 1`,
      [tenantId, payload.manager_id, payload.employee_id],
    );
    if (cycle.rowCount)
      throw new HttpError(
        422,
        "Invalid Hierarchy",
        "The manager assignment would create a reporting cycle.",
      );
  }
  if (resource === "departments" && payload.status === "active") {
    const duplicate = await client.query(
      "SELECT 1 FROM departments WHERE tenant_id=$1 AND status='active' AND (lower(name)=lower($2) OR lower(code)=lower($3)) AND department_id<>COALESCE($4,'') LIMIT 1",
      [tenantId, payload.name, payload.code, currentId],
    );
    if (duplicate.rowCount)
      throw new HttpError(409, "Duplicate Department", "An active department already uses that name or code.");
  }
  if (resource === "job-profiles" && payload.status === "active") {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `job-profile:${tenantId}:${String(payload.title).toLowerCase()}:${payload.department_id}:${payload.effective_from}`,
    ]);
    const duplicate = await client.query(
      `SELECT 1 FROM job_profiles
       WHERE tenant_id=$1 AND status='active'
         AND lower(title)=lower($2)
         AND department_id=$3
         AND effective_from=$4
         AND job_id<>COALESCE($5,'')
       LIMIT 1`,
      [tenantId, payload.title, payload.department_id, payload.effective_from, currentId],
    );
    if (duplicate.rowCount)
      throw new HttpError(
        409,
        "Duplicate Job Profile",
        "An active job profile with this title, department, and effective date already exists.",
      );
  }
  if (resource === "job-leave-policies") {
    const resetFrequency = payload.accrual_rule?.reset_frequency ?? "annually";
    if (!["annually", "monthly"].includes(resetFrequency))
      throw new HttpError(
        422,
        "Invalid Reset Frequency",
        "Balance reset frequency must be annually or monthly.",
      );
    if (resetFrequency === "monthly" && payload.accrual_rule?.type !== "monthly")
      throw new HttpError(
        422,
        "Incompatible Reset Frequency",
        "Monthly balance resets require a monthly accrual policy.",
      );
    if (payload.annual_allotment < 0 || payload.carry_over_limit < 0)
      throw new HttpError(
        422,
        "Invalid Leave Allowance",
        "Annual allowance and carry-over limit cannot be negative.",
      );
  }
  if (resource === "job-leave-policies" && payload.status === "active") {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `policy:${tenantId}:${payload.job_id}:${payload.leave_type_id}`,
    ]);
    const overlap = await client.query(
      `SELECT 1 FROM job_leave_policies WHERE tenant_id = $1 AND job_id = $2 AND leave_type_id = $3 AND status = 'active' AND ($4::date IS NULL OR effective_to IS NULL OR effective_to >= $4::date) AND ($5::date IS NULL OR effective_from <= $5::date) AND policy_id <> COALESCE($6, '') LIMIT 1`,
      [
        tenantId,
        payload.job_id,
        payload.leave_type_id,
        payload.effective_from,
        payload.effective_to,
        currentId,
      ],
    );
    if (overlap.rowCount)
      throw new HttpError(
        409,
        "Overlapping Policy",
        "An active policy already covers this job, leave type, and effective period.",
      );
  }
  if (resource === "holidays" && payload.status === "active") {
    const duplicate = await client.query(
      "SELECT 1 FROM holidays WHERE tenant_id=$1 AND holiday_calendar_id=$2 AND local_date=$3 AND status='active' AND holiday_id <> COALESCE($4,'') LIMIT 1",
      [tenantId, payload.holiday_calendar_id, payload.local_date, currentId],
    );
    if (duplicate.rowCount)
      throw new HttpError(
        409,
        "Duplicate Holiday",
        "An active holiday already exists on this calendar and date.",
      );
  }
  if (resource === "leave-balances") {
    const expected =
      payload.accrued +
      payload.carried_over +
      payload.manual_adjustments -
      payload.used;
    if (payload.remaining !== expected)
      throw new HttpError(
        422,
        "Invalid Balance",
        "remaining must equal accrued + carried_over + manual_adjustments - used.",
      );
  }
  if (resource === "leave-requests" && payload.end_date < payload.start_date)
    throw new HttpError(
      422,
      "Invalid Leave Period",
      "The end date must not be before the start date.",
    );
  if (resource === "leave-requests") {
    if (payload.partial_day === "custom_hours") {
      if (payload.start_date !== payload.end_date)
        throw new HttpError(422, "Invalid Leave Period", "Custom-hour leave must use one date.");
      const minutes = minutesBetween(payload.partial_start_time, payload.partial_end_time);
      if (minutes <= 0)
        throw new HttpError(422, "Invalid Leave Period", "The partial leave interval must be positive.");
      payload.partial_minutes = minutes;
    } else if (payload.partial_start_time || payload.partial_end_time || (payload.partial_minutes !== null && payload.partial_minutes !== undefined)) {
      throw new HttpError(422, "Invalid Leave Period", "Partial start and end times are only valid for custom-hour leave.");
    }
  }
  if (resource === "overtime-requests") {
    if (payload.status !== "draft")
      throw new HttpError(422, "Invalid Overtime", "New overtime requests must start as drafts.");
    if (payload.approver_id)
      throw new HttpError(422, "Invalid Overtime", "The approver is assigned from the employee reporting line.");
    const minutes = minutesBetween(payload.start_time, payload.end_time);
    if (minutes <= 0)
      throw new HttpError(422, "Invalid Overtime", "end_time must be after start_time.");
    if (Number(payload.requested_mins) !== minutes)
      throw new HttpError(422, "Invalid Overtime", "requested_mins must match the requested interval.");
    if (typeof payload.reason !== "string" || !payload.reason.trim())
      throw new HttpError(422, "Invalid Overtime", "A reason is required.");
  }
  if (
    ["leave-requests", "attendance-adjustments"].includes(resource) &&
    payload.attachment_ids?.length
  ) {
    const attachments = await client.query(
      "SELECT attachment_id FROM attachments WHERE tenant_id = $1 AND attachment_id = ANY($2::text[]) AND validation_status = 'accepted'",
      [tenantId, payload.attachment_ids],
    );
    if (attachments.rowCount !== new Set(payload.attachment_ids).size)
      throw new HttpError(
        422,
        "Invalid Attachment",
        "Every attachment must exist in the tenant and pass validation.",
      );
  }
  if (resource === "attachments") {
    const allowed = new Set(["application/pdf", "image/jpeg", "image/png"]);
    if (!allowed.has(payload.mime_type))
      throw new HttpError(
        422,
        "Invalid Attachment",
        "Only PDF, JPEG, and PNG attachments are supported.",
      );
    if (payload.size_bytes > 10 * 1024 * 1024)
      throw new HttpError(
        422,
        "Invalid Attachment",
        "Attachments must not exceed 10 MB.",
      );
    if (!/^[^\\/:*?"<>|]{1,255}$/.test(payload.file_name))
      throw new HttpError(
        422,
        "Invalid Attachment",
        "The attachment file name is invalid.",
      );
  }
};

export const listResource = (resource) => async (req) =>
  withTransaction(async (client) => {
    const scope = employeeResources.has(resource)
      ? await employeeScope(client, req)
      : null;
    const result = scope
      ? await repository.listForEmployees(
          client,
          resource,
          req.tenantId,
          scope,
          req.query,
        )
      : await repository.list(client, resource, req.tenantId, req.query);
    const rows = result.rows.map((row) =>
      validateOutput(repository.resources[resource][0], row),
    );
    Object.defineProperty(rows, "pagination", {
      value: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      },
      enumerable: false,
    });
    return rows;
  });

export const getResource = (resource) => async (req) =>
  withTransaction(async (client) => {
    const row = await repository.findOne(
      client,
      resource,
      req.tenantId,
      req.params.id,
    );
    const scope = employeeResources.has(resource)
      ? await employeeScope(client, req)
      : null;
    if (scope && !scope.includes(row.employee_id))
      throw new HttpError(404, "Not Found", "Resource not found.");
    return validateOutput(repository.resources[resource][0], row);
  });

export const createResource = (resource) => async (req) =>
  withTransaction(async (client) => {
    const entityName = repository.resources[resource][0];
    const payload = { ...req.body, tenant_id: req.tenantId };
    const idField = repository.resources[resource][2];
    if (!payload[idField]) payload[idField] = id();
    if (resource === "overtime-requests") {
      payload.status ??= "draft";
      payload.approver_id ??= null;
      payload.submitted_at ??= null;
      payload.decided_at ??= null;
      payload.decision_note ??= null;
      payload.version ??= 0;
      payload.created_at ??= now();
      if (!req.actor.capabilities.includes("users:write") && payload.employee_id !== req.actor.employee_id)
        throw new HttpError(403, "Forbidden", "Employees may only submit overtime for themselves.");
    }
    validateEntity(entityName, payload);
    if (employeeResources.has(resource))
      await assertEmployeeScope(client, req, payload.employee_id);
    await assertDomainInvariants(client, resource, req.tenantId, payload);
    const row = await repository.insert(
      client,
      resource,
      req.tenantId,
      payload,
    );
    if (resource === "leave-ledger-entries") {
      const balance = await client.query(
        "SELECT balance_id FROM leave_balances WHERE tenant_id=$1 AND employee_id=$2 AND leave_type_id=$3 ORDER BY as_of DESC LIMIT 1 FOR UPDATE",
        [req.tenantId, row.employee_id, row.leave_type_id],
      );
      if (!balance.rowCount)
        throw new HttpError(
          422,
          "Missing Balance",
          "No leave balance exists for this employee and leave type.",
        );
      if (row.entry_type === "manual_adjustment")
        await client.query(
          "UPDATE leave_balances SET manual_adjustments=manual_adjustments+$1, remaining=remaining+$1, as_of=$2 WHERE tenant_id=$3 AND balance_id=$4",
          [
            row.amount,
            row.effective_date,
            req.tenantId,
            balance.rows[0].balance_id,
          ],
        );
    }
    await audit(client, req, "resource_create", entityName, row[idField]);
    return validateOutput(entityName, row);
  });

export const replaceResource = (resource) => async (req) =>
  withTransaction(async (client) => {
    const entityName = repository.resources[resource][0];
    if (
      Object.prototype.hasOwnProperty.call(
        schema.$defs[entityName].properties,
        "version",
      ) &&
      req.expectedVersion === undefined
    )
      throw new HttpError(
        428,
        "Precondition Required",
        "If-Match is required for versioned resources.",
      );
    const payload = {
      ...req.body,
      [repository.resources[resource][2]]: req.params.id,
      tenant_id: req.tenantId,
    };
    validateEntity(entityName, payload);
    if (employeeResources.has(resource))
      await assertEmployeeScope(client, req, payload.employee_id);
    await assertDomainInvariants(
      client,
      resource,
      req.tenantId,
      payload,
      req.params.id,
    );
    const row = await repository.replace(
      client,
      resource,
      req.tenantId,
      req.params.id,
      payload,
      req.expectedVersion,
    );
    await audit(client, req, "resource_replace", entityName, req.params.id);
    return validateOutput(entityName, row);
  });

export const deleteResource = (resource) => async (req) =>
  withTransaction(async (client) => {
    const entityName = repository.resources[resource][0];
    const current = await repository.findOne(
      client,
      resource,
      req.tenantId,
      req.params.id,
      { forUpdate: true },
    );
    if (employeeResources.has(resource))
      await assertEmployeeScope(client, req, current.employee_id);
    const versioned = Object.prototype.hasOwnProperty.call(
      schema.$defs[entityName].properties,
      "version",
    );
    if (versioned && req.expectedVersion === undefined)
      throw new HttpError(
        428,
        "Precondition Required",
        "If-Match is required for versioned resources.",
      );
    await audit(client, req, "resource_delete", entityName, req.params.id);
    await repository.remove(
      client,
      resource,
      req.tenantId,
      req.params.id,
      req.expectedVersion,
    );
  });

export const transition = async (
  client,
  resource,
  idField,
  tenantId,
  idValue,
  expected,
  nextStatus,
  actor,
) => {
  const current = await repository.findOne(
    client,
    resource,
    tenantId,
    idValue,
    { forUpdate: true },
  );
  const elevated = actor.capabilities.includes("users:write");
  const deciding = nextStatus === "approved" || nextStatus === "rejected";
  if (
    !elevated &&
    current.employee_id &&
    (deciding || current.employee_id !== actor.employeeId)
  ) {
    const approvalCapability = resource === "overtime-requests" ? "overtime:approve" : "leave:approve";
    const managed = actor.capabilities.includes(approvalCapability)
      ? await client.query(
          "SELECT 1 FROM employees WHERE tenant_id = $1 AND employee_id = $2 AND manager_id = $3",
          [tenantId, current.employee_id, actor.employeeId],
        )
      : { rowCount: 0 };
    if (!managed.rowCount)
      throw new HttpError(
        403,
        "Forbidden",
        deciding
          ? "Only a direct report request may be decided."
          : "The resource is outside your authorized scope.",
      );
  }
  if (current.status !== expected)
    throw new HttpError(
      409,
      "Invalid State",
      `Only ${expected} resources may transition to ${nextStatus}.`,
    );
  if (current.version !== undefined && actor.expectedVersion === undefined)
    throw new HttpError(
      428,
      "Precondition Required",
      "If-Match is required for versioned transitions.",
    );
  if (
    current.version !== undefined &&
    actor.expectedVersion !== undefined &&
    current.version !== actor.expectedVersion
  )
    throw new HttpError(
      409,
      "Stale Resource",
      "The resource changed; refresh before retrying.",
    );
  if (
    resource === "leave-requests" &&
    (nextStatus === "pending" || nextStatus === "approved")
  ) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `leave:${tenantId}:${current.employee_id}`,
    ]);
    if (nextStatus === "pending") {
      const policy = await client.query(
        `SELECT p.*, lt.unit AS leave_unit, j.standard_daily_mins
           FROM job_leave_policies p
          JOIN leave_types lt ON lt.tenant_id=p.tenant_id AND lt.leave_type_id=p.leave_type_id
          JOIN job_profiles j ON j.tenant_id=p.tenant_id AND j.job_id=p.job_id
          JOIN employees e ON e.tenant_id=p.tenant_id AND e.job_id=p.job_id
         WHERE p.tenant_id=$1 AND e.employee_id=$2 AND p.leave_type_id=$3 AND p.status='active'
           AND p.effective_from <= $4 AND (p.effective_to IS NULL OR p.effective_to >= $5)
         ORDER BY p.effective_from DESC LIMIT 1`,
        [
          tenantId,
          current.employee_id,
          current.leave_type_id,
          current.start_date,
          current.end_date,
        ],
      );
      if (!policy.rowCount)
        throw new HttpError(
          422,
          "Ineligible Leave",
          "No active leave policy covers this employee and period.",
        );
      if (current.partial_day !== "none" && !policy.rows[0].allow_partial_day)
        throw new HttpError(
          422,
          "Ineligible Leave",
          "This policy does not allow partial-day requests.",
        );
      const charge = await client.query(
        `SELECT count(*)::numeric AS days FROM generate_series($1::date,$2::date,'1 day') day
          WHERE extract(isodow FROM day) BETWEEN 1 AND 5
            AND NOT EXISTS (SELECT 1 FROM holidays h JOIN employees e ON e.tenant_id=h.tenant_id AND e.holiday_calendar_id=h.holiday_calendar_id
                             WHERE e.tenant_id=$3 AND e.employee_id=$4 AND h.status='active' AND h.local_date=day::date)`,
        [current.start_date, current.end_date, tenantId, current.employee_id],
      );
      if (Number(charge.rows[0].days) <= 0)
        throw new HttpError(
          422,
          "Invalid Leave Period",
          "The selected period has no chargeable working time.",
        );
      let amount = Number(charge.rows[0].days);
      if (current.partial_day === "custom_hours") {
        const partialMinutes = Number(current.partial_minutes || 0);
        amount = partialLeaveCharge(partialMinutes, policy.rows[0].leave_unit);
      } else if (["start_half", "end_half"].includes(current.partial_day)) {
        amount -= 0.5;
      }
      if (amount <= 0)
        throw new HttpError(
          422,
          "Invalid Leave Period",
          "The selected period has no chargeable working time.",
        );
      const documentationAfter = Number(
        policy.rows[0].documentation_rule?.required_after_days ?? Infinity,
      );
      if (amount > documentationAfter && !current.attachment_ids.length)
        throw new HttpError(
          422,
          "Documentation Required",
          "This request requires a validated attachment.",
        );
      current.chargeable_amount = amount;
      let requestBalance = await client.query(
        `SELECT *
           FROM leave_balances
          WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
          ORDER BY as_of DESC, balance_id DESC
          LIMIT 1
          FOR UPDATE`,
        [tenantId, current.employee_id, current.leave_type_id],
      );
      if (!requestBalance.rowCount) {
        requestBalance = await client.query(
          `INSERT INTO leave_balances (
             balance_id, tenant_id, employee_id, leave_type_id, period,
             accrued, carried_over, manual_adjustments, used, pending,
             remaining, unit, as_of
           )
           SELECT $1, $2, $3, $4,
                  to_char((CURRENT_TIMESTAMP AT TIME ZONE t.timezone)::date, 'YYYY'),
                  0, 0, 0, 0, 0, 0, $5,
                  (CURRENT_TIMESTAMP AT TIME ZONE t.timezone)::date
             FROM tenants t
            WHERE t.tenant_id = $2
           RETURNING *`,
          [id(), tenantId, current.employee_id, current.leave_type_id, policy.rows[0].leave_unit],
        );
      }
      const available = Number(requestBalance.rows[0].remaining) - Number(requestBalance.rows[0].pending);
      if (!policy.rows[0].allow_negative && available < amount)
        throw new HttpError(
          422,
          "Insufficient Leave Balance",
          "The request exceeds the balance available after pending requests.",
        );
    }
    const overlap = await client.query(
      `SELECT 1 FROM leave_requests WHERE tenant_id = $1 AND employee_id = $2 AND status IN ('pending','approved') AND request_id <> $3 AND start_date <= $5 AND end_date >= $4 LIMIT 1`,
      [
        tenantId,
        current.employee_id,
        current.request_id,
        current.start_date,
        current.end_date,
      ],
    );
    if (overlap.rowCount)
      throw new HttpError(
        409,
        "Overlapping Leave",
        "The requested period overlaps pending or approved leave.",
      );
    if (nextStatus === "approved") {
      const balance = await client.query(
        `SELECT b.remaining, b.pending, p.allow_negative
           FROM leave_balances b
           JOIN employees e
             ON e.tenant_id = b.tenant_id AND e.employee_id = b.employee_id
           JOIN job_leave_policies p
             ON p.tenant_id = e.tenant_id
            AND p.job_id = e.job_id
            AND p.leave_type_id = b.leave_type_id
            AND p.status = 'active'
            AND p.effective_from <= $4
            AND (p.effective_to IS NULL OR p.effective_to >= $5)
          WHERE b.tenant_id = $1 AND b.employee_id = $2 AND b.leave_type_id = $3
          ORDER BY b.as_of DESC, b.balance_id DESC, p.effective_from DESC
          LIMIT 1
          FOR UPDATE OF b`,
        [tenantId, current.employee_id, current.leave_type_id, current.start_date, current.end_date],
      );
      const otherPending = balance.rowCount
        ? Math.max(0, Number(balance.rows[0].pending) - Number(current.chargeable_amount))
        : 0;
      if (
        !balance.rowCount ||
        (!balance.rows[0].allow_negative &&
          Number(balance.rows[0].remaining) - otherPending < Number(current.chargeable_amount))
      )
        throw new HttpError(
          422,
          "Insufficient Leave Balance",
          "The approved request exceeds the available balance.",
        );
    }
  }
  if (resource === "overtime-requests" && nextStatus === "pending") {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `overtime:${tenantId}:${current.employee_id}:${current.local_date}`,
    ]);
    const overlap = await client.query(
      `SELECT 1 FROM overtime_requests
        WHERE tenant_id=$1 AND employee_id=$2 AND local_date=$3
          AND status IN ('pending','approved') AND overtime_request_id<>$4
          AND start_time < $5::time AND end_time > $6::time
        LIMIT 1`,
      [tenantId, current.employee_id, current.local_date, current.overtime_request_id, current.end_time, current.start_time],
    );
    if (overlap.rowCount)
      throw new HttpError(409, "Overlapping Overtime", "The requested overtime interval overlaps another pending or approved request.");
  }
  const updated = { ...current, status: nextStatus };
  if (nextStatus === "pending") updated.submitted_at = now();
  if (resource === "overtime-requests" && nextStatus === "pending") {
    const manager = await client.query(
      "SELECT manager_id FROM employees WHERE tenant_id=$1 AND employee_id=$2",
      [tenantId, current.employee_id],
    );
    updated.approver_id = manager.rows[0]?.manager_id || null;
  }
  if (deciding) {
    if ("approver_id" in updated) updated.approver_id = actor.employeeId;
    if ("decided_by" in updated) updated.decided_by = actor.userId;
    updated.decided_at = now();
  }
  if (current.version !== undefined) updated.version += 1;
  const row = await repository.replace(
    client,
    resource,
    tenantId,
    idValue,
    updated,
    current.version,
  );
  if (resource === "overtime-requests" && nextStatus === "approved") {
    await client.query(
      `INSERT INTO overtime_ledger_entries
        (entry_id,tenant_id,overtime_request_id,employee_id,local_date,minutes,entry_type,reason,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'approved',$7,$8)`,
      [id(), tenantId, current.overtime_request_id, current.employee_id, current.local_date, current.requested_mins, current.reason, actor.userId],
    );
  }
  if (resource === "attendance-adjustments" && nextStatus === "approved") {
    const clockIn = current.proposed?.clock_in || current.proposed?.start;
    const clockOut = current.proposed?.clock_out || current.proposed?.end;
    if (
      !/^\d{2}:\d{2}$/.test(clockIn || "") ||
      !/^\d{2}:\d{2}$/.test(clockOut || "") ||
      clockOut <= clockIn
    )
      throw new HttpError(
        422,
        "Invalid Adjustment",
        "Approved clock times must form a valid positive work interval.",
      );
    const times = await client.query(
      `SELECT (($1::date + $2::time) AT TIME ZONE timezone) AS clock_in_at,
              (($1::date + $3::time) AT TIME ZONE timezone) AS clock_out_at
         FROM tenants WHERE tenant_id = $4`,
      [current.local_date, clockIn, clockOut, tenantId],
    );
    const clockInAt = times.rows[0].clock_in_at;
    const clockOutAt = times.rows[0].clock_out_at;
    const workedMinutes = Math.round(
      (new Date(clockOutAt) - new Date(clockInAt)) / 60000,
    );
    await client.query(
      "INSERT INTO attendance_sessions (session_id,tenant_id,employee_id,clock_in_at,clock_out_at,source,status,version) VALUES ($1,$2,$3,$4,$5,'attendance_adjustment','closed',0)",
      [id(), tenantId, current.employee_id, clockInAt, clockOutAt],
    );
    const summary = await client.query(
      "UPDATE attendance_summaries SET worked_mins = $1, overtime_mins = GREATEST(0, $1 - scheduled_mins), status = 'complete', exception_codes = ARRAY[]::text[] WHERE tenant_id = $2 AND employee_id = $3 AND local_date = $4 RETURNING summary_id",
      [workedMinutes, tenantId, current.employee_id, current.local_date],
    );
    if (!summary.rowCount)
      await client.query(
        `INSERT INTO attendance_summaries (summary_id,tenant_id,employee_id,local_date,worked_mins,scheduled_mins,overtime_mins,status,exception_codes,effective_job_id)
         SELECT $1,e.tenant_id,e.employee_id,$2,$3,j.standard_daily_mins,GREATEST(0,$3-j.standard_daily_mins),'complete',ARRAY[]::text[],e.job_id
           FROM employees e JOIN job_profiles j ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id
          WHERE e.tenant_id=$4 AND e.employee_id=$5`,
        [
          id(),
          current.local_date,
          workedMinutes,
          tenantId,
          current.employee_id,
        ],
      );
  }
  if (resource === "leave-requests") {
    const balance = await client.query(
      "SELECT * FROM leave_balances WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 ORDER BY as_of DESC LIMIT 1 FOR UPDATE",
      [tenantId, current.employee_id, current.leave_type_id],
    );
    if (balance.rowCount) {
      const value = Number(current.chargeable_amount);
      const existing = balance.rows[0];
      if (nextStatus === "pending")
        existing.pending = Number(existing.pending) + value;
      if (nextStatus === "withdrawn" || nextStatus === "rejected")
        existing.pending = Math.max(0, Number(existing.pending) - value);
      if (nextStatus === "approved") {
        existing.pending = Math.max(0, Number(existing.pending) - value);
        existing.used = Number(existing.used) + value;
        existing.remaining = Number(existing.remaining) - value;
        await client.query(
          "INSERT INTO leave_ledger_entries (entry_id,tenant_id,employee_id,leave_type_id,effective_date,amount,entry_type,source_id,reason,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            id(),
            tenantId,
            current.employee_id,
            current.leave_type_id,
            current.start_date,
            -value,
            "usage",
            current.request_id,
            current.reason,
            actor.userId,
            now(),
          ],
        );
      }
      if (nextStatus === "cancelled") {
        existing.used = Math.max(0, Number(existing.used) - value);
        existing.remaining = Number(existing.remaining) + value;
        await client.query(
          "INSERT INTO leave_ledger_entries (entry_id,tenant_id,employee_id,leave_type_id,effective_date,amount,entry_type,source_id,reason,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            id(),
            tenantId,
            current.employee_id,
            current.leave_type_id,
            current.start_date,
            value,
            "reversal",
            current.request_id,
            "Approved leave cancelled",
            actor.userId,
            now(),
          ],
        );
      }
      await client.query(
        "UPDATE leave_balances SET pending = $1, used = $2, remaining = $3, as_of = CURRENT_DATE WHERE tenant_id = $4 AND balance_id = $5",
        [
          existing.pending,
          existing.used,
          existing.remaining,
          tenantId,
          existing.balance_id,
        ],
      );
    }
  }
  return validateOutput(repository.resources[resource][0], row);
};

export const audit = async (
  client,
  req,
  action,
  targetType,
  targetId,
  reason = null,
) => {
  await client.query(
    `INSERT INTO audit_events (event_id, tenant_id, actor_user_id, actor_role, action, target_type, target_id, occurred_at, reason, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id(),
      req.tenantId,
      req.actor.user_id,
      req.actor.actor_role || "unknown",
      action,
      targetType,
      targetId,
      now(),
      reason,
      {},
    ],
  );
};

export const clockIn = async (req) =>
  withTransaction(async (client) => {
    const session = {
      session_id: id(),
      tenant_id: req.tenantId,
      employee_id: req.actor.employee_id,
      clock_in_at: now(),
      clock_out_at: null,
      source: "responsive_web",
      status: "open",
      version: 0,
    };
    try {
      const row = await repository.insert(
        client,
        "attendance-sessions",
        req.tenantId,
        session,
      );
      await audit(client, req, "clock_in", "AttendanceSession", row.session_id);
      return validateOutput("AttendanceSession", row);
    } catch (error) {
      if (error.code === "23505")
        throw new HttpError(
          409,
          "Already Clocked In",
          "The employee already has an open attendance session.",
        );
      throw error;
    }
  });

const reconcileDailySummary = async (client, req, session, clockedOutAt) => {
  const context = await client.query(
    `SELECT e.job_id, j.standard_daily_mins,
            (($3::timestamptz AT TIME ZONE t.timezone)::date) AS local_date
       FROM employees e
       JOIN job_profiles j ON j.tenant_id = e.tenant_id AND j.job_id = e.job_id
       JOIN tenants t ON t.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1 AND e.employee_id = $2`,
    [req.tenantId, req.actor.employee_id, session.clock_in_at],
  );
  if (!context.rowCount) return;

  const { job_id: jobId, standard_daily_mins: scheduledMins, local_date: localDate } =
    context.rows[0];
  const durationMins = Math.max(
    0,
    Math.floor(
      (new Date(clockedOutAt).getTime() -
        new Date(session.clock_in_at).getTime()) /
        60000,
    ),
  );
  const existing = await client.query(
    `SELECT summary_id, worked_mins, scheduled_mins
       FROM attendance_summaries
      WHERE tenant_id = $1 AND employee_id = $2 AND local_date = $3
      ORDER BY summary_id
      LIMIT 1
      FOR UPDATE`,
    [req.tenantId, req.actor.employee_id, localDate],
  );
  const workedMins = (existing.rows[0]?.worked_mins || 0) + durationMins;
  const dailySchedule = existing.rows[0]?.scheduled_mins ?? scheduledMins;
  const overtimeMins = Math.max(0, workedMins - dailySchedule);
  const status = workedMins >= dailySchedule ? "complete" : "below_standard";
  const exceptionCodes = workedMins >= dailySchedule ? [] : ["SHORT_DAY"];

  if (existing.rowCount) {
    await client.query(
      `UPDATE attendance_summaries
          SET worked_mins = $1,
              scheduled_mins = $2,
              overtime_mins = $3,
              status = $4,
              exception_codes = $5,
              effective_job_id = $6
        WHERE tenant_id = $7 AND summary_id = $8`,
      [
        workedMins,
        dailySchedule,
        overtimeMins,
        status,
        exceptionCodes,
        jobId,
        req.tenantId,
        existing.rows[0].summary_id,
      ],
    );
  } else {
    await client.query(
      `INSERT INTO attendance_summaries
        (summary_id, tenant_id, employee_id, local_date, worked_mins,
         scheduled_mins, overtime_mins, status, exception_codes, effective_job_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id(),
        req.tenantId,
        req.actor.employee_id,
        localDate,
        workedMins,
        dailySchedule,
        overtimeMins,
        status,
        exceptionCodes,
        jobId,
      ],
    );
  }
};

export const clockOut = async (req) =>
  withTransaction(async (client) => {
    const result = await client.query(
      "SELECT * FROM attendance_sessions WHERE tenant_id = $1 AND employee_id = $2 AND status = $3 FOR UPDATE",
      [req.tenantId, req.actor.employee_id, "open"],
    );
    if (!result.rowCount)
      throw new HttpError(
        409,
        "Not Clocked In",
        "No open attendance session exists.",
      );
    const current = result.rows[0];
    const clockedOutAt = now();
    const row = await repository.replace(
      client,
      "attendance-sessions",
      req.tenantId,
      current.session_id,
      {
        ...current,
        clock_out_at: clockedOutAt,
        status: "closed",
        version: current.version + 1,
      },
      current.version,
    );
    await reconcileDailySummary(client, req, current, clockedOutAt);
    await audit(client, req, "clock_out", "AttendanceSession", row.session_id);
    return validateOutput("AttendanceSession", row);
  });
