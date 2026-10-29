import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "../../src/server/config/database.js";

if (
  process.env.NODE_ENV === "production" ||
  process.env.ALLOW_DEV_SEED !== "true"
) {
  throw new Error(
    "Seeding is development-only. Set ALLOW_DEV_SEED=true explicitly.",
  );
}

const q = (text, values = []) => pool.query(text, values);
const upsert = async (table, columns, values, conflict) =>
  q(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")}) ON CONFLICT (${conflict}) DO UPDATE SET ${columns
      .slice(1)
      .map((column, i) => `${column} = EXCLUDED.${column}`)
      .join(", ")} RETURNING *`,
    values,
  );

const seed = async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "TRUNCATE platform_audit_events, platform_memberships, platform_credentials, platform_users, tenant_platform_state, audit_events, alerts, holidays, leave_requests, leave_ledger_entries, leave_balances, job_leave_policies, leave_types, attendance_adjustments, attachments, attendance_summaries, attendance_sessions, auth_credentials, users, employees, job_profiles, work_schedules, locations, holiday_calendars, departments, tenants CASCADE",
    );
    await client.query(
      `INSERT INTO tenants (tenant_id,name,timezone,locale,week_start,currency,settings) VALUES ('northstar','Northstar Civic Services','Asia/Manila','en-PH',1,'PHP','{"industry":"public services","support_email":"ops@northstar.dev","overtime_warning_percent":80,"minimum_coverage":3}'),('harbor','Harbor & Field Logistics','Asia/Manila','en-PH',1,'PHP','{"industry":"logistics","support_email":"hr@harbor.dev","overtime_warning_percent":80,"minimum_coverage":1}')`,
    );
    await client.query(
      `INSERT INTO tenant_platform_state (tenant_id,status,settings) VALUES ('northstar','active','{"minimum_coverage":3,"overtime_warning_percent":80}'),('harbor','active','{"minimum_coverage":1,"overtime_warning_percent":80}')`,
    );
    await client.query(
      `INSERT INTO departments (department_id,tenant_id,name,code,status) VALUES ('ns-ops','northstar','Operations & Service Delivery','OPS','active'),('ns-people','northstar','People Experience','PEOPLE','active'),('hb-dispatch','harbor','Dispatch & Fleet','DISPATCH','active')`,
    );
    await client.query(
      `INSERT INTO holiday_calendars (holiday_calendar_id,tenant_id,name,location_ids,status) VALUES ('ns-ph','northstar','Philippine Public Holidays',ARRAY['ns-manila'],'active'),('hb-ph','harbor','Harbor Public Holidays',ARRAY['hb-manila'],'active')`,
    );
    await client.query(
      `INSERT INTO locations (location_id,tenant_id,name,timezone,holiday_calendar_id,status) VALUES ('ns-manila','northstar','Makati Service Centre','Asia/Manila','ns-ph','active'),('hb-manila','harbor','Port Area Operations Hub','Asia/Manila','hb-ph','active')`,
    );
    await client.query(
      `INSERT INTO work_schedules (schedule_id,tenant_id,name,weekday_rules,effective_from,effective_to,status) VALUES ('ns-standard','northstar','Standard Monday-Friday', '{"monday":{"start":"08:30","end":"17:30"},"tuesday":{"start":"08:30","end":"17:30"},"wednesday":{"start":"08:30","end":"17:30"},"thursday":{"start":"08:30","end":"17:30"},"friday":{"start":"08:30","end":"17:30"}}','2025-01-01',NULL,'active'),('hb-shift','harbor','Dispatch Flex Shift','{"monday":{"start":"07:00","end":"16:00"},"tuesday":{"start":"07:00","end":"16:00"}}','2025-01-01',NULL,'active')`,
    );
    await client.query(
      `INSERT INTO job_profiles (job_id,tenant_id,title,department_id,standard_daily_mins,standard_weekly_mins,is_ot_eligible,max_daily_mins,effective_from,effective_to,status) VALUES ('ns-manager','northstar','Service Delivery Manager','ns-ops',480,2400,true,720,'2025-01-01',NULL,'active'),('ns-coordinator','northstar','Operations Coordinator','ns-ops',480,2400,false,600,'2025-01-01',NULL,'active'),('ns-people','northstar','People Operations Partner','ns-people',480,2400,true,720,'2025-01-01',NULL,'active'),('hb-dispatcher','harbor','Dispatch Coordinator','hb-dispatch',480,2400,true,720,'2025-01-01',NULL,'active')`,
    );
    await client.query(
      `INSERT INTO employees (employee_id,tenant_id,employee_number,name,job_id,manager_id,department_id,location_id,holiday_calendar_id,work_schedule,start_date,status) VALUES ('ns-alex','northstar','NS-0001','Alexandra Reyes','ns-manager',NULL,'ns-ops','ns-manila','ns-ph','{"schedule_id":"ns-standard"}','2023-04-17','active'),('ns-morgan','northstar','NS-0002','Morgan Santos','ns-coordinator','ns-alex','ns-ops','ns-manila','ns-ph','{"schedule_id":"ns-standard"}','2024-02-12','active'),('ns-jamie','northstar','NS-0003','Jamie O''Neil — Service Desk','ns-people','ns-alex','ns-people','ns-manila','ns-ph','{"schedule_id":"ns-standard"}','2022-11-01','active'),('hb-rina','harbor','HB-0001','Rina Villanueva','hb-dispatcher',NULL,'hb-dispatch','hb-manila','hb-ph','{"schedule_id":"hb-shift"}','2021-06-07','active')`,
    );
    await client.query(`INSERT INTO employees (employee_id,tenant_id,employee_number,name,job_id,manager_id,department_id,location_id,holiday_calendar_id,work_schedule,start_date,status)
      SELECT 'ns-team-' || lpad(ordinality::text,2,'0'), 'northstar', 'NS-' || lpad((ordinality + 10)::text,4,'0'), employee_name,
             'ns-coordinator', 'ns-alex', 'ns-ops', 'ns-manila', 'ns-ph', '{"schedule_id":"ns-standard"}'::jsonb,
             date '2021-01-11' + (ordinality * 67)::integer, CASE WHEN ordinality = 12 THEN 'inactive' ELSE 'active' END
        FROM unnest(ARRAY['Arielle Mendoza','Benedict Tan','Carmina Dela Cruz','Diego Navarro','Elena Bautista','Francis Lim','Giselle Ramos','Hector Valdez','Isabela Aquino','Joaquin Garcia','Katrina Flores','Lorenzo Castillo']) WITH ORDINALITY AS roster(employee_name, ordinality)`);
    const personas = [
      [
        "usr-admin",
        "northstar",
        "ns-alex",
        "Alexandra Reyes",
        "admin@dev.local",
        [
          "users:write",
          "employees:write",
          "departments:write",
          "locations:write",
          "work-schedules:write",
          "job-profiles:write",
          "attendance-sessions:write",
          "attendance-adjustments:write",
          "attendance:write",
          "attendance:approve",
          "attendance:override",
          "leave-types:write",
          "job-leave-policies:write",
          "leave-balances:write",
          "leave-ledger-entries:write",
          "leave-requests:write",
          "leave:write",
          "leave:approve",
          "leave:override",
          "overtime-requests:write",
          "overtime:approve",
          "attachments:write",
          "holiday-calendars:write",
          "holidays:write",
          "alerts:write",
        ],
      ],
      [
        "usr-manager",
        "northstar",
        "ns-alex",
        "Alexandra Reyes",
        "manager@dev.local",
        [
          "attendance-sessions:write",
          "attendance-adjustments:write",
          "attendance:write",
          "attendance:approve",
          "overtime:approve",
          "leave-requests:write",
          "leave:write",
          "leave:approve",
          "overtime-requests:write",
          "alerts:write",
        ],
      ],
      [
        "usr-hr",
        "northstar",
        "ns-alex",
        "Maya Patel",
        "hr@dev.local",
        [
          "attendance-sessions:write",
          "attendance-adjustments:write",
          "attendance:write",
          "attendance:approve",
          "attendance:override",
          "leave-requests:write",
          "leave:write",
          "leave:approve",
          "leave:override",
          "overtime-requests:write",
          "overtime:approve",
          "leave-types:write",
          "job-profiles:write",
          "job-leave-policies:write",
          "employees:write",
          "users:write",
          "departments:write",
          "locations:write",
          "work-schedules:write",
          "attachments:write",
          "holiday-calendars:write",
          "holidays:write",
          "alerts:write",
        ],
      ],
      [
        "usr-user",
        "northstar",
        "ns-morgan",
        "Morgan Santos",
        "user@dev.local",
        [
          "attendance-sessions:write",
          "attendance-adjustments:write",
          "attendance:write",
          "leave-requests:write",
          "leave:write",
          "overtime-requests:write",
          "attachments:write",
        ],
      ],
      [
        "usr-readonly",
        "northstar",
        "ns-jamie",
        "Jamie O'Neil — Service Desk",
        "readonly@dev.local",
        [],
      ],
      [
        "usr-harbor",
        "harbor",
        "hb-rina",
        "Rina Villanueva",
        "harbor@dev.local",
        [
          "attendance-sessions:write",
          "attendance:write",
          "leave-requests:write",
          "leave:write",
          "overtime-requests:write",
        ],
      ],
    ];
    for (const [id, tenant, employee, name, email, capabilities] of personas)
      await client.query(
        "INSERT INTO users (user_id,tenant_id,employee_id,display_name,email,capabilities,status) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [id, tenant, employee, name, email, capabilities, "active"],
      );
    const passwords = {
      "admin@dev.local": process.env.SEED_ADMIN_PASSWORD,
      "hr@dev.local": process.env.SEED_HR_PASSWORD || process.env.SEED_ADMIN_PASSWORD,
      "manager@dev.local": process.env.SEED_USER_PASSWORD,
      "user@dev.local": process.env.SEED_USER_PASSWORD,
      "readonly@dev.local": process.env.SEED_READONLY_PASSWORD,
      "harbor@dev.local": process.env.SEED_USER_PASSWORD,
    };
    for (const [, tenant, , , email] of personas.filter(([, , , , email]) => email !== "admin@dev.local"))
      await client.query(
        "INSERT INTO auth_credentials (user_id,tenant_id,email,password_hash) SELECT user_id,tenant_id,$1,$2 FROM users WHERE email=$1",
        [
          email,
          await bcrypt.hash(
            passwords[email],
            Number(process.env.BCRYPT_ROUNDS || 12),
          ),
        ],
      );
    await client.query(
      `INSERT INTO platform_users (platform_user_id,display_name,email,capabilities,status) VALUES ('platform-admin','Maya Patel','admin@dev.local',ARRAY['platform:read','platform:write','organizations:write','access:write','platform-audit:read'],'active')`,
    );
    await client.query(
      `INSERT INTO platform_memberships (platform_user_id,tenant_id,tenant_user_id,roles,status) VALUES ('platform-admin','northstar','usr-admin',ARRAY['Platform Administrator','HR Manager'],'active'),('platform-admin','harbor','usr-harbor',ARRAY['Platform Administrator','HR Manager'],'active')`,
    );
    await client.query(
      `INSERT INTO platform_credentials (platform_user_id,email,password_hash) VALUES ('platform-admin','admin@dev.local',$1)`,
      [await bcrypt.hash(passwords["admin@dev.local"], Number(process.env.BCRYPT_ROUNDS || 12))],
    );
    await client.query(
      `INSERT INTO leave_types (leave_type_id,tenant_id,name,code,unit,is_paid,color,description,status) VALUES ('ns-annual','northstar','Annual Leave','AL','days',true,'#2563eb','Paid annual leave for planned rest and recovery.','active'),('ns-sick','northstar','Sick Leave','SL','days',true,'#dc2626','Medical leave with supporting documentation where required.','active'),('hb-annual','harbor','Annual Leave','AL','days',true,'#2563eb','Paid annual leave.','active')`,
    );
    await client.query(
      `INSERT INTO job_leave_policies (policy_id,tenant_id,job_id,leave_type_id,annual_allotment,accrual_rule,carry_over_limit,allow_negative,allow_partial_day,counting_rule,request_window,documentation_rule,effective_from,effective_to,status) VALUES ('ns-annual-policy','northstar','ns-coordinator','ns-annual',20,'{"type":"monthly"}',5,false,true,'{"weekends":false,"holidays":false}','{"min_days":1,"max_days":365}','{"required_after_days":5}','2025-01-01',NULL,'active'),('ns-sick-policy','northstar','ns-coordinator','ns-sick',10,'{"type":"annual"}',0,true,true,'{"weekends":false,"holidays":false}','{"min_days":1,"max_days":30}','{"required_after_days":2}','2025-01-01',NULL,'active'),('hb-annual-policy','harbor','hb-dispatcher','hb-annual',18,'{"type":"monthly"}',3,false,true,'{"weekends":false,"holidays":false}','{"min_days":1,"max_days":365}','{"required_after_days":5}','2025-01-01',NULL,'active')`,
    );
    await client.query(`INSERT INTO job_leave_policies (policy_id,tenant_id,job_id,leave_type_id,annual_allotment,accrual_rule,carry_over_limit,allow_negative,allow_partial_day,counting_rule,request_window,documentation_rule,effective_from,effective_to,status) VALUES
      ('ns-manager-annual-policy','northstar','ns-manager','ns-annual',22,'{"type":"monthly"}',5,false,true,'{"weekends":false,"holidays":false}','{"min_days":1,"max_days":365}','{"required_after_days":5}','2025-01-01',NULL,'active'),
      ('ns-manager-sick-policy','northstar','ns-manager','ns-sick',12,'{"type":"annual"}',0,true,true,'{"weekends":false,"holidays":false}','{"min_days":0,"max_days":30}','{"required_after_days":2}','2025-01-01',NULL,'active'),
      ('ns-people-annual-policy','northstar','ns-people','ns-annual',20,'{"type":"monthly"}',5,false,true,'{"weekends":false,"holidays":false}','{"min_days":1,"max_days":365}','{"required_after_days":5}','2025-01-01',NULL,'active'),
      ('ns-people-sick-policy','northstar','ns-people','ns-sick',10,'{"type":"annual"}',0,true,true,'{"weekends":false,"holidays":false}','{"min_days":0,"max_days":30}','{"required_after_days":2}','2025-01-01',NULL,'active')`);
    await client.query(
      `INSERT INTO leave_balances (balance_id,tenant_id,employee_id,leave_type_id,period,accrued,carried_over,manual_adjustments,used,pending,remaining,unit,as_of) VALUES ('bal-morgan-annual','northstar','ns-morgan','ns-annual','2026',15,2,0,4,2,13,'days','2026-09-01'),('bal-morgan-sick','northstar','ns-morgan','ns-sick','2026',10,0,0,1,0,9,'days','2026-09-01'),('bal-rina-annual','harbor','hb-rina','hb-annual','2026',12,1,0,2,0,11,'days','2026-09-01')`,
    );
    await client.query(`INSERT INTO leave_balances (balance_id,tenant_id,employee_id,leave_type_id,period,accrued,carried_over,manual_adjustments,used,pending,remaining,unit,as_of) VALUES
      ('bal-alex-annual','northstar','ns-alex','ns-annual','2026',18,3,0,5,0,16,'days','2026-09-01'),
      ('bal-alex-sick','northstar','ns-alex','ns-sick','2026',12,0,0,1,0,11,'days','2026-09-01'),
      ('bal-jamie-annual','northstar','ns-jamie','ns-annual','2026',16,1,0,7,0,10,'days','2026-09-01'),
      ('bal-jamie-sick','northstar','ns-jamie','ns-sick','2026',10,0,0,3,0,7,'days','2026-09-01')`);
    await client.query(`INSERT INTO leave_balances (balance_id,tenant_id,employee_id,leave_type_id,period,accrued,carried_over,manual_adjustments,used,pending,remaining,unit,as_of)
      SELECT 'bal-' || employee_id || '-annual', tenant_id, employee_id, 'ns-annual', '2026', 15,
             CASE WHEN employee_id IN ('ns-team-03','ns-team-08') THEN 3 ELSE 1 END,
             CASE WHEN employee_id='ns-team-05' THEN -1 ELSE 0 END,
             (substring(employee_id from '[0-9]+$'))::integer % 7, 0,
             15 + CASE WHEN employee_id IN ('ns-team-03','ns-team-08') THEN 3 ELSE 1 END + CASE WHEN employee_id='ns-team-05' THEN -1 ELSE 0 END - ((substring(employee_id from '[0-9]+$'))::integer % 7),
             'days', '2026-09-01' FROM employees WHERE tenant_id='northstar' AND employee_id LIKE 'ns-team-%'`);
    await client.query(
      `INSERT INTO holidays (holiday_id,tenant_id,holiday_calendar_id,name,local_date,observance_type,description,status) VALUES ('ns-holiday-1','northstar','ns-ph','Ninoy Aquino Day','2026-08-21','public','Public holiday observed by the service centre.','active'),('ns-holiday-2','northstar','ns-ph','Founders'' Day — Northstar','2026-10-09','company','Company-wide closure.','active'),('hb-holiday-1','harbor','hb-ph','Port Operations Day','2026-09-30','company','Reduced dispatch schedule.','active')`,
    );
    await client.query(
      `INSERT INTO attendance_sessions (session_id,tenant_id,employee_id,clock_in_at,clock_out_at,source,status,version) VALUES ('session-morgan-closed','northstar','ns-morgan','2026-09-17T08:31:00+08:00','2026-09-17T17:42:00+08:00','responsive_web','closed',1)`,
    );
    await client.query(
      `INSERT INTO attendance_summaries (summary_id,tenant_id,employee_id,local_date,worked_mins,scheduled_mins,overtime_mins,status,exception_codes,effective_job_id) VALUES ('summary-morgan-1','northstar','ns-morgan','2026-09-17',551,480,71,'complete',ARRAY[]::text[],'ns-coordinator'),('summary-morgan-2','northstar','ns-morgan','2026-09-16',420,480,0,'below_standard',ARRAY['SHORT_DAY'],'ns-coordinator')`,
    );
    await client.query(`INSERT INTO attendance_summaries (summary_id,tenant_id,employee_id,local_date,worked_mins,scheduled_mins,overtime_mins,status,exception_codes,effective_job_id)
      SELECT 'summary-' || e.employee_id || '-' || to_char(day,'YYYYMMDD'), e.tenant_id, e.employee_id, day::date,
             CASE WHEN extract(day FROM day)::integer % 7 = 0 THEN 420 ELSE 480 + (extract(day FROM day)::integer % 4) * 15 END,
             480, CASE WHEN extract(day FROM day)::integer % 7 = 0 THEN 0 ELSE (extract(day FROM day)::integer % 4) * 15 END,
             CASE WHEN extract(day FROM day)::integer % 7 = 0 THEN 'below_standard' ELSE 'complete' END,
             CASE WHEN extract(day FROM day)::integer % 7 = 0 THEN ARRAY['SHORT_DAY']::text[] ELSE ARRAY[]::text[] END, e.job_id
        FROM employees e CROSS JOIN generate_series(date '2026-09-01',date '2026-09-18','1 day') day
       WHERE e.tenant_id='northstar' AND e.employee_id LIKE 'ns-team-%' AND e.status='active' AND extract(isodow FROM day) BETWEEN 1 AND 5`);
    await client.query(`INSERT INTO attachments (attachment_id,tenant_id,owner_type,owner_id,file_name,mime_type,size_bytes,mock_url,validation_status) VALUES
      ('attachment-medical','northstar','LeaveRequest','leave-morgan-pending','Medical certificate - Santos.pdf','application/pdf',248731,'seed://northstar/medical-certificate-santos','accepted'),
      ('attachment-adjustment','northstar','AttendanceAdjustment','adjustment-morgan-approved','Transit receipt (MRT-3).png','image/png',98214,'seed://northstar/transit-receipt-mrt3','accepted'),
      ('attachment-rejected','northstar','LeaveRequest','leave-jamie-rejected','scan.exe','application/octet-stream',10485761,'seed://northstar/rejected-scan','rejected')`);
    await client.query(`INSERT INTO attendance_adjustments (adjustment_id,tenant_id,employee_id,local_date,original,proposed,reason,attachment_ids,status,submitted_at,decided_by,decided_at,decision_note,version) VALUES
      ('adjustment-morgan-pending','northstar','ns-morgan','2026-09-16','{"clock_in":"09:10","clock_out":null}','{"clock_in":"09:10","clock_out":"17:15"}','Forgot to clock out after the client escalation call.',ARRAY[]::text[],'pending','2026-09-17T08:12:00+08:00',NULL,NULL,NULL,1),
      ('adjustment-morgan-approved','northstar','ns-morgan','2026-08-28','{"clock_in":"09:02","clock_out":"16:31"}','{"clock_in":"09:02","clock_out":"17:34"}','Train disruption delayed the final clock-out sync.',ARRAY['attachment-adjustment'],'approved','2026-08-29T08:00:00+08:00','usr-manager','2026-08-29T10:30:00+08:00','Receipt and schedule verified.',2),
      ('adjustment-jamie-rejected','northstar','ns-jamie','2026-07-11','{"clock_in":"08:29","clock_out":"17:30"}','{"clock_in":"07:00","clock_out":"19:00"}','Requested extension for unverified off-site work.',ARRAY[]::text[],'rejected','2026-07-12T09:00:00+08:00','usr-manager','2026-07-12T13:45:00+08:00','No supporting assignment record was available.',2)`);
    await client.query(`INSERT INTO leave_ledger_entries (entry_id,tenant_id,employee_id,leave_type_id,effective_date,amount,entry_type,source_id,reason,created_by,created_at) VALUES
      ('ledger-morgan-accrual','northstar','ns-morgan','ns-annual','2026-09-01',1.25,'accrual','monthly-accrual-2026-09','September monthly accrual','usr-admin','2026-09-01T00:05:00+08:00'),
      ('ledger-morgan-usage','northstar','ns-morgan','ns-annual','2026-07-20',-2,'usage','leave-morgan-approved','Approved annual leave usage','usr-manager','2026-07-02T10:00:00+08:00'),
      ('ledger-morgan-carry','northstar','ns-morgan','ns-annual','2026-01-01',2,'carry_over','carry-over-2025','Eligible prior-year carry-over','usr-admin','2026-01-01T00:10:00+08:00')`);
    await client.query(
      `INSERT INTO leave_requests (request_id,tenant_id,employee_id,leave_type_id,start_date,end_date,partial_day,chargeable_amount,reason,attachment_ids,status,approver_id,submitted_at,decided_at,decision_note,version) VALUES ('leave-morgan-pending','northstar','ns-morgan','ns-annual','2026-10-12','2026-10-13','none',2,'Family commitment requiring planned travel.',ARRAY[]::text[],'pending','ns-alex','2026-09-10T09:00:00+08:00',NULL,NULL,0),('leave-morgan-approved','northstar','ns-morgan','ns-annual','2026-07-20','2026-07-21','none',2,'Rest and recovery after a high-demand quarter.',ARRAY[]::text[],'approved','ns-alex','2026-07-01T09:00:00+08:00','2026-07-02T10:00:00+08:00','Approved for planned leave.',1),('leave-jamie-rejected','northstar','ns-jamie','ns-sick','2026-06-03','2026-06-05','none',3,'Medical appointment and recovery period.',ARRAY[]::text[],'rejected','ns-alex','2026-06-01T09:00:00+08:00','2026-06-02T10:00:00+08:00','Insufficient documentation.',1)`,
    );
    await client.query(
      `INSERT INTO alerts (alert_id,tenant_id,employee_id,type,severity,period_start,period_end,current_mins,threshold_mins,created_at,status) VALUES ('alert-morgan-overtime','northstar','ns-morgan','overtime','warning','2026-09-14','2026-09-18',2710,2400,'2026-09-18T08:00:00+08:00','open'),('alert-jamie-missing','northstar','ns-jamie','missing_punch','critical','2026-09-16','2026-09-16',0,480,'2026-09-17T08:00:00+08:00','acknowledged')`,
    );
    await client.query(
      `INSERT INTO audit_events (event_id,tenant_id,actor_user_id,actor_role,action,target_type,target_id,occurred_at,reason,metadata) VALUES ('audit-seed-1','northstar','usr-admin','tenant_admin','seed_initialized','Tenant','northstar','2026-09-18T08:00:00+08:00','Development dataset initialized','{"source":"seed","version":1}')`,
    );
    await client.query("COMMIT");
    console.log("Development database seeded successfully.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};
await seed();
