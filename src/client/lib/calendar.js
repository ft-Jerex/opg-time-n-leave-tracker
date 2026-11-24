const normalizedWeekStart = (value) => {
  const day = Number(value);
  return Number.isInteger(day) && day >= 0 && day <= 6 ? day : 1;
};

export const formatUsDate = (isoDate) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  return match ? `${match[2]}/${match[3]}/${match[1]}` : "";
};

export const parseUsDate = (displayDate) => {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(displayDate || "");
  if (!match) return "";
  const isoDate = `${match[3]}-${match[1]}-${match[2]}`;
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === isoDate
    ? isoDate
    : "";
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

export const localDateForTimeZone = (timeZone, currentDate = new Date()) => {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(currentDate);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
};

export const addLocalDays = (localDate, amount) => {
  const value = new Date(`${localDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + Number(amount || 0));
  return value.toISOString().slice(0, 10);
};

export const workWeekStart = (localDate) => {
  const value = new Date(`${localDate}T00:00:00Z`);
  const mondayOffset = (value.getUTCDay() + 6) % 7;
  return addLocalDays(localDate, -mondayOffset);
};

export const workWeekDates = (localDate) => {
  const start = workWeekStart(localDate);
  return Array.from({ length: 5 }, (_, index) => addLocalDays(start, index));
};

export const isWeekendDate = (localDate) => {
  const day = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

export const teamLeaveDay = (rows, localDate, includePending = false) => {
  if (isWeekendDate(localDate))
    return { scheduled: [], details: [], repeatedEmployee: false };
  const details = rows.filter((row) => row.start_date <= localDate && row.end_date >= localDate);
  const scheduled = details.filter((row) => row.status === "approved" || (includePending && row.status === "pending"));
  const repeatedEmployee = new Set(scheduled.map((row) => row.employee_id)).size < scheduled.length;
  return { scheduled, details, repeatedEmployee };
};

export const workWeekLabel = (localDate) => {
  const [start, , , , end] = workWeekDates(localDate);
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  if (startYear !== endYear)
    return `${months[startMonth - 1]} ${startDay}, ${startYear} - ${months[endMonth - 1]} ${endDay}, ${endYear}`;
  if (startMonth !== endMonth)
    return `${months[startMonth - 1]} ${startDay} - ${months[endMonth - 1]} ${endDay} | ${startYear}`;
  return `${months[startMonth - 1]} ${startDay} - ${endDay} | ${startYear}`;
};
