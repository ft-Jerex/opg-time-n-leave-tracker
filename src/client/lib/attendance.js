export const completedRecordedSeconds = ({
  summaryMinutes,
  closedSessionSeconds,
  maxDailyMins,
}) => {
  const seconds = Math.max(
    Math.max(0, Number(summaryMinutes) || 0) * 60,
    Math.max(0, Number(closedSessionSeconds) || 0),
  );
  if (maxDailyMins === null || maxDailyMins === undefined)
    return seconds;
  const limitSeconds = Math.max(0, Number(maxDailyMins) || 0) * 60;
  return Math.min(seconds, limitSeconds);
};

export const weeklyCompletedSeconds = ({
  dates,
  summaries,
  employeeId,
  maxDailyMins,
}) => {
  const minutesByDate = new Map();
  for (const row of summaries || []) {
    if (row.employee_id !== employeeId || !dates.includes(row.local_date)) continue;
    minutesByDate.set(
      row.local_date,
      Math.max(minutesByDate.get(row.local_date) || 0, Number(row.worked_mins) || 0),
    );
  }
  const days = dates.map((localDate) => ({
    localDate,
    seconds: completedRecordedSeconds({
      summaryMinutes: minutesByDate.get(localDate) || 0,
      closedSessionSeconds: 0,
      maxDailyMins,
    }),
  }));
  return {
    days,
    totalSeconds: days.reduce((sum, day) => sum + day.seconds, 0),
  };
};

export const employeePresence = ({ employeeId, sessions, leaveRequests, localDate }) => {
  const onLeave = (leaveRequests || []).some(
    (item) =>
      item.employee_id === employeeId &&
      item.status === "approved" &&
      item.start_date <= localDate &&
      item.end_date >= localDate,
  );
  if (onLeave) return "on_leave";
  return (sessions || []).some(
    (item) => item.employee_id === employeeId && item.status === "open",
  )
    ? "clocked_in"
    : "clocked_out";
};
