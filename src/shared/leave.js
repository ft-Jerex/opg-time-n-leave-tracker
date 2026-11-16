export const DAY_LEAVE_CREDITS_PER_HOUR = 0.11;

const roundCredits = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export const partialLeaveCharge = (minutes, unit = "days") => {
  const hours = Math.max(0, Number(minutes) || 0) / 60;
  return roundCredits(unit === "hours" ? hours : hours * DAY_LEAVE_CREDITS_PER_HOUR);
};

const localDateTimeParts = (timeZone, currentDate) => {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(currentDate);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}:${value("second")}`,
  };
};

export const hasLeavePeriodEnded = (
  request,
  timeZone = "UTC",
  currentDate = new Date(),
) => {
  if (!request?.end_date) return false;
  const current = localDateTimeParts(timeZone, currentDate);
  if (current.date !== request.end_date) return current.date > request.end_date;
  if (request.partial_day !== "custom_hours" || !request.partial_end_time)
    return false;
  const selectedEndTime = request.partial_end_time.slice(0, 5);
  return current.time > `${selectedEndTime}:00`;
};
