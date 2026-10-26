export const completedRecordedSeconds = ({
  summaryMinutes,
  closedSessionSeconds,
  isOvertimeEligible,
  maxDailyMins,
}) => {
  const seconds = Math.max(
    Math.max(0, Number(summaryMinutes) || 0) * 60,
    Math.max(0, Number(closedSessionSeconds) || 0),
  );
  if (isOvertimeEligible || maxDailyMins === null || maxDailyMins === undefined)
    return seconds;
  const limitSeconds = Math.max(0, Number(maxDailyMins) || 0) * 60;
  return Math.min(seconds, limitSeconds);
};
