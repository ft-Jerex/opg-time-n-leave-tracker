import express from "express";
import { send, sendNoContent } from "../controllers/resource-controller.js";
import { acceptInvitation, changePassword, context, login, logout, me, register } from "../controllers/auth-controller.js";
import { requireAuth, requireCsrf } from "../middleware/authentication.js";
import { loginRateLimit } from "../middleware/login-rate-limit.js";
import { registrationRateLimit } from "../middleware/registration-rate-limit.js";

export const authRoutes = () => {
  const router = express.Router();
  router.post("/login", loginRateLimit, send(login));
  router.post("/register-tenant", registrationRateLimit, send(register, 201));
  router.post("/invitations/accept", send(acceptInvitation));
  router.get("/me", requireAuth, send(me));
  router.post("/password", requireAuth, requireCsrf, sendNoContent(changePassword));
  router.post("/context", requireAuth, requireCsrf, send(context));
  router.post("/logout", requireAuth, requireCsrf, async (req, res, next) => {
    try {
      await logout(req, res);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  return router;
};
