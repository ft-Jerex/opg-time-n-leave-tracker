const indexBy = (rows, key) => new Map((rows || []).map((row) => [row[key], row]));

export const auditDisplayRows = (events, data) => {
  const users = indexBy(data.users, "user_id");
  const employees = indexBy(data.employees, "employee_id");
  const departments = indexBy(data.departments, "department_id");
  const jobs = indexBy(data["job-profiles"], "job_id");
  const leaveTypes = indexBy(data["leave-types"], "leave_type_id");
  const tenants = indexBy(data.tenants, "tenant_id");
  const leaveRequests = indexBy(data["leave-requests"], "request_id");
  const attendanceSessions = indexBy(data["attendance-sessions"], "session_id");
  const attendanceAdjustments = indexBy(data["attendance-adjustments"], "adjustment_id");
  const overtimeRequests = indexBy(data["overtime-requests"], "overtime_request_id");
  const employeeName = (employeeId) => employees.get(employeeId)?.name;

  const targetName = (event) => {
    const metadataEmployee = event.metadata?.employee_id;
    if (event.target_type === "Employee") return employeeName(event.target_id);
    if (event.target_type === "User") {
      const user = users.get(event.target_id);
      return user?.display_name || employeeName(user?.employee_id);
    }
    if (event.target_type === "Department") return departments.get(event.target_id)?.name;
    if (event.target_type === "JobProfile") return jobs.get(event.target_id)?.title;
    if (event.target_type === "LeaveType") return leaveTypes.get(event.target_id)?.name;
    if (event.target_type === "Tenant") return tenants.get(event.target_id)?.name;
    if (event.target_type === "LeaveRequest")
      return employeeName(leaveRequests.get(event.target_id)?.employee_id || metadataEmployee);
    if (event.target_type === "AttendanceSession")
      return employeeName(attendanceSessions.get(event.target_id)?.employee_id || metadataEmployee);
    if (event.target_type === "AttendanceAdjustment")
      return employeeName(attendanceAdjustments.get(event.target_id)?.employee_id || metadataEmployee);
    if (event.target_type === "OvertimeRequest")
      return employeeName(overtimeRequests.get(event.target_id)?.employee_id || metadataEmployee);
    return employeeName(metadataEmployee);
  };

  return (events || []).map((event) => ({
    ...event,
    actor: users.get(event.actor_user_id)?.display_name || event.actor_user_id || "System",
    target_name: targetName(event) || event.target_id,
  }));
};
