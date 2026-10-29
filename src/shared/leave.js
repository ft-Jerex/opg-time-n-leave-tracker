export const DAY_LEAVE_CREDITS_PER_HOUR = 0.11;

const roundCredits = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export const partialLeaveCharge = (minutes, unit = "days") => {
  const hours = Math.max(0, Number(minutes) || 0) / 60;
  return roundCredits(unit === "hours" ? hours : hours * DAY_LEAVE_CREDITS_PER_HOUR);
};
