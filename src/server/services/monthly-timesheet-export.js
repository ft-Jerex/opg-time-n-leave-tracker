import * as XLSX from "xlsx";

const pad = (value) => String(value).padStart(2, "0");

export const monthDates = (month) => {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) return null;
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    return `${year}-${pad(monthNumber)}-${pad(day)}`;
  });
};

const displayDate = (isoDate) => {
  const [year, month, day] = isoDate.split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${pad(day)}-${names[month - 1]}-${year}`;
};

const hoursText = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${pad(minutes % 60)}`;
const decimalHours = (minutes) => Math.round((minutes / 60) * 100) / 100;
const rowMinutes = (row, date) => Number(row.daily?.[date] || 0);

const rowsForSheet = (rows, dates, decimal) => rows.map((row) => {
  const daily = dates.map((date) => {
    const minutes = rowMinutes(row, date);
    return decimal ? decimalHours(minutes) : hoursText(minutes);
  });
  const totalMinutes = dates.reduce((total, date) => total + rowMinutes(row, date), 0);
  return [row.name, row.email || "", row.tenant_id, row.job_title, row.job_title, ...daily, decimal ? decimalHours(totalMinutes) : hoursText(totalMinutes)];
});

export const buildMonthlyTimesheetWorkbook = ({ rows, dates }) => {
  const headers = ["Employee Name", "Email ID", "Company Name", "Role", "Job Name", ...dates.map(displayDate), "Total"];
  const totalRow = ["Total", "", "", "", "", ...dates.map((date) => {
    const minutes = rows.reduce((total, row) => total + rowMinutes(row, date), 0);
    return minutes;
  }), 0];
  const grandTotal = dates.reduce((total, date) => total + rows.reduce((sum, row) => sum + rowMinutes(row, date), 0), 0);
  totalRow[totalRow.length - 1] = grandTotal;
  const hoursTotal = totalRow.map((value, index) => index < 5 ? value : hoursText(value));
  const decimalTotal = totalRow.map((value, index) => index < 5 ? value : decimalHours(value));
  const hours = [headers, ...rowsForSheet(rows, dates, false), hoursTotal];
  const decimal = [headers, ...rowsForSheet(rows, dates, true), decimalTotal];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(hours), "Monthly Time Logs_Hours_1");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(decimal), "Monthly Time Logs_Decimal_2");
  return workbook;
};

export const exportMonthlyTimesheet = ({ rows, dates }) => XLSX.write(buildMonthlyTimesheetWorkbook({ rows, dates }), { bookType: "biff8", type: "buffer" });
