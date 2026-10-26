const normalizedWeekStart = (value) => {
  const day = Number(value);
  return Number.isInteger(day) && day >= 0 && day <= 6 ? day : 1;
};

export const monthGrid = (year, monthIndex, weekStart = 1) => {
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  return {
    daysInMonth: new Date(year, monthIndex + 1, 0).getDate(),
    leadingDays: (firstWeekday - normalizedWeekStart(weekStart) + 7) % 7,
  };
};

export const weekdayLabels = (weekStart = 1) => {
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const start = normalizedWeekStart(weekStart);
  return [...labels.slice(start), ...labels.slice(0, start)];
};

export const monthDateForTimeZone = (
  timeZone,
  monthOffset = 0,
  currentDate = new Date(),
) => {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "numeric",
  }).formatToParts(currentDate);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  return new Date(year, month - 1 + monthOffset, 1);
};
