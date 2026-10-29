import { pool } from "../config/database.js";

export const exportAudit = async (req) => {
  const values = [req.tenantId];
  const where = ["a.tenant_id=$1"];
  const add = (sql, value) => { values.push(value); where.push(sql.replace("$VALUE", `$${values.length}`)); };
  if (req.query.q) add("concat_ws(' ',a.action,a.target_type,a.target_id,a.reason) ILIKE $VALUE", `%${String(req.query.q).slice(0, 120)}%`);
  if (req.query.actor_user_id) add("a.actor_user_id=$VALUE", req.query.actor_user_id);
  if (req.query.action) add("a.action=$VALUE", req.query.action);
  if (req.query.target_type) add("a.target_type=$VALUE", req.query.target_type);
  if (req.query.from) add("a.occurred_at >= $VALUE::date", req.query.from);
  if (req.query.to) add("a.occurred_at < ($VALUE::date + interval '1 day')", req.query.to);
  const direction = String(req.query.direction).toLowerCase() === "asc" ? "ASC" : "DESC";
  const result = await pool.query(
    `SELECT a.event_id,a.occurred_at,a.actor_user_id,u.display_name AS actor,
            a.action,a.target_type,a.target_id,
            COALESCE(target_user.display_name,target_employee.name,target_department.name,
                     target_job.title,target_leave_type.name,a.metadata->>'employee_name',a.target_id) AS target_name,
            a.reason,a.metadata
       FROM audit_events a
       LEFT JOIN users u
         ON u.tenant_id=a.tenant_id AND u.user_id=a.actor_user_id
       LEFT JOIN users target_user
         ON a.target_type='User' AND target_user.tenant_id=a.tenant_id AND target_user.user_id=a.target_id
       LEFT JOIN leave_requests target_leave
         ON a.target_type='LeaveRequest' AND target_leave.tenant_id=a.tenant_id AND target_leave.request_id=a.target_id
       LEFT JOIN attendance_sessions target_session
         ON a.target_type='AttendanceSession' AND target_session.tenant_id=a.tenant_id AND target_session.session_id=a.target_id
       LEFT JOIN attendance_adjustments target_adjustment
         ON a.target_type='AttendanceAdjustment' AND target_adjustment.tenant_id=a.tenant_id AND target_adjustment.adjustment_id=a.target_id
       LEFT JOIN overtime_requests target_overtime
         ON a.target_type='OvertimeRequest' AND target_overtime.tenant_id=a.tenant_id AND target_overtime.overtime_request_id=a.target_id
       LEFT JOIN employees target_employee
         ON target_employee.tenant_id=a.tenant_id
        AND target_employee.employee_id=COALESCE(
          CASE WHEN a.target_type='Employee' THEN a.target_id END,
          target_leave.employee_id,target_session.employee_id,target_adjustment.employee_id,
          target_overtime.employee_id,a.metadata->>'employee_id'
        )
       LEFT JOIN departments target_department
         ON a.target_type='Department' AND target_department.tenant_id=a.tenant_id AND target_department.department_id=a.target_id
       LEFT JOIN job_profiles target_job
         ON a.target_type='JobProfile' AND target_job.tenant_id=a.tenant_id AND target_job.job_id=a.target_id
       LEFT JOIN leave_types target_leave_type
         ON a.target_type='LeaveType' AND target_leave_type.tenant_id=a.tenant_id AND target_leave_type.leave_type_id=a.target_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.occurred_at ${direction},a.event_id ASC`,
    values,
  );
  return result.rows;
};
