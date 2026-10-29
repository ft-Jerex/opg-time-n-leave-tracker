import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "policy reset settings persist through the API and accrual rollover is idempotent",
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
    const hr = request.agent(app);
    const employee = request.agent(app);
    const hrLogin = await hr.post("/api/v1/auth/login").send({
      email: "hr@dev.local",
      password: process.env.SEED_HR_PASSWORD || process.env.SEED_ADMIN_PASSWORD,
    });
    const employeeLogin = await employee.post("/api/v1/auth/login").send({
      email: "user@dev.local",
      password: process.env.SEED_USER_PASSWORD,
    });
    assert.equal(hrLogin.status, 200);
    assert.equal(employeeLogin.status, 200);

    const policyResponse = await hr.get(
      "/api/v1/job-leave-policies/ns-people-annual-policy",
    );
    assert.equal(policyResponse.status, 200);
    const originalPolicy = policyResponse.body;
    const monthlyPolicy = {
      ...originalPolicy,
      accrual_rule: {
        ...originalPolicy.accrual_rule,
        reset_frequency: "monthly",
      },
    };

    try {
      const forbidden = await employee
        .put("/api/v1/job-leave-policies/ns-people-annual-policy")
        .set("x-csrf-token", employeeLogin.body.csrf_token)
        .send(monthlyPolicy);
      assert.equal(forbidden.status, 403);

      const updated = await hr
        .put("/api/v1/job-leave-policies/ns-people-annual-policy")
        .set("x-csrf-token", hrLogin.body.csrf_token)
        .send(monthlyPolicy);
      assert.equal(updated.status, 200);
      assert.equal(updated.body.accrual_rule.reset_frequency, "monthly");

      const persisted = await hr.get(
        "/api/v1/job-leave-policies/ns-people-annual-policy",
      );
      assert.equal(persisted.status, 200);
      assert.equal(persisted.body.accrual_rule.reset_frequency, "monthly");

      const annualAccrualPolicy = await hr.get(
        "/api/v1/job-leave-policies/ns-people-sick-policy",
      );
      assert.equal(annualAccrualPolicy.status, 200);
      const incompatible = await hr
        .put("/api/v1/job-leave-policies/ns-people-sick-policy")
        .set("x-csrf-token", hrLogin.body.csrf_token)
        .send({
          ...annualAccrualPolicy.body,
          accrual_rule: {
            ...annualAccrualPolicy.body.accrual_rule,
            reset_frequency: "monthly",
          },
        });
      assert.equal(incompatible.status, 422);
    } finally {
      const restored = await hr
        .put("/api/v1/job-leave-policies/ns-people-annual-policy")
        .set("x-csrf-token", hrLogin.body.csrf_token)
        .send(originalPolicy);
      assert.equal(restored.status, 200);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO tenants (tenant_id,name,timezone,locale,week_start,currency,settings)
        VALUES ('accrual-test','Accrual Test','Asia/Manila','en-PH',1,'PHP','{}');
        INSERT INTO departments (department_id,tenant_id,name,code,status)
        VALUES ('accrual-dept','accrual-test','Accrual','ACCR','active');
        INSERT INTO holiday_calendars (holiday_calendar_id,tenant_id,name,location_ids,status)
        VALUES ('accrual-calendar','accrual-test','Accrual Calendar',ARRAY[]::text[],'active');
        INSERT INTO locations (location_id,tenant_id,name,timezone,holiday_calendar_id,status)
        VALUES ('accrual-location','accrual-test','Accrual Location','Asia/Manila','accrual-calendar','active');
        INSERT INTO job_profiles (
          job_id,tenant_id,title,department_id,standard_daily_mins,
          standard_weekly_mins,is_ot_eligible,max_daily_mins,
          effective_from,effective_to,status
        ) VALUES (
          'accrual-job','accrual-test','Accrual Job','accrual-dept',480,
          2400,false,480,'2026-01-01',NULL,'active'
        );
        INSERT INTO employees (
          employee_id,tenant_id,employee_number,name,job_id,manager_id,
          department_id,location_id,holiday_calendar_id,work_schedule,
          start_date,status
        ) VALUES (
          'accrual-employee','accrual-test','ACCR-001','Accrual Employee',
          'accrual-job',NULL,'accrual-dept','accrual-location','accrual-calendar',
          '{}','2026-01-01','active'
        );
        INSERT INTO leave_types (
          leave_type_id,tenant_id,name,code,unit,is_paid,color,description,status
        ) VALUES (
          'accrual-leave','accrual-test','Accrual Leave','ACL','days',true,
          '#2563eb','Accrual verification leave','active'
        );
        INSERT INTO job_leave_policies (
          policy_id,tenant_id,job_id,leave_type_id,annual_allotment,
          accrual_rule,carry_over_limit,allow_negative,allow_partial_day,
          counting_rule,request_window,documentation_rule,effective_from,
          effective_to,status
        ) VALUES (
          'accrual-policy','accrual-test','accrual-job','accrual-leave',60,
          '{"type":"monthly","reset_frequency":"monthly"}',3,false,true,
          '{"weekends":false,"holidays":false}',
          '{"min_days":0,"max_days":365}',
          '{"required_after_days":5}','2026-01-01',NULL,'active'
        );
        INSERT INTO leave_balances (
          balance_id,tenant_id,employee_id,leave_type_id,period,accrued,
          carried_over,manual_adjustments,used,pending,remaining,unit,as_of
        ) VALUES (
          'accrual-balance','accrual-test','accrual-employee','accrual-leave',
          '2026',10,0,0,2,1,8,'days','2026-10-31'
        );
      `);

      const monthlyRun = await client.query(
        "SELECT app_private.run_monthly_leave_accrual($1,$2) AS credited",
        ["accrual-test", "2026-11-01"],
      );
      assert.equal(monthlyRun.rows[0].credited, 1);
      const monthlyBalance = await client.query(
        `SELECT accrued,carried_over,manual_adjustments,used,pending,remaining,period
           FROM leave_balances WHERE balance_id='accrual-balance'`,
      );
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(monthlyBalance.rows[0]).map(([key, value]) => [
            key,
            key === "period" ? value : Number(value),
          ]),
        ),
        {
          accrued: 5,
          carried_over: 0,
          manual_adjustments: 0,
          used: 0,
          pending: 1,
          remaining: 5,
          period: "2026",
        },
      );
      const monthlyLedger = await client.query(
        `SELECT entry_type,amount FROM leave_ledger_entries
          WHERE tenant_id='accrual-test'
          ORDER BY CASE entry_type WHEN 'expiry' THEN 1 WHEN 'carry_over' THEN 2 WHEN 'accrual' THEN 3 ELSE 4 END`,
      );
      assert.deepEqual(
        monthlyLedger.rows.map((row) => ({
          entry_type: row.entry_type,
          amount: Number(row.amount),
        })),
        [
          { entry_type: "expiry", amount: -8 },
          { entry_type: "accrual", amount: 5 },
        ],
      );
      const monthlyRetry = await client.query(
        "SELECT app_private.run_monthly_leave_accrual($1,$2) AS credited",
        ["accrual-test", "2026-11-01"],
      );
      assert.equal(monthlyRetry.rows[0].credited, 0);

      await client.query(`
        UPDATE job_leave_policies
           SET accrual_rule='{"type":"monthly","reset_frequency":"annually"}'
         WHERE policy_id='accrual-policy';
        UPDATE leave_balances
           SET period='2026', accrued=10, carried_over=0,
               manual_adjustments=0, used=2, pending=1, remaining=8,
               as_of='2026-12-31'
         WHERE balance_id='accrual-balance';
      `);
      const annualRun = await client.query(
        "SELECT app_private.run_monthly_leave_accrual($1,$2) AS credited",
        ["accrual-test", "2027-01-01"],
      );
      assert.equal(annualRun.rows[0].credited, 1);
      const annualBalance = await client.query(
        `SELECT accrued,carried_over,manual_adjustments,used,pending,remaining,period
           FROM leave_balances WHERE balance_id='accrual-balance'`,
      );
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(annualBalance.rows[0]).map(([key, value]) => [
            key,
            key === "period" ? value : Number(value),
          ]),
        ),
        {
          accrued: 5,
          carried_over: 3,
          manual_adjustments: 0,
          used: 0,
          pending: 1,
          remaining: 8,
          period: "2027",
        },
      );
      const annualLedger = await client.query(
        `SELECT entry_type,amount FROM leave_ledger_entries
          WHERE tenant_id='accrual-test' AND effective_date='2027-01-01'
          ORDER BY CASE entry_type WHEN 'expiry' THEN 1 WHEN 'carry_over' THEN 2 WHEN 'accrual' THEN 3 ELSE 4 END`,
      );
      assert.deepEqual(
        annualLedger.rows.map((row) => ({
          entry_type: row.entry_type,
          amount: Number(row.amount),
        })),
        [
          { entry_type: "expiry", amount: -8 },
          { entry_type: "carry_over", amount: 3 },
          { entry_type: "accrual", amount: 5 },
        ],
      );
      const annualRetry = await client.query(
        "SELECT app_private.run_monthly_leave_accrual($1,$2) AS credited",
        ["accrual-test", "2027-01-01"],
      );
      assert.equal(annualRetry.rows[0].credited, 0);

      const finalLedgerCount = await client.query(
        "SELECT count(*)::integer AS count FROM leave_ledger_entries WHERE tenant_id='accrual-test'",
      );
      assert.equal(finalLedgerCount.rows[0].count, 5);
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  },
);
