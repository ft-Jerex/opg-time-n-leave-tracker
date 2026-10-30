import express from "express";
import * as service from "../services/organization-report-service.js";
import { send } from "../controllers/resource-controller.js";
import { safeCsvCell } from "../services/report-utils.js";

const cell = safeCsvCell;
const columns = (preset) => preset === "payroll-timesheet"
  ? ["employee_id","employee_number","employee_name","department","job","manager","location","period_start","period_end","worked_mins","overtime_mins","approved_overtime_mins","paid_leave_units","unpaid_leave_units","total_leave_units","leave_units","attendance_statuses"]
  : preset === "leave-taken"
    ? ["request_id","employee_id","employee_number","employee_name","department","job","manager","leave_type_name","payment_type","start_date","end_date","duration","partial_minutes","chargeable_amount","unit","reason","approved_by","submitted_at","decided_at"]
    : null;
const rowValue = (row, key, result) => key === "employee_name" ? row.name : key === "department" ? row.department_name : key === "job" ? row.job_title : key === "manager" ? row.manager_name : key === "location" ? row.location_name : key === "period_start" ? result.from : key === "period_end" ? result.to : row[key];

export const organizationReportRoutes = (app, requireCapability) => {
  const router = express.Router();
  router.get("/payroll-timesheet.xls", requireCapability("users:write"), async (req, res, next) => {
    try {
      const result = await service.generateMonthlyTimesheet(req);
      res.type("application/vnd.ms-excel").set("Content-Disposition", "attachment; filename=Monthly_Time_Logs.xls").send(result.workbook);
    } catch (error) { next(error); }
  });
  router.get("/:preset.csv", requireCapability("users:write"), async (req, res, next) => {
    try {
      const result = await service.generateReport(req, { all: true });
      const keys = columns(req.params.preset) || Object.keys(result.items[0] || {}).filter((key) => !["tenant_id"].includes(key));
      const output = [keys, ...result.items.map((row) => keys.map((key) => rowValue(row, key, result)))].map((row) => row.map(cell).join(",")).join("\n");
      res.type("text/csv").set("Content-Disposition", `attachment; filename=${req.tenantId}-${req.params.preset}-${result.from}-to-${result.to}.csv`).send(output);
    } catch (error) { next(error); }
  });
  router.get("/:preset", requireCapability("users:write"), send(service.generateReport));
  app.use("/api/v1/reports", router);
};
