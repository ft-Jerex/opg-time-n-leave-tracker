import { pool } from "../config/database.js";
import { HttpError } from "../views/problem-view.js";
import { exportMonthlyTimesheet, monthDates } from "./monthly-timesheet-export.js";

const presets = new Set(["payroll-timesheet", "organization-absenteeism", "overtime-by-department", "leave-taken", "leave-balance-liability"]);
const todayInZone = (timezone) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
const firstOfMonth = (value) => `${value.slice(0, 8)}01`;

const pageOptions = (query) => {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.page_size || 25)));
  return { page, pageSize, offset: (page - 1) * pageSize };
};

const tenantInfo = async (tenantId) => {
  const result = await pool.query("SELECT tenant_id,name,timezone,currency,settings FROM tenants WHERE tenant_id=$1", [tenantId]);
  if (!result.rowCount) throw new HttpError(404, "Not Found", "Tenant was not found.");
  const tenant = result.rows[0];
  const today = todayInZone(tenant.timezone);
  return { ...tenant, from: firstOfMonth(today), to: today };
};

const baseFilters = (req, from, to) => {
  const params = [req.tenantId, from, to];
  const where = ["e.tenant_id=$1"];
  const add = (sql, value) => { params.push(value); where.push(sql.replace("$VALUE", `$${params.length}`)); };
  const query = req.query || {};
  if (query.q) add("(e.name ILIKE $VALUE OR e.employee_number ILIKE $VALUE OR e.employee_id ILIKE $VALUE)", `%${String(query.q).slice(0, 120)}%`);
  if (query.status) add("e.status=$VALUE", String(query.status));
  if (query.employee_id) add("e.employee_id=$VALUE", String(query.employee_id));
  if (query.manager_id) add("e.manager_id=$VALUE", String(query.manager_id));
  if (query.department_id) add("e.department_id=$VALUE", String(query.department_id));
  if (query.job_id) add("e.job_id=$VALUE", String(query.job_id));
  if (query.location_id) add("e.location_id=$VALUE", String(query.location_id));
  const leaveType = query.leave_type_id ? String(query.leave_type_id) : null;
  return { params, where, leaveType };
};

export const generateMonthlyTimesheet = async (req) => {
  const dates = monthDates(req.query?.month);
  if (!dates) throw new HttpError(422, "Invalid Month", "month must use the YYYY-MM format.");
  const { params, where } = baseFilters(req, dates[0], dates[dates.length - 1]);
  const result = await pool.query(
    `WITH days AS (
       SELECT generate_series($2::date, $3::date, interval '1 day')::date AS local_date
     ), employees_scope AS (
       SELECT e.employee_id,e.employee_number,e.name,e.job_id,j.title AS job_title,COALESCE(u.email,'') AS email
       FROM employees e
       JOIN job_profiles j ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id
       LEFT JOIN LATERAL (
         SELECT email FROM users
         WHERE tenant_id=e.tenant_id AND employee_id=e.employee_id
         ORDER BY (status='active') DESC, user_id
         LIMIT 1
       ) u ON true
       WHERE ${where.join(" AND ")}
     ), attendance AS (
       SELECT employee_id,local_date,COALESCE(sum(worked_mins),0)::integer AS worked_mins
       FROM attendance_summaries
       WHERE tenant_id=$1 AND local_date BETWEEN $2::date AND $3::date
       GROUP BY employee_id,local_date
     )
     SELECT s.employee_id,s.employee_number,s.name,s.job_id,s.job_title,s.email,
            jsonb_object_agg(to_char(d.local_date,'YYYY-MM-DD'),COALESCE(a.worked_mins,0) ORDER BY d.local_date) AS daily
     FROM employees_scope s CROSS JOIN days d
     LEFT JOIN attendance a ON a.employee_id=s.employee_id AND a.local_date=d.local_date
     GROUP BY s.employee_id,s.employee_number,s.name,s.job_id,s.job_title,s.email
     ORDER BY s.name ASC,s.employee_id ASC`,
    params,
  );
  return { month: req.query.month, dates, rows: result.rows, workbook: exportMonthlyTimesheet({ rows: result.rows, dates }) };
};

const payroll = async (req, info, all) => {
  const { params, where, leaveType } = baseFilters(req, req.query.from || info.from, req.query.to || info.to);
  params.push(leaveType);
  const result = await pool.query(
    `WITH employees_scope AS (
       SELECT e.employee_id,e.employee_number,e.name,e.status,e.manager_id,e.department_id,e.job_id,e.location_id,
              d.name AS department_name,j.title AS job_title,l.name AS location_name,m.name AS manager_name
       FROM employees e
       JOIN departments d ON d.tenant_id=e.tenant_id AND d.department_id=e.department_id
       JOIN job_profiles j ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id
       JOIN locations l ON l.tenant_id=e.tenant_id AND l.location_id=e.location_id
       LEFT JOIN employees m ON m.tenant_id=e.tenant_id AND m.employee_id=e.manager_id
       WHERE ${where.join(" AND ")}
     ), attendance AS (
       SELECT employee_id,COALESCE(sum(worked_mins),0)::integer AS worked_mins,
              COALESCE(sum(overtime_mins),0)::integer AS overtime_mins,
              array_agg(DISTINCT status ORDER BY status) AS attendance_statuses
       FROM attendance_summaries WHERE tenant_id=$1 AND local_date BETWEEN $2::date AND $3::date GROUP BY employee_id
     ), approved_overtime AS (
       SELECT employee_id,COALESCE(sum(minutes),0)::integer AS approved_overtime_mins
       FROM overtime_ledger_entries
       WHERE tenant_id=$1 AND local_date BETWEEN $2::date AND $3::date
       GROUP BY employee_id
     ), leave_totals AS (
       SELECT lr.employee_id,
              COALESCE(sum(CASE WHEN lt.is_paid THEN lr.chargeable_amount ELSE 0 END),0)::numeric AS paid_leave_units,
              COALESCE(sum(CASE WHEN NOT lt.is_paid THEN lr.chargeable_amount ELSE 0 END),0)::numeric AS unpaid_leave_units,
              COALESCE(sum(lr.chargeable_amount),0)::numeric AS total_leave_units,
              string_agg(DISTINCT lt.unit, ', ' ORDER BY lt.unit) AS leave_units
       FROM leave_requests lr JOIN leave_types lt ON lt.tenant_id=lr.tenant_id AND lt.leave_type_id=lr.leave_type_id
       WHERE lr.tenant_id=$1 AND lr.status='approved' AND lr.start_date <= $3::date AND lr.end_date >= $2::date AND ($${params.length}::text IS NULL OR lr.leave_type_id=$${params.length})
       GROUP BY lr.employee_id
     )
     SELECT s.*,COALESCE(a.worked_mins,0)::integer AS worked_mins,COALESCE(a.overtime_mins,0)::integer AS overtime_mins,
            COALESCE(o.approved_overtime_mins,0)::integer AS approved_overtime_mins,
            COALESCE(a.attendance_statuses,ARRAY[]::text[]) AS attendance_statuses,
            COALESCE(l.paid_leave_units,0)::numeric AS paid_leave_units,COALESCE(l.unpaid_leave_units,0)::numeric AS unpaid_leave_units,
            COALESCE(l.total_leave_units,0)::numeric AS total_leave_units,COALESCE(l.leave_units,'') AS leave_units
     FROM employees_scope s LEFT JOIN attendance a ON a.employee_id=s.employee_id
       LEFT JOIN approved_overtime o ON o.employee_id=s.employee_id
       LEFT JOIN leave_totals l ON l.employee_id=s.employee_id
     ORDER BY s.name ASC,s.employee_id ASC`,
    params,
  );
  return { rows: result.rows, basis: "Worked and attendance-derived overtime come from attendance summaries. Approved overtime requests are shown separately so they are not double-counted; leave totals include approved requests only.", title: "Payroll preparation timesheet" };
};

const absenteeism = async (req, info) => {
  const { params, where } = baseFilters(req, req.query.from || info.from, req.query.to || info.to);
  const result = await pool.query(
    `SELECT e.employee_id,e.employee_number,e.name,e.department_id,d.name AS department_name,
            count(*) FILTER (WHERE s.status='absent')::integer AS absent_days,
            count(*) FILTER (WHERE s.status='leave')::integer AS leave_days,
            count(*) FILTER (WHERE s.status IN ('missing_punch','pending_adjustment'))::integer AS incomplete_days,
            count(*)::integer AS recorded_days
       FROM employees e JOIN departments d ON d.tenant_id=e.tenant_id AND d.department_id=e.department_id
       LEFT JOIN attendance_summaries s ON s.tenant_id=e.tenant_id AND s.employee_id=e.employee_id AND s.local_date BETWEEN $2::date AND $3::date
      WHERE ${where.join(" AND ")} GROUP BY e.employee_id,e.employee_number,e.name,e.department_id,d.name ORDER BY e.name`,
    params,
  );
  return { rows: result.rows, basis: "Counts distinguish absent, approved leave, and incomplete attendance statuses in the selected tenant-local date range.", title: "Organization absenteeism" };
};

const overtime = async (req, info) => {
  const { params, where } = baseFilters(req, req.query.from || info.from, req.query.to || info.to);
  const result = await pool.query(
    `WITH approved_overtime AS (
       SELECT employee_id,COALESCE(sum(minutes),0)::integer AS approved_overtime_mins
       FROM overtime_ledger_entries
       WHERE tenant_id=$1 AND local_date BETWEEN $2::date AND $3::date
       GROUP BY employee_id
     )
     SELECT e.department_id,d.name AS department_name,
            COALESCE(sum(CASE WHEN j.is_ot_eligible THEN s.overtime_mins ELSE 0 END),0)::integer AS overtime_mins,
            COALESCE(sum(CASE WHEN NOT j.is_ot_eligible THEN GREATEST(s.worked_mins-j.standard_daily_mins,0) ELSE 0 END),0)::integer AS limit_exception_mins,
            COALESCE(sum(o.approved_overtime_mins),0)::integer AS approved_overtime_mins,
            count(DISTINCT e.employee_id)::integer AS employee_count
       FROM employees e JOIN departments d ON d.tenant_id=e.tenant_id AND d.department_id=e.department_id
       JOIN job_profiles j ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id
       LEFT JOIN attendance_summaries s ON s.tenant_id=e.tenant_id AND s.employee_id=e.employee_id AND s.local_date BETWEEN $2::date AND $3::date
       LEFT JOIN approved_overtime o ON o.employee_id=e.employee_id
      WHERE ${where.join(" AND ")} GROUP BY e.department_id,d.name ORDER BY d.name`,
    params,
  );
  return { rows: result.rows, basis: "Attendance-derived overtime, approved overtime requests, and non-eligible work above the daily job standard are reported separately.", title: "Overtime by department" };
};

const leaveTaken = async (req, info) => {
  const { params, where, leaveType } = baseFilters(req, req.query.from || info.from, req.query.to || info.to);
  params.push(leaveType);
  const leaveTypeParameter = `$${params.length}`;
  const result = await pool.query(
    `SELECT lr.request_id,e.employee_id,e.employee_number,e.name,
            d.name AS department_name,j.title AS job_title,
            COALESCE(m.name,'') AS manager_name,lt.name AS leave_type_name,
            lt.unit,CASE WHEN lt.is_paid THEN 'Paid' ELSE 'Unpaid' END AS payment_type,
            lr.start_date,lr.end_date,lr.partial_day,
            CASE WHEN lr.partial_day='custom_hours'
                 THEN to_char(lr.partial_start_time,'HH24:MI') || '–' || to_char(lr.partial_end_time,'HH24:MI')
                 ELSE 'Full day(s)' END AS duration,
            lr.partial_minutes,lr.chargeable_amount::numeric,lr.reason,
            lr.submitted_at,lr.decided_at,COALESCE(a.name,'') AS approved_by
       FROM leave_requests lr
       JOIN employees e
         ON e.tenant_id=lr.tenant_id AND e.employee_id=lr.employee_id
       JOIN departments d
         ON d.tenant_id=e.tenant_id AND d.department_id=e.department_id
       JOIN job_profiles j
         ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id
       JOIN leave_types lt
         ON lt.tenant_id=lr.tenant_id AND lt.leave_type_id=lr.leave_type_id
       LEFT JOIN employees m
         ON m.tenant_id=e.tenant_id AND m.employee_id=e.manager_id
       LEFT JOIN employees a
         ON a.tenant_id=lr.tenant_id AND a.employee_id=lr.approver_id
      WHERE ${where.join(" AND ")}
        AND lr.status='approved'
        AND lr.start_date <= $3::date AND lr.end_date >= $2::date
        AND (${leaveTypeParameter}::text IS NULL OR lr.leave_type_id=${leaveTypeParameter})
      ORDER BY lr.start_date DESC,e.name ASC,lr.request_id ASC`,
    params,
  );
  return {
    rows: result.rows,
    basis: "Detailed approved leave overlapping the selected date range. Draft, pending, rejected, withdrawn, and cancelled requests are excluded.",
    title: "Approved leave taken",
  };
};

const liability = async (req, info) => {
  const { params, where } = baseFilters(req, req.query.from || info.from, req.query.to || info.to);
  const rate = Number(info.settings?.mock_leave_valuation_rate || 1);
  const result = await pool.query(
    `SELECT e.employee_id,e.employee_number,e.name,e.department_id,d.name AS department_name,
            b.leave_type_id,lt.name AS leave_type_name,lt.unit,b.remaining::numeric,
            $${params.length + 1}::numeric AS valuation_rate,(b.remaining*$${params.length + 1}::numeric)::numeric AS estimated_value
       FROM employees e JOIN departments d ON d.tenant_id=e.tenant_id AND d.department_id=e.department_id
       JOIN leave_balances b ON b.tenant_id=e.tenant_id AND b.employee_id=e.employee_id
       JOIN leave_types lt ON lt.tenant_id=b.tenant_id AND lt.leave_type_id=b.leave_type_id
      WHERE ${where.join(" AND ")} AND b.as_of BETWEEN $2::date AND $3::date ORDER BY e.name,lt.name`,
    [...params, rate],
  );
  return { rows: result.rows, basis: "Remaining leave balances are multiplied by a mock valuation rate and labeled as an estimate; this does not execute payroll or accounting.", title: "End-of-year leave balance liability", valuation_rate: rate };
};

export const generateReport = async (req, { all = false } = {}) => {
  const preset = req.params.preset;
  if (!presets.has(preset)) throw new HttpError(404, "Not Found", "Unknown report preset.");
  const info = await tenantInfo(req.tenantId);
  const result = preset === "payroll-timesheet"
    ? await payroll(req, info, all)
    : preset === "organization-absenteeism"
      ? await absenteeism(req, info)
      : preset === "overtime-by-department"
        ? await overtime(req, info)
        : preset === "leave-taken"
          ? await leaveTaken(req, info)
          : await liability(req, info);
  const { page, pageSize, offset } = pageOptions(req.query || {});
  const rows = all ? result.rows : result.rows.slice(offset, offset + pageSize);
  const totals = result.rows.reduce((acc, row) => { for (const [key, value] of Object.entries(row)) if (typeof value === "number") acc[key] = (acc[key] || 0) + value; return acc; }, {});
  return { preset, title: result.title, tenant: { tenant_id: info.tenant_id, name: info.name, timezone: info.timezone, currency: info.currency }, from: req.query.from || info.from, to: req.query.to || info.to, generated_at: new Date().toISOString(), basis: result.basis, valuation_rate: result.valuation_rate, items: rows, total: result.rows.length, page: all ? 1 : page, page_size: all ? result.rows.length : pageSize, page_count: all ? 1 : Math.max(1, Math.ceil(result.rows.length / pageSize)), totals, filters: req.query };
};
