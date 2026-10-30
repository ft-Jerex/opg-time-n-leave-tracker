import crypto from "node:crypto";

export const attendanceSummaryValues = ({
  actualWorkedMins,
  scheduledMins,
  isOvertimeEligible,
}) => {
  const actual = Math.max(0, Number(actualWorkedMins) || 0);
  const scheduled = Math.max(0, Number(scheduledMins) || 0);
  const workedMins = isOvertimeEligible ? actual : Math.min(actual, scheduled);
  const complete = actual >= scheduled;

  return {
    workedMins,
    scheduledMins: scheduled,
    overtimeMins: isOvertimeEligible ? Math.max(0, actual - scheduled) : 0,
    status: complete ? "complete" : "below_standard",
    exceptionCodes: complete ? [] : ["SHORT_DAY"],
  };
};

export const refreshAttendanceSummary = async (
  client,
  tenantId,
  employeeId,
  localDate,
) => {
  const context = await client.query(
    `SELECT e.job_id, j.standard_daily_mins, j.is_ot_eligible
       FROM employees e
       JOIN job_profiles j ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id
      WHERE e.tenant_id=$1 AND e.employee_id=$2
      FOR SHARE`,
    [tenantId, employeeId],
  );
  if (!context.rowCount) return null;

  const totals = await client.query(
    `SELECT COALESCE(sum(floor(extract(epoch FROM (s.clock_out_at - s.clock_in_at)) / 60)), 0)::integer AS actual_worked_mins,
            count(*)::integer AS closed_count
       FROM attendance_sessions s
       JOIN tenants t ON t.tenant_id=s.tenant_id
      WHERE s.tenant_id=$1 AND s.employee_id=$2 AND s.status='closed'
        AND (s.clock_in_at AT TIME ZONE t.timezone)::date=$3::date`,
    [tenantId, employeeId, localDate],
  );
  const existing = await client.query(
    `SELECT summary_id
       FROM attendance_summaries
      WHERE tenant_id=$1 AND employee_id=$2 AND local_date=$3
      FOR UPDATE`,
    [tenantId, employeeId, localDate],
  );
  if (!existing.rowCount && !Number(totals.rows[0].closed_count)) return null;

  const job = context.rows[0];
  const values = attendanceSummaryValues({
    actualWorkedMins: totals.rows[0].actual_worked_mins,
    scheduledMins: job.standard_daily_mins,
    isOvertimeEligible: job.is_ot_eligible,
  });

  if (existing.rowCount) {
    const result = await client.query(
      `UPDATE attendance_summaries
          SET worked_mins=$1, scheduled_mins=$2, overtime_mins=$3,
              status=$4, exception_codes=$5, effective_job_id=$6
        WHERE tenant_id=$7 AND summary_id=$8
        RETURNING *`,
      [
        values.workedMins,
        values.scheduledMins,
        values.overtimeMins,
        values.status,
        values.exceptionCodes,
        job.job_id,
        tenantId,
        existing.rows[0].summary_id,
      ],
    );
    return result.rows[0];
  }

  const result = await client.query(
    `INSERT INTO attendance_summaries
      (summary_id,tenant_id,employee_id,local_date,worked_mins,scheduled_mins,
       overtime_mins,status,exception_codes,effective_job_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      `summary-${crypto.randomUUID()}`,
      tenantId,
      employeeId,
      localDate,
      values.workedMins,
      values.scheduledMins,
      values.overtimeMins,
      values.status,
      values.exceptionCodes,
      job.job_id,
    ],
  );
  return result.rows[0];
};
