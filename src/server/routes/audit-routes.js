import express from "express";
import { exportAudit } from "../services/audit-export-service.js";
import { safeCsvCell } from "../services/report-utils.js";

const cell = safeCsvCell;

export const auditRoutes = (app, requireCapability) => {
  const router = express.Router();
  router.get("/export.csv", requireCapability("users:write"), async (req, res, next) => {
    try {
      const rows = await exportAudit(req);
      const headers = ["event_id","occurred_at","actor_user_id","actor","action","target_type","target_id","target_name","reason","metadata"];
      const output = [headers, ...rows.map((row) => headers.map((key) => key === "metadata" ? JSON.stringify(row[key] || {}) : row[key]))].map((row) => row.map(cell).join(",")).join("\n");
      res.type("text/csv").set("Content-Disposition", `attachment; filename=${req.tenantId}-audit-${new Date().toISOString().slice(0, 10)}.csv`).send(output);
    } catch (error) { next(error); }
  });
  app.use("/api/v1/audit-events", router);
};
