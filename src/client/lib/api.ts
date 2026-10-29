import type { EntityMap, LeaveOption, User } from "../domain/types";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  request_id: string;
}

export interface AuthContext extends User {
  csrf_token: string | null;
  actor_kind?: "tenant" | "platform";
  roles?: string[];
  memberships?: Array<Record<string, unknown>>;
  active_tenant_id?: string | null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  page_count: number;
}

export class ApiError extends Error {
  status: number;
  problem: ProblemDetails | null;
  constructor(status: number, problem: ProblemDetails | null) {
    super(problem?.detail || "The request failed.");
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

const readCsrf = () =>
  document.cookie
    .split("; ")
    .find((item) => item.startsWith("tlt_csrf="))
    ?.split("=")
    .slice(1)
    .join("=");

async function request<T>(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<T> {
  const method = options.method || "GET";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.headers || {}),
  };
  if (!["GET", "HEAD", "OPTIONS"].includes(method))
    headers["x-csrf-token"] = decodeURIComponent(readCsrf() || "");
  const response = await fetch(`/api/v1${path}`, {
    credentials: "include",
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 204) return null as T;
  const payload = (await response.json().catch(() => null)) as
    T | ProblemDetails | null;
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("tlt:unauthorized"));
    throw new ApiError(response.status, payload as ProblemDetails | null);
  }
  return payload as T;
}

async function download(path: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/v1${path}`, { credentials: "include" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ProblemDetails | null;
    throw new ApiError(response.status, payload);
  }
  const disposition = response.headers.get("content-disposition") || "";
  const filename = disposition.match(/filename=([^;]+)/i)?.[1] || "export.csv";
  return { blob: await response.blob(), filename: filename.replaceAll('"', "") };
}

export const api = {
  login: (email: string, password: string) =>
    request<AuthContext>("/auth/login", {
      method: "POST",
      body: { email, password },
    }),
  registerTenant: (body: Record<string, unknown>) =>
    request<AuthContext>("/auth/register-tenant", {
      method: "POST",
      body,
    }),
  me: () => request<AuthContext>("/auth/me"),
  context: (tenant_id: string | null) =>
    request<AuthContext>("/auth/context", {
      method: "POST",
      body: { tenant_id },
    }),
  acceptInvitation: (token: string, password: string) =>
    request<AuthContext>("/auth/invitations/accept", {
      method: "POST",
      body: { token, password },
    }),
  changePassword: (current_password: string, new_password: string) =>
    request<null>("/auth/password", {
      method: "POST",
      body: { current_password, new_password },
    }),
  platformTenants: () => request<Array<Record<string, unknown>>>('/platform/tenants'),
  createPlatformTenant: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>('/platform/tenants', { method: 'POST', body }),
  updatePlatformTenant: (tenant_id: string, body: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/platform/tenants/${tenant_id}`, { method: 'PUT', body }),
  resendPlatformInvitation: (tenant_id: string, reason?: string) =>
    request<Record<string, unknown>>(`/platform/tenants/${tenant_id}/invitation/resend`, {
      method: 'POST',
      body: { reason },
    }),
  generatePlatformInvitationLink: (tenant_id: string) =>
    request<Record<string, unknown>>(`/platform/tenants/${tenant_id}/invitation/link`, {
      method: 'POST',
      body: {},
    }),
  platformAccess: () => request<Array<Record<string, unknown>>>('/platform/access'),
  platformAudit: () => request<Array<Record<string, unknown>>>('/platform/audit-events'),
  platformSettings: () => request<Array<Record<string, unknown>>>('/platform/settings'),
  updatePlatformSettings: (tenant_id: string, settings: Record<string, unknown>, reason?: string) =>
    request<Record<string, unknown>>('/platform/settings', {
      method: 'PUT',
      body: { tenant_id, settings, reason },
    }),
  teamDashboard: () => request<Record<string, unknown>>('/team/dashboard'),
  teamCalendar: (query: Record<string, string | number> = {}) => request<Array<Record<string, unknown>>>(`/team/calendar?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`),
  teamTimesheets: (query: Record<string, string | number> = {}) => request<PageResult<Record<string, unknown>>>(`/team/timesheets?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`),
  teamAlerts: () => request<Array<Record<string, unknown>>>('/team/alerts'),
  updatePlatformTenantStatus: (tenant_id: string, status: string, reason: string) =>
    request<Record<string, unknown>>(`/platform/tenants/${tenant_id}/status`, {
      method: 'PUT',
      body: { status, reason },
    }),
  createDirectoryEntry: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>("/hr/directory", { method: "POST", body }),
  updateDirectoryEntry: (employee_id: string, body: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/hr/directory/${employee_id}`, { method: "PUT", body }),
  resetDirectoryPassword: (employee_id: string) =>
    request<Record<string, unknown>>(`/hr/directory/${employee_id}/reset-password`, { method: "POST", body: {} }),
  generateDirectoryInvitationLink: (employee_id: string) =>
    request<Record<string, unknown>>(`/hr/directory/${employee_id}/invitation/link`, { method: "POST", body: {} }),
  createAttendanceOverride: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>("/hr/attendance-overrides", { method: "POST", body }),
  createLeaveOverride: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>("/hr/leave-overrides", { method: "POST", body }),
  myJobProfile: () => request<Record<string, unknown>>("/hr/my-job-profile"),
  myLeaveOptions: () => request<LeaveOption[]>("/hr/my-leave-options"),
  report: (preset: string, query: Record<string, string | number> = {}) =>
    request<Record<string, unknown>>(`/reports/${preset}?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`),
  downloadCsv: (path: string) => download(path),
  logout: () => request<null>("/auth/logout", { method: "POST" }),
  list: <K extends keyof EntityMap>(
    resource: K,
    query: Record<string, string | number> = {},
  ) =>
    request<EntityMap[K][]>(
      `/${resource}?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`,
    ),
  listPage: <K extends keyof EntityMap>(resource: K, query: Record<string, string | number> = {}) =>
    request<PageResult<EntityMap[K]>>(`/${resource}?${new URLSearchParams(Object.entries({ ...query, page: query.page || 1, page_size: query.page_size || 25 }).map(([key, value]) => [key, String(value)]))}`),
  create: <K extends keyof EntityMap>(
    resource: K,
    body: Omit<EntityMap[K], "tenant_id"> | Record<string, unknown>,
  ) => request<EntityMap[K]>(`/${resource}`, { method: "POST", body }),
  update: <K extends keyof EntityMap>(
    resource: K,
    id: string,
    body: Omit<EntityMap[K], "tenant_id"> | Record<string, unknown>,
    version?: number,
  ) =>
    request<EntityMap[K]>(`/${resource}/${id}`, {
      method: "PUT",
      headers: version === undefined ? {} : { "if-match": String(version) },
      body,
    }),
  transition: <T>(
    path: string,
    body: Record<string, unknown> = {},
    version?: number,
  ) =>
    request<T>(path, {
      method: "POST",
      headers: version === undefined ? {} : { "if-match": String(version) },
      body,
    }),
};
