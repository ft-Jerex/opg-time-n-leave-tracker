import express from "express";
import { send } from "../controllers/resource-controller.js";
import * as service from "../services/report-service.js";

const csvCell = (value) => { const text = String(value ?? ""); const safe = /^[=+\-@]/.test(text) ? `'${text}` : text; return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe; };
const csv = (result) => [
  ["employee_number", "employee", "date", "worked_mins", "scheduled_mins", "overtime_mins", "status"],
  ...result.items.map((row) => [row.employee_number, row.name, row.local_date, row.worked_mins, row.scheduled_mins, row.overtime_mins, row.status]),
].map((row) => row.map(csvCell).join(",")).join("\n");

export const reportRoutes = (app, requireCapability) => {
  const router = express.Router();
  router.get("/dashboard", requireCapability("leave:approve"), send(service.dashboard));
  router.get("/calendar", requireCapability("leave:approve"), send(service.teamCalendar));
  router.get("/timesheets", requireCapability("leave:approve"), send(service.teamTimesheets));
  router.get("/alerts", requireCapability("leave:approve"), send(service.teamAlerts));
  router.get("/reports/:preset.csv", requireCapability("leave:approve"), async (req, res, next) => { try { const result = await service.teamTimesheets(req); res.type("text/csv").set("Content-Disposition", `attachment; filename=timesheets-${req.tenantId}-${new Date().toISOString().slice(0, 10)}.csv`).send(csv(result)); } catch (error) { next(error); } });
  router.get("/reports/:preset", requireCapability("leave:approve"), send(service.teamTimesheets));
  app.use("/api/v1/team", router);
};
