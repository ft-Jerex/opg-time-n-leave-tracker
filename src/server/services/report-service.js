import { pool } from "../config/database.js";
import { HttpError } from "../views/problem-view.js";
import { normalizeSearchQuery } from "../../shared/search.js";

const scope = (req) => {
  if (!req.actor?.employee_id) throw new HttpError(403, "Forbidden", "A tenant workspace is required.");
  const hr = req.actor.capabilities?.includes("users:write");
  return hr ? { clause: "e.status = 'active'", values: [] } : { clause: "e.manager_id = $2 AND e.employee_id <> $2", values: [req.actor.employee_id] };
};

const page = (req) => ({
  number: Math.max(1, Number(req.query.page || 1)),
  size: Math.min(100, Math.max(1, Number(req.query.page_size || req.query.limit || 25))),
});

export const teamTimesheets = async (req) => {
  const { clause, values } = scope(req);
  const q = normalizeSearchQuery(req.query.q);
  const status = String(req.query.status || "").trim();
  const allowedStatuses = new Set(["", "complete", "below_standard", "absent", "missing_punch"]);
  if (!allowedStatuses.has(status))
    throw new HttpError(422, "Invalid Request", "The timesheet status filter is invalid.");
  const params = [req.tenantId, ...values];
  const filters = [`s.tenant_id = $1`, clause];
  if (q) {
    params.push(q);
    filters.push(`(position(lower($${params.length}) in lower(e.name)) > 0 OR position(lower($${params.length}) in lower(e.employee_number)) > 0 OR position($${params.length} in s.local_date::text) > 0)`);
  }
  if (status) { params.push(status); filters.push(`s.status = $${params.length}`); }
  const count = await pool.query(`SELECT count(*)::integer AS total FROM attendance_summaries s JOIN employees e ON e.tenant_id=s.tenant_id AND e.employee_id=s.employee_id WHERE ${filters.join(" AND ")}`, params);
  const { number, size } = page(req); const offset = (number - 1) * size;
  params.push(size, offset);
  const rows = await pool.query(`SELECT s.summary_id, s.employee_id, e.name, e.employee_number, e.job_id, s.local_date, s.worked_mins, s.scheduled_mins, s.overtime_mins, s.status FROM attendance_summaries s JOIN employees e ON e.tenant_id=s.tenant_id AND e.employee_id=s.employee_id WHERE ${filters.join(" AND ")} ORDER BY s.local_date DESC, e.name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows.rows, total: count.rows[0].total, page: number, page_size: size, page_count: Math.max(1, Math.ceil(count.rows[0].total / size)) };
};

export const teamAlerts = async (req) => {
  const { clause, values } = scope(req);
  const result = await pool.query(`SELECT e.employee_id, e.name, j.title AS job_title, j.standard_weekly_mins, j.is_ot_eligible, j.max_daily_mins, date_trunc('week', CURRENT_DATE)::date AS week_start, (date_trunc('week', CURRENT_DATE) + interval '6 days')::date AS week_end, COALESCE(sum(s.worked_mins),0)::integer AS worked_mins, COALESCE(sum(s.scheduled_mins),0)::integer AS scheduled_mins, max(s.worked_mins)::integer AS max_daily_worked FROM employees e JOIN job_profiles j ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id LEFT JOIN attendance_summaries s ON s.tenant_id=e.tenant_id AND s.employee_id=e.employee_id AND s.local_date >= date_trunc('week', CURRENT_DATE)::date AND s.local_date < (date_trunc('week', CURRENT_DATE) + interval '7 days')::date WHERE e.tenant_id=$1 AND ${clause} GROUP BY e.employee_id,e.name,j.title,j.standard_weekly_mins,j.is_ot_eligible,j.max_daily_mins ORDER BY e.name`, [req.tenantId, ...values]);
  return result.rows.map((row) => { const percent = row.standard_weekly_mins ? Math.round((row.worked_mins / row.standard_weekly_mins) * 100) : 0; const type = row.max_daily_mins && row.max_daily_worked > row.max_daily_mins ? "daily_limit_breach" : percent >= 100 ? (row.is_ot_eligible ? "overtime" : "limit_exception") : percent >= 80 ? "approaching" : null; return type ? { ...row, type, severity: type === "approaching" ? "warning" : "critical", variance_mins: row.worked_mins - row.standard_weekly_mins, percent } : null; }).filter(Boolean);
};

export const teamCalendar = async (req) => {
  const { clause, values } = scope(req);
  const result = await pool.query(`SELECT l.request_id,l.employee_id,e.name,l.leave_type_id,l.start_date,l.end_date,l.status,l.reason FROM leave_requests l JOIN employees e ON e.tenant_id=l.tenant_id AND e.employee_id=l.employee_id WHERE l.tenant_id=$1 AND ${clause} AND l.status IN ('approved','pending') ORDER BY l.start_date,e.name`, [req.tenantId, ...values]);
  return result.rows;
};

export const dashboard = async (req) => {
  const { clause, values } = scope(req);
  const reportCount = await pool.query(`SELECT count(*)::integer AS total FROM employees e WHERE e.tenant_id=$1 AND ${clause}`, [req.tenantId, ...values]);
  const alerts = await teamAlerts(req);
  const calendar = await teamCalendar(req);
  const timesheets = await teamTimesheets({ ...req, query: { ...req.query, page: 1, page_size: 1 } });
  const overtime = await pool.query(`SELECT count(*)::integer AS total FROM overtime_requests o JOIN employees e ON e.tenant_id=o.tenant_id AND e.employee_id=o.employee_id WHERE o.tenant_id=$1 AND o.status='pending' AND ${clause}`, [req.tenantId, ...values]);
  const pendingLeave = calendar.filter((item) => item.status === "pending").length;
  return { direct_reports: reportCount.rows[0].total, timesheets, alerts, upcoming_leave: calendar.slice(0, 10), pending_approvals: pendingLeave + overtime.rows[0].total, pending_overtime_approvals: overtime.rows[0].total };
};
