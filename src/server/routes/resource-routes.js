import express from "express";

export const resourceRoutes = (
  app,
  resources,
  service,
  send,
  sendNoContent,
  requireCapability,
  requireResourceRead,
) => {
  for (const resource of Object.keys(resources)) {
    const router = express.Router();
    router.get(
      "/",
      requireResourceRead(resource),
      send(service.listResource(resource)),
    );
    router.get(
      "/:id",
      requireResourceRead(resource),
      send(service.getResource(resource)),
    );
    if (resource === "overtime-requests") {
      router.post(
        "/",
        requireCapability("overtime-requests:write"),
        send(service.createResource(resource), 201),
      );
    } else if (
      !["tenants", "users", "attendance-summaries", "leave-balances", "audit-events"].includes(
        resource,
      )
    ) {
      router.post(
        "/",
        requireCapability(`${resource}:write`),
        send(service.createResource(resource), 201),
      );
      router.put(
        "/:id",
        requireCapability(`${resource}:write`),
        send(service.replaceResource(resource)),
      );
      router.delete(
        "/:id",
        requireCapability(`${resource}:write`),
        sendNoContent(service.deleteResource(resource)),
      );
    }
    app.use(`/api/v1/${resource}`, router);
  }
};
