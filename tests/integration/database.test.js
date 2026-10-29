import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import * as XLSX from "xlsx";

const binaryParser = (response, callback) => {
  const chunks = [];
  response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  response.on("end", () => callback(null, Buffer.concat(chunks)));
};

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "PostgreSQL API enforces tenancy, workflows, concurrency, balances, and audits",
  { skip: !databaseUrl },
  async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.JWT_SECRET ||= "integration-jwt-secret-that-is-long-enough";
    process.env.CSRF_SECRET ||= "integration-csrf-secret-that-is-long-enough";
    const [{ createApp }, { pool }] = await Promise.all([
      import("../../src/server/app.js"),
      import("../../src/server/config/database.js"),
    ]);
    const app = createApp();
    const user = request.agent(app);
    const userLogin = await user.post("/api/v1/auth/login").send({
      email: "user@dev.local",
      password: process.env.SEED_USER_PASSWORD,
    });
    assert.equal(userLogin.status, 200);
    const userCsrf = userLogin.body.csrf_token;

    const employees = await user.get("/api/v1/employees?limit=1");
    assert.equal(employees.status, 200);
    assert.equal(employees.body.length, 1);
    assert.equal(employees.body[0].employee_id, "ns-morgan");
  assert.equal(employees.headers["x-total-count"], "1");
  assert.equal((await user.get("/api/v1/audit-events")).status, 403);
    assert.equal(
      (await user.get("/api/v1/employees").set("x-tenant-id", "harbor")).status,
      403,
    );
    const crossMidnightSessionId = `session-cross-midnight-${Date.now()}`;
    const crossMidnightDates = await pool.query(
      `SELECT (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date AS clock_out_date,
              ((CURRENT_TIMESTAMP AT TIME ZONE timezone)::date - 1) AS clock_in_date,
              ((((CURRENT_TIMESTAMP AT TIME ZONE timezone)::date - 1) + time '23:59') AT TIME ZONE timezone) AS clock_in_at
         FROM tenants WHERE tenant_id=$1`,
      ["northstar"],
    );
    await pool.query(
      `INSERT INTO attendance_sessions
        (session_id,tenant_id,employee_id,clock_in_at,clock_out_at,source,status,version)
       VALUES ($1,$2,$3,$4,NULL,'responsive_web','open',0)`,
      [crossMidnightSessionId, "northstar", "ns-morgan", crossMidnightDates.rows[0].clock_in_at],
    );
    const crossMidnightClockOut = await user
      .post("/api/v1/attendance-sessions/clock-out")
      .set("x-csrf-token", userCsrf)
      .send({});
    assert.equal(crossMidnightClockOut.status, 200);
    const crossMidnightSummary = await pool.query(
      "SELECT local_date FROM attendance_summaries WHERE tenant_id=$1 AND employee_id=$2 AND local_date IN ($3,$4) ORDER BY local_date",
      [
        "northstar",
        "ns-morgan",
        crossMidnightDates.rows[0].clock_in_date,
        crossMidnightDates.rows[0].clock_out_date,
      ],
    );
    assert.ok(
      crossMidnightSummary.rows.some(
        (row) => row.local_date === crossMidnightDates.rows[0].clock_in_date,
      ),
      "cross-midnight attendance must be summarized on the clock-in date",
    );
    assert.equal(
      crossMidnightSummary.rows.some(
        (row) => row.local_date === crossMidnightDates.rows[0].clock_out_date,
      ),
      false,
      "cross-midnight attendance must not create a clock-out-date summary",
    );
    const leaveOptions = await user.get("/api/v1/hr/my-leave-options");
    assert.equal(leaveOptions.status, 200);
    assert.deepEqual(
      leaveOptions.body.map((option) => option.leave_type_id).sort(),
      ["ns-annual", "ns-sick"],
    );
    const annualOption = leaveOptions.body.find((option) => option.leave_type_id === "ns-annual");
    assert.equal(Number(annualOption.remaining), 13);
    assert.equal(Number(annualOption.pending), 2);
    assert.equal(Number(annualOption.available), 11);
    await pool.query(
      "UPDATE leave_balances SET remaining=11 WHERE tenant_id=$1 AND employee_id=$2 AND leave_type_id=$3",
      ["northstar", "ns-morgan", "ns-annual"],
    );
    const balanceBeforeCancellation = await pool.query(
      "SELECT remaining FROM leave_balances WHERE tenant_id=$1 AND employee_id=$2 AND leave_type_id=$3 ORDER BY as_of DESC LIMIT 1",
      ["northstar", "ns-morgan", "ns-annual"],
    );

    const created = await user
      .post("/api/v1/leave-requests")
      .set("x-csrf-token", userCsrf)
      .send({
        employee_id: "ns-morgan",
        leave_type_id: "ns-annual",
        start_date: "2027-12-13",
        end_date: "2027-12-17",
        partial_day: "none",
        chargeable_amount: 5,
        reason: "Integration verification leave",
        attachment_ids: [],
        status: "draft",
        approver_id: null,
        submitted_at: null,
        decided_at: null,
        decision_note: null,
        version: 0,
      });
    assert.equal(created.status, 201);
    const submitWithoutVersion = await user
      .post(`/api/v1/leave-requests/${created.body.request_id}/submit`)
      .set("x-csrf-token", userCsrf)
      .send({});
    assert.equal(submitWithoutVersion.status, 428);
    const submitted = await user
      .post(`/api/v1/leave-requests/${created.body.request_id}/submit`)
      .set("x-csrf-token", userCsrf)
      .set("if-match", "0")
      .send({});
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.status, "pending");

    const manager = request.agent(app);
    const managerLogin = await manager.post("/api/v1/auth/login").send({
      email: "manager@dev.local",
      password: process.env.SEED_USER_PASSWORD,
    });
    assert.equal(managerLogin.status, 200);
    const approved = await manager
      .post(`/api/v1/leave-requests/${created.body.request_id}/approve`)
      .set("x-csrf-token", managerLogin.body.csrf_token)
      .set("if-match", "1")
      .send({});
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "approved");
    const ledger = await pool.query(
      "SELECT amount, entry_type FROM leave_ledger_entries WHERE tenant_id = $1 AND source_id = $2",
      ["northstar", created.body.request_id],
    );
    assert.equal(ledger.rowCount, 1);
    assert.equal(ledger.rows[0].entry_type, "usage");
    assert.equal(Number(ledger.rows[0].amount), -5);
    const cancelled = await user
      .post(`/api/v1/leave-requests/${created.body.request_id}/cancel`)
      .set("x-csrf-token", userCsrf)
      .set("if-match", "2")
      .send({});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
    const cancellationLedger = await pool.query(
      "SELECT amount, entry_type FROM leave_ledger_entries WHERE tenant_id = $1 AND source_id = $2 ORDER BY CASE entry_type WHEN 'usage' THEN 1 WHEN 'reversal' THEN 2 ELSE 3 END",
      ["northstar", created.body.request_id],
    );
    assert.deepEqual(
      cancellationLedger.rows.map((row) => ({
        amount: Number(row.amount),
        entry_type: row.entry_type,
      })),
      [
        { amount: -5, entry_type: "usage" },
        { amount: 5, entry_type: "reversal" },
      ],
    );
    const balanceAfterCancellation = await pool.query(
      "SELECT remaining FROM leave_balances WHERE tenant_id=$1 AND employee_id=$2 AND leave_type_id=$3 ORDER BY as_of DESC LIMIT 1",
      ["northstar", "ns-morgan", "ns-annual"],
    );
    assert.equal(
      Number(balanceAfterCancellation.rows[0].remaining),
      Number(balanceBeforeCancellation.rows[0].remaining),
    );
  const adjustment = await user.post("/api/v1/attendance-adjustments").set("x-csrf-token", userCsrf).send({
    employee_id: "ns-morgan", local_date: "2027-12-01", original: { clock_in: "09:00", clock_out: null }, proposed: { clock_in: "09:00", clock_out: "17:00" },
    reason: "Integration punch correction", attachment_ids: [], status: "draft", submitted_at: new Date().toISOString(), decided_by: null, decided_at: null, decision_note: null, version: 0,
  });
  assert.equal(adjustment.status, 201);
  const adjustmentSubmitted = await user.post(`/api/v1/attendance-adjustments/${adjustment.body.adjustment_id}/submit`).set("x-csrf-token", userCsrf).set("if-match", "0").send({});
  assert.equal(adjustmentSubmitted.status, 200);
  const adjustmentApproved = await manager.post(`/api/v1/attendance-adjustments/${adjustment.body.adjustment_id}/approve`).set("x-csrf-token", managerLogin.body.csrf_token).set("if-match", "1").send({});
  assert.equal(adjustmentApproved.status, 200);
  const correctedSession = await pool.query("SELECT source FROM attendance_sessions WHERE tenant_id=$1 AND employee_id=$2 AND clock_in_at::date=$3", ["northstar", "ns-morgan", "2027-12-01"]);
  assert.equal(correctedSession.rows[0].source, "attendance_adjustment");
  const correctedSummary = await pool.query("SELECT worked_mins,status FROM attendance_summaries WHERE tenant_id=$1 AND employee_id=$2 AND local_date=$3", ["northstar", "ns-morgan", "2027-12-01"]);
  assert.deepEqual(correctedSummary.rows[0], { worked_mins: 480, status: "complete" });

  const partialLeave = await user.post("/api/v1/leave-requests").set("x-csrf-token", userCsrf).send({
    employee_id: "ns-morgan", leave_type_id: "ns-annual", start_date: "2027-12-08", end_date: "2027-12-08",
    partial_day: "custom_hours", partial_start_time: "07:00", partial_end_time: "10:00", partial_minutes: 180,
    chargeable_amount: 0, reason: "Integration custom-hour leave", attachment_ids: [], status: "draft",
    approver_id: null, submitted_at: null, decided_at: null, decision_note: null, version: 0,
  });
  assert.equal(partialLeave.status, 201);
  const partialSubmitted = await user.post(`/api/v1/leave-requests/${partialLeave.body.request_id}/submit`).set("x-csrf-token", userCsrf).set("if-match", "0").send({});
  assert.equal(partialSubmitted.status, 200);
  assert.equal(partialSubmitted.body.partial_minutes, 180);
  assert.equal(Number(partialSubmitted.body.chargeable_amount), 0.33);
  const partialApproved = await manager.post(`/api/v1/leave-requests/${partialLeave.body.request_id}/approve`).set("x-csrf-token", managerLogin.body.csrf_token).set("if-match", "1").send({});
  assert.equal(partialApproved.status, 200);

  const overtime = await user.post("/api/v1/overtime-requests").set("x-csrf-token", userCsrf).send({
    employee_id: "ns-morgan", local_date: "2027-12-02", start_time: "07:00", end_time: "10:00", requested_mins: 180,
    reason: "Integration overtime request from a non-eligible job type", status: "draft", approver_id: null,
    submitted_at: null, decided_at: null, decision_note: null, version: 0, created_at: new Date().toISOString(),
  });
  assert.equal(overtime.status, 201);
  const overtimeSubmitted = await user.post(`/api/v1/overtime-requests/${overtime.body.overtime_request_id}/submit`).set("x-csrf-token", userCsrf).set("if-match", "0").send({});
  assert.equal(overtimeSubmitted.status, 200);
  assert.equal(overtimeSubmitted.body.approver_id, "ns-alex");
  const overtimeApproved = await manager.post(`/api/v1/overtime-requests/${overtime.body.overtime_request_id}/approve`).set("x-csrf-token", managerLogin.body.csrf_token).set("if-match", "1").send({});
  assert.equal(overtimeApproved.status, 200);
  const overtimeLedger = await pool.query("SELECT minutes,entry_type FROM overtime_ledger_entries WHERE tenant_id=$1 AND overtime_request_id=$2", ["northstar", overtime.body.overtime_request_id]);
  assert.deepEqual(overtimeLedger.rows, [{ minutes: 180, entry_type: "approved" }]);
  const overlapRequest = await user.post("/api/v1/overtime-requests").set("x-csrf-token", userCsrf).send({
    employee_id: "ns-morgan", local_date: "2027-12-02", start_time: "09:00", end_time: "11:00", requested_mins: 120,
    reason: "Overlapping request should be rejected", status: "draft", approver_id: null,
    submitted_at: null, decided_at: null, decision_note: null, version: 0, created_at: new Date().toISOString(),
  });
  const overlapSubmitted = await user.post(`/api/v1/overtime-requests/${overlapRequest.body.overtime_request_id}/submit`).set("x-csrf-token", userCsrf).set("if-match", "0").send({});
  assert.equal(overlapSubmitted.status, 409);

  const hr = request.agent(app);
  const hrLogin = await hr.post("/api/v1/auth/login").send({ email: "hr@dev.local", password: process.env.SEED_HR_PASSWORD || process.env.SEED_ADMIN_PASSWORD });
  assert.equal(hrLogin.status, 200);
  const leaveOverrideBalanceBefore = await pool.query(
    "SELECT remaining,used FROM leave_balances WHERE tenant_id=$1 AND employee_id=$2 AND leave_type_id=$3 ORDER BY as_of DESC LIMIT 1",
    ["northstar", "ns-morgan", "ns-annual"],
  );
  const leaveOverride = await hr.post("/api/v1/hr/leave-overrides").set("x-csrf-token", hrLogin.body.csrf_token).send({
    employee_id: "ns-morgan", leave_type_id: "ns-annual", start_date: "2027-12-09", end_date: "2027-12-09",
    duration: "custom_hours", start_time: "09:00", end_time: "10:00", reason: "Integration missed hourly leave override",
  });
  assert.equal(leaveOverride.status, 201);
  assert.equal(leaveOverride.body.request.status, "approved");
  assert.equal(Number(leaveOverride.body.request.chargeable_amount), 0.11);
  assert.equal(Number(leaveOverride.body.ledger_entry.amount), -0.11);
  assert.equal(
    Number(leaveOverride.body.balance.remaining),
    Number(leaveOverrideBalanceBefore.rows[0].remaining) - 0.11,
  );
  assert.equal(
    Number(leaveOverride.body.balance.used),
    Number(leaveOverrideBalanceBefore.rows[0].used) + 0.11,
  );
  const leaveOverrideAudit = await pool.query(
    "SELECT action,metadata FROM audit_events WHERE tenant_id=$1 AND target_id=$2",
    ["northstar", leaveOverride.body.request.request_id],
  );
  assert.equal(leaveOverrideAudit.rows.at(-1).action, "leave_manual_override");
  assert.equal(Number(leaveOverrideAudit.rows.at(-1).metadata.chargeable_amount), 0.11);
  const overrideOpen = await hr.post("/api/v1/hr/attendance-overrides").set("x-csrf-token", hrLogin.body.csrf_token).send({
    employee_id: "ns-morgan", local_date: "2027-12-04", clock_in_time: "07:00", reason: "Integration manual clock-in override",
  });
  assert.equal(overrideOpen.status, 201);
  assert.equal(overrideOpen.body.session.status, "open");
  const overrideClosed = await hr.post("/api/v1/hr/attendance-overrides").set("x-csrf-token", hrLogin.body.csrf_token).send({
    employee_id: "ns-morgan", local_date: "2027-12-04", clock_in_time: "07:30", clock_out_time: "16:30", reason: "Integration replacement attendance interval",
  });
  assert.equal(overrideClosed.status, 201);
  assert.equal(overrideClosed.body.replaced_session_ids.length, 1);
  assert.equal(overrideClosed.body.summary.local_date, "2027-12-04");
  assert.equal(overrideClosed.body.summary.worked_mins, 540);
  const overrideSummaryList = await hr.get("/api/v1/attendance-summaries?limit=1");
  assert.equal(overrideSummaryList.status, 200);
  assert.equal(overrideSummaryList.body[0].local_date, "2027-12-04");
  const overrideRows = await pool.query("SELECT status,source FROM attendance_sessions WHERE tenant_id=$1 AND employee_id=$2 AND (clock_in_at AT TIME ZONE 'Asia/Manila')::date=$3 ORDER BY clock_in_at", ["northstar", "ns-morgan", "2027-12-04"]);
  assert.deepEqual(overrideRows.rows, [{ status: "voided", source: "hr_bulk_override" }, { status: "closed", source: "hr_bulk_override" }]);
  const overrideAudit = await pool.query("SELECT action,metadata FROM audit_events WHERE tenant_id=$1 AND target_id=$2", ["northstar", overrideClosed.body.session.session_id]);
  assert.equal(overrideAudit.rows.at(-1).action, "attendance_manual_override");
  assert.equal(overrideAudit.rows.at(-1).metadata.replaced_session_ids.length, 1);
  const userOverrideForbidden = await user.post("/api/v1/hr/attendance-overrides").set("x-csrf-token", userCsrf).send({ employee_id: "ns-morgan", local_date: "2027-12-05", clock_in_time: "08:00", reason: "Should be forbidden" });
  assert.equal(userOverrideForbidden.status, 403);
  const userLeaveOverrideForbidden = await user.post("/api/v1/hr/leave-overrides").set("x-csrf-token", userCsrf).send({ employee_id: "ns-morgan" });
  assert.equal(userLeaveOverrideForbidden.status, 403);

    const audit = await pool.query(
      "SELECT action FROM audit_events WHERE tenant_id = $1 AND target_id = $2 ORDER BY occurred_at",
      ["northstar", created.body.request_id],
    );
    assert.deepEqual(
      audit.rows.map(({ action }) => action),
      ["resource_create", "leave_submit", "leave_approve", "leave_cancel"],
    );

    const readonly = request.agent(app);
    const readonlyLogin = await readonly.post("/api/v1/auth/login").send({
      email: "readonly@dev.local",
      password: process.env.SEED_READONLY_PASSWORD,
    });
    assert.equal(readonlyLogin.status, 200);
    const forbidden = await readonly
      .post("/api/v1/attendance-sessions/clock-in")
      .set("x-csrf-token", readonlyLogin.body.csrf_token)
      .send({});
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.type, "application/problem+json");
    assert.ok(forbidden.body.request_id);

    const admin = request.agent(app);
    const adminLogin = await admin.post("/api/v1/auth/login").send({
      email: "admin@dev.local",
      password: process.env.SEED_ADMIN_PASSWORD,
    });
    const context = await admin
      .post("/api/v1/auth/context")
      .set("x-csrf-token", adminLogin.body.csrf_token)
      .send({ tenant_id: "northstar" });
    assert.equal(context.status, 200);
    const alex = await admin.get("/api/v1/employees/ns-alex");
    const invalidHierarchy = await admin
      .put("/api/v1/employees/ns-alex")
      .set("x-csrf-token", context.body.csrf_token)
      .send({ ...alex.body, manager_id: "ns-alex" });
    assert.equal(invalidHierarchy.status, 422);
    const payroll = await admin.get("/api/v1/reports/payroll-timesheet?from=2026-09-01&to=2026-09-30&page_size=2");
    assert.equal(payroll.status, 200);
    assert.equal(payroll.body.preset, "payroll-timesheet");
    assert.ok(payroll.body.items.length <= 2);
    const payrollCsv = await admin.get("/api/v1/reports/payroll-timesheet.csv?from=2026-09-01&to=2026-09-30");
    assert.equal(payrollCsv.status, 200);
    assert.match(payrollCsv.headers["content-type"], /text\/csv/);
    assert.match(payrollCsv.text, /paid_leave_units/);
    const payrollXls = await admin.get("/api/v1/reports/payroll-timesheet.xls?month=2026-09").buffer(true).parse(binaryParser);
    assert.equal(payrollXls.status, 200);
    assert.match(payrollXls.headers["content-type"], /application\/vnd\.ms-excel/);
    assert.match(payrollXls.headers["content-disposition"], /Monthly_Time_Logs\.xls/);
    assert.deepEqual(Array.from(payrollXls.body.subarray(0, 4)), [0xd0, 0xcf, 0x11, 0xe0]);
    const payrollWorkbook = XLSX.read(payrollXls.body, { type: "buffer" });
    assert.deepEqual(payrollWorkbook.SheetNames, ["Monthly Time Logs_Hours_1", "Monthly Time Logs_Decimal_2"]);
    assert.equal(payrollWorkbook.Sheets["Monthly Time Logs_Hours_1"].G1.v, "01-Sep-2026");
    const invalidPayrollXls = await admin.get("/api/v1/reports/payroll-timesheet.xls?month=2026-13");
    assert.equal(invalidPayrollXls.status, 422);
    const auditCsv = await admin.get("/api/v1/audit-events/export.csv?q=seed");
    assert.equal(auditCsv.status, 200);
    assert.match(auditCsv.text, /event_id/);
    assert.match(auditCsv.text, /target_name/);
    const directory = await admin
      .post("/api/v1/hr/directory")
      .set("x-csrf-token", context.body.csrf_token)
      .send({
        name: "Integration Directory User",
        job_id: "ns-coordinator",
        manager_id: "ns-alex",
        department_id: "ns-ops",
        location_id: "ns-manila",
        holiday_calendar_id: "ns-ph",
        work_schedule: { schedule_id: "ns-standard" },
        start_date: "2026-09-18",
        status: "active",
        account: { enabled: true, email: `directory-${Date.now()}@dev.local`, password: "Temporary-Password-2026!", roles: ["Employee"] },
      });
    assert.equal(directory.status, 201);
    assert.match(directory.body.employee.employee_number, /^NORTHSTAR-[A-F0-9]{8}$/);
    assert.equal(Object.prototype.hasOwnProperty.call(directory.body, "password"), false);

    const unprovisionedEmail = `existing-directory-${Date.now()}@dev.local`;
    const unprovisioned = await admin
      .post("/api/v1/hr/directory")
      .set("x-csrf-token", context.body.csrf_token)
      .send({
        employee_number: `NS-UNPROVISIONED-${Date.now()}`,
        name: "Existing Directory User",
        job_id: "ns-coordinator",
        manager_id: "ns-alex",
        department_id: "ns-ops",
        location_id: "ns-manila",
        holiday_calendar_id: "ns-ph",
        work_schedule: { schedule_id: "ns-standard" },
        start_date: "2026-09-18",
        status: "active",
      });
    assert.equal(unprovisioned.status, 201);
    assert.equal(unprovisioned.body.account, null);
    const provisionedExisting = await admin
      .put(`/api/v1/hr/directory/${unprovisioned.body.employee.employee_id}`)
      .set("x-csrf-token", context.body.csrf_token)
      .send({
        ...unprovisioned.body.employee,
        account: { enabled: true, email: unprovisionedEmail, password: "Existing-Password-2026!", roles: ["Reporting Manager"] },
      });
    assert.equal(provisionedExisting.status, 200);
    assert.equal(provisionedExisting.body.account.email, unprovisionedEmail);
    assert.deepEqual(provisionedExisting.body.account.roles, ["Reporting Manager"]);
    assert.equal(Object.prototype.hasOwnProperty.call(provisionedExisting.body.account, "password"), false);
    const provisionedLogin = request.agent(app);
    const existingLogin = await provisionedLogin.post("/api/v1/auth/login").send({ email: unprovisionedEmail, password: "Existing-Password-2026!" });
    assert.equal(existingLogin.status, 200);
    assert.ok(existingLogin.body.roles.includes("Reporting Manager"));
    assert.ok(existingLogin.body.capabilities.includes("attendance:write"));
    const employeeRoleUpdateForbidden = await user
      .put(`/api/v1/hr/directory/${provisionedExisting.body.employee.employee_id}`)
      .set("x-csrf-token", userCsrf)
      .send({ account: { roles: ["HR Manager"] } });
    assert.equal(employeeRoleUpdateForbidden.status, 403);
    const promotedExisting = await admin
      .put(`/api/v1/hr/directory/${provisionedExisting.body.employee.employee_id}`)
      .set("x-csrf-token", context.body.csrf_token)
      .send({
        ...provisionedExisting.body.employee,
        account: { roles: ["HR Manager"] },
      });
    assert.equal(promotedExisting.status, 200);
    assert.deepEqual(promotedExisting.body.account.roles, ["HR Manager"]);
    assert.equal(promotedExisting.body.account.changed, true);
    const promotedCapabilities = await pool.query(
      "SELECT capabilities FROM users WHERE tenant_id=$1 AND employee_id=$2",
      ["northstar", provisionedExisting.body.employee.employee_id],
    );
    assert.ok(promotedCapabilities.rows[0].capabilities.includes("users:write"));
    assert.ok(promotedCapabilities.rows[0].capabilities.includes("attendance:write"));
    const roleAudit = await pool.query(
      "SELECT metadata FROM audit_events WHERE tenant_id=$1 AND action='account_role_update' AND target_id=$2 ORDER BY occurred_at DESC LIMIT 1",
      ["northstar", promotedExisting.body.account.user_id],
    );
    assert.deepEqual(roleAudit.rows[0].metadata.previous_roles, ["Reporting Manager"]);
    assert.deepEqual(roleAudit.rows[0].metadata.roles, ["HR Manager"]);
    const genericRoleBypass = await admin
      .put(`/api/v1/users/${promotedExisting.body.account.user_id}`)
      .set("x-csrf-token", context.body.csrf_token)
      .send({ capabilities: [] });
    assert.equal(genericRoleBypass.status, 404);
    const invalidExistingRole = await admin
      .put(`/api/v1/hr/directory/${provisionedExisting.body.employee.employee_id}`)
      .set("x-csrf-token", context.body.csrf_token)
      .send({
        ...provisionedExisting.body.employee,
        account: { roles: ["Platform Administrator"] },
      });
    assert.equal(invalidExistingRole.status, 422);

    const invitedEmail = `employee-invite-${Date.now()}@dev.local`;
    const invitedDirectory = await admin
      .post("/api/v1/hr/directory")
      .set("x-csrf-token", context.body.csrf_token)
      .send({
        name: "Invited Directory User",
        job_id: "ns-coordinator",
        manager_id: "ns-alex",
        department_id: "ns-ops",
        location_id: "ns-manila",
        holiday_calendar_id: "ns-ph",
        work_schedule: { schedule_id: "ns-standard" },
        start_date: "2026-09-18",
        status: "active",
        account: { enabled: true, invite: true, email: invitedEmail, roles: ["Employee"] },
      });
    assert.equal(invitedDirectory.status, 201);
    assert.equal(invitedDirectory.body.account.status, "inactive");
    assert.match(invitedDirectory.body.account.invite_url, /#\/accept-invitation\?token=/);
    assert.equal(Object.prototype.hasOwnProperty.call(invitedDirectory.body.account, "password"), false);
    const invitedEmployeeAgent = request.agent(app);
    const invitedEmployeeAccepted = await invitedEmployeeAgent
      .post("/api/v1/auth/invitations/accept")
      .send({ token: new URL(invitedDirectory.body.account.invite_url).hash.split("token=")[1], password: "Employee-Invite-password-2026!" });
    assert.equal(invitedEmployeeAccepted.status, 200);
    assert.ok(invitedEmployeeAccepted.body.roles.includes("Employee"));
    const passwordWithoutCsrf = await invitedEmployeeAgent
      .post("/api/v1/auth/password")
      .send({ current_password: "Employee-Invite-password-2026!", new_password: "Employee-Profile-password-2026!" });
    assert.equal(passwordWithoutCsrf.status, 403);
    const incorrectCurrentPassword = await invitedEmployeeAgent
      .post("/api/v1/auth/password")
      .set("x-csrf-token", invitedEmployeeAccepted.body.csrf_token)
      .send({ current_password: "Not-the-current-password", new_password: "Employee-Profile-password-2026!" });
    assert.equal(incorrectCurrentPassword.status, 422);
    const reusedPassword = await invitedEmployeeAgent
      .post("/api/v1/auth/password")
      .set("x-csrf-token", invitedEmployeeAccepted.body.csrf_token)
      .send({ current_password: "Employee-Invite-password-2026!", new_password: "Employee-Invite-password-2026!" });
    assert.equal(reusedPassword.status, 422);
    const changedPassword = await invitedEmployeeAgent
      .post("/api/v1/auth/password")
      .set("x-csrf-token", invitedEmployeeAccepted.body.csrf_token)
      .send({ current_password: "Employee-Invite-password-2026!", new_password: "Employee-Profile-password-2026!" });
    assert.equal(changedPassword.status, 204);
    assert.equal((await invitedEmployeeAgent.get("/api/v1/auth/me")).status, 200);
    assert.equal((await request(app).post("/api/v1/auth/login").send({ email: invitedEmail, password: "Employee-Invite-password-2026!" })).status, 401);
    assert.equal((await request(app).post("/api/v1/auth/login").send({ email: invitedEmail, password: "Employee-Profile-password-2026!" })).status, 200);
    const passwordAudit = await pool.query(
      "SELECT metadata FROM audit_events WHERE tenant_id=$1 AND actor_user_id=$2 AND action='password_changed' ORDER BY occurred_at DESC LIMIT 1",
      [invitedEmployeeAccepted.body.tenant_id, invitedEmployeeAccepted.body.user_id],
    );
    assert.equal(passwordAudit.rowCount, 1);
    assert.deepEqual(passwordAudit.rows[0].metadata, { source: "profile" });
    const passwordReset = await admin
      .post(`/api/v1/hr/directory/${invitedDirectory.body.employee.employee_id}/reset-password`)
      .set("x-csrf-token", context.body.csrf_token)
      .send({});
    assert.equal(passwordReset.status, 200);
    assert.match(passwordReset.body.invite_url, /#\/reset-password\?token=/);
    const passwordResetAgent = request.agent(app);
    const passwordResetAccepted = await passwordResetAgent
      .post("/api/v1/auth/invitations/accept")
      .send({ token: new URL(passwordReset.body.invite_url).hash.split("token=")[1], password: "Employee-Reset-password-2026!" });
    assert.equal(passwordResetAccepted.status, 200);
    const oldPasswordLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: invitedEmail, password: "Employee-Invite-password-2026!" });
    assert.equal(oldPasswordLogin.status, 401);

    const registrationAgent = request.agent(app);
    const registeredTenantId = `public-${Date.now()}`;
    const registered = await registrationAgent
      .post("/api/v1/auth/register-tenant")
      .send({
        tenant_id: registeredTenantId,
        name: "Public Registration Organization",
        timezone: "Asia/Manila",
        locale: "en-PH",
        currency: "PHP",
        week_start: 1,
        support_email: `support-${Date.now()}@dev.local`,
        admin: {
          display_name: "Public HR Administrator",
          email: `public-admin-${Date.now()}@dev.local`,
          password: "Public-Registration-2026!",
        },
      });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.tenant_id, registeredTenantId);
    assert.ok(registered.body.roles.includes("HR Manager"));
    assert.equal(Object.prototype.hasOwnProperty.call(registered.body, "password"), false);
    const registeredEmployees = await registrationAgent.get("/api/v1/employees");
    assert.equal(registeredEmployees.status, 200);
    assert.equal(registeredEmployees.body.length, 1);
    assert.equal(registeredEmployees.body[0].status, "active");
    const lastHrDemotion = await registrationAgent
      .put(`/api/v1/hr/directory/${registered.body.employee_id}`)
      .set("x-csrf-token", registered.body.csrf_token)
      .send({
        ...registeredEmployees.body[0],
        account: { roles: ["Employee"] },
      });
    assert.equal(lastHrDemotion.status, 409);
    assert.equal(lastHrDemotion.body.title, "Last HR Manager");
    const registeredDepartments = await registrationAgent.get("/api/v1/departments");
    assert.equal(registeredDepartments.status, 200);
    assert.equal(registeredDepartments.body[0].name, "General");
    const registeredPlatformContext = await admin
      .post("/api/v1/auth/context")
      .set("x-csrf-token", context.body.csrf_token)
      .send({ tenant_id: registeredTenantId });
    assert.equal(registeredPlatformContext.status, 200);
    assert.equal(registeredPlatformContext.body.active_tenant_id, registeredTenantId);
    assert.equal(registeredPlatformContext.body.email, "admin@dev.local");
    assert.ok(registeredPlatformContext.body.roles.includes("Platform Administrator"));
    assert.ok(registeredPlatformContext.body.roles.includes("HR Manager"));
    assert.ok(registeredPlatformContext.body.capabilities.includes("users:write"));
    assert.ok(registeredPlatformContext.body.capabilities.includes("platform:read"));
    assert.equal((await admin.get("/api/v1/departments")).status, 200);
    const refreshedPlatformContext = await admin.get("/api/v1/auth/me");
    assert.equal(refreshedPlatformContext.body.active_tenant_id, registeredTenantId);
    assert.ok(refreshedPlatformContext.body.roles.includes("Platform Administrator"));
    assert.ok(refreshedPlatformContext.body.roles.includes("HR Manager"));
    assert.ok(refreshedPlatformContext.body.capabilities.includes("users:write"));
    assert.ok(refreshedPlatformContext.body.capabilities.includes("platform:read"));
    const duplicateRegistration = await request(app)
      .post("/api/v1/auth/register-tenant")
      .send({
        tenant_id: registeredTenantId,
        name: "Duplicate Registration Organization",
        timezone: "Asia/Manila",
        locale: "en-PH",
        currency: "PHP",
        week_start: 1,
        admin: { display_name: "Another Admin", email: `duplicate-${Date.now()}@dev.local`, password: "Public-Registration-2026!" },
      });
    assert.equal(duplicateRegistration.status, 409);
    const invalidRegistration = await request(app)
      .post("/api/v1/auth/register-tenant")
      .send({
        tenant_id: "x",
        name: "Invalid Registration Organization",
        timezone: "Asia/Manila",
        locale: "en-PH",
        currency: "PHP",
        week_start: 1,
        admin: { display_name: "Invalid Admin", email: "invalid@example.com", password: "short" },
      });
    assert.equal(invalidRegistration.status, 422);

    process.env.NODE_ENV = "test";
    process.env.INVITATION_TEST_TOKEN = "test-invitation-token-12345678901234567890";
    const tenantId = `browser-${Date.now()}`;
    const provisioned = await admin
      .post("/api/v1/auth/context")
      .set("x-csrf-token", context.body.csrf_token)
      .send({ tenant_id: null });
    assert.equal(provisioned.status, 200);
    assert.ok(provisioned.body.capabilities.includes("platform:read"));
    assert.equal(provisioned.body.capabilities.includes("users:write"), false);
    const provision = await admin
      .post("/api/v1/platform/tenants")
      .set("x-csrf-token", provisioned.body.csrf_token)
      .send({
        tenant_id: tenantId,
        name: "Browser Provisioned Organization",
        timezone: "Asia/Manila",
        locale: "en-PH",
        week_start: 1,
        currency: "PHP",
        initial_admin: { display_name: "Invited HR Admin", email: `invite-${Date.now()}@dev.local` },
      });
    assert.equal(provision.status, 201);
    assert.equal(provision.body.tenant_id, tenantId);
    assert.equal(provision.body.invitation.status, "pending");
    assert.match(provision.body.invite_url, /#\/accept-invitation\?token=/);
    assert.equal(Object.prototype.hasOwnProperty.call(provision.body, "invite_token"), false);
    const generatedInvite = await admin
      .post(`/api/v1/platform/tenants/${tenantId}/invitation/link`)
      .set("x-csrf-token", provisioned.body.csrf_token)
      .send({});
    assert.equal(generatedInvite.status, 200);
    assert.match(generatedInvite.body.invite_url, /#\/accept-invitation\?token=/);

    const duplicate = await admin
      .post("/api/v1/platform/tenants")
      .set("x-csrf-token", provisioned.body.csrf_token)
      .send({
        tenant_id: tenantId,
        name: "Duplicate Organization",
        timezone: "Asia/Manila",
        locale: "en-PH",
        week_start: 1,
        currency: "PHP",
        initial_admin: { display_name: "Another Admin", email: `another-${Date.now()}@dev.local` },
      });
    assert.equal(duplicate.status, 409);

    const edited = await admin
      .put(`/api/v1/platform/tenants/${tenantId}`)
      .set("x-csrf-token", provisioned.body.csrf_token)
      .send({ name: "Edited Browser Organization", reason: "Integration edit" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.name, "Edited Browser Organization");

    const suspended = await admin
      .put(`/api/v1/platform/tenants/${tenantId}/status`)
      .set("x-csrf-token", provisioned.body.csrf_token)
      .send({ status: "suspended", reason: "Integration status test" });
    assert.equal(suspended.status, 200);
    const reactivated = await admin
      .put(`/api/v1/platform/tenants/${tenantId}/status`)
      .set("x-csrf-token", provisioned.body.csrf_token)
      .send({ status: "active", reason: "Integration status restore" });
    assert.equal(reactivated.status, 200);

    const invitationAgent = request.agent(app);
    const accepted = await invitationAgent
      .post("/api/v1/auth/invitations/accept")
      .send({ token: new URL(generatedInvite.body.invite_url).hash.split("token=")[1], password: "Invited-HR-password-2026!" });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.tenant_id, tenantId);
    assert.ok(accepted.body.roles.includes("HR Manager"));
    const invitedEmployees = await invitationAgent.get("/api/v1/employees");
    assert.equal(invitedEmployees.status, 200);
    assert.ok(invitedEmployees.body.every((row) => row.tenant_id === tenantId));
    const tenantUserPlatformAccess = await invitationAgent.get("/api/v1/platform/tenants");
    assert.equal(tenantUserPlatformAccess.status, 403);
    const platformAudit = await pool.query(
      "SELECT action FROM platform_audit_events WHERE target_id=$1 ORDER BY occurred_at",
      [tenantId],
    );
    assert.deepEqual(
      platformAudit.rows.map(({ action }) => action),
      ["tenant_created", "tenant_invitation_created", "tenant_invitation_link_generated", "tenant_updated", "tenant_suspended", "tenant_reactivated"],
    );
    const platformPassword = "Platform-Profile-password-2026!";
    const platformPasswordChanged = await admin
      .post("/api/v1/auth/password")
      .set("x-csrf-token", provisioned.body.csrf_token)
      .send({ current_password: process.env.SEED_ADMIN_PASSWORD, new_password: platformPassword });
    assert.equal(platformPasswordChanged.status, 204);
    assert.equal((await admin.get("/api/v1/auth/me")).status, 200);
    assert.equal((await request(app).post("/api/v1/auth/login").send({ email: "admin@dev.local", password: platformPassword })).status, 200);
    const platformPasswordAudit = await pool.query(
      "SELECT metadata FROM platform_audit_events WHERE platform_user_id='platform-admin' AND action='password_changed' ORDER BY occurred_at DESC LIMIT 1",
    );
    assert.equal(platformPasswordAudit.rowCount, 1);
    assert.deepEqual(platformPasswordAudit.rows[0].metadata, { source: "profile" });
    const platformPasswordRestored = await admin
      .post("/api/v1/auth/password")
      .set("x-csrf-token", provisioned.body.csrf_token)
      .send({ current_password: platformPassword, new_password: process.env.SEED_ADMIN_PASSWORD });
    assert.equal(platformPasswordRestored.status, 204);
    delete process.env.INVITATION_TEST_TOKEN;
    await pool.end();
  },
);
