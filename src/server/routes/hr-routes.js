import express from "express";
import { send } from "../controllers/resource-controller.js";
import * as service from "../services/hr-service.js";

export const hrRoutes = (app, requireCapability) => {
  const router = express.Router();
  router.post("/directory", requireCapability("users:write"), send(service.createDirectoryEntry, 201));
  router.put("/directory/:employee_id", requireCapability("users:write"), send(service.updateDirectoryEntry));
  router.post("/directory/:employee_id/reset-password", requireCapability("users:write"), send(service.resetPassword));
  router.post("/directory/:employee_id/invitation/link", requireCapability("users:write"), send(service.generateDirectoryInvitationLink));
  router.get("/my-job-profile", send(service.getOwnJobProfile));
  router.get("/my-leave-options", send(service.getOwnLeaveOptions));
  router.post("/leave-overrides", requireCapability("leave:override"), send(service.createLeaveOverride, 201));
  router.post("/attendance-overrides", requireCapability("attendance:override"), send(service.createAttendanceOverride, 201));
  app.use("/api/v1/hr", router);
};
