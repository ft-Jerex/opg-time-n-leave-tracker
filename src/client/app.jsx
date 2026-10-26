import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Filter,
  LayoutDashboard,
  LogOut,
  Menu,
  Palmtree,
  RefreshCw,
  Save,
  ShieldCheck,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { api } from "./lib/api";
import { completedRecordedSeconds } from "./lib/attendance";
import { Button } from "./components/ui/button";
import {
  monthDateForTimeZone,
  monthGrid,
  weekdayLabels,
} from "./lib/calendar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import "./index.css";

const employeeResources = [
  "tenants",
  "employees",
  "attendance-sessions",
  "attendance-summaries",
  "attendance-adjustments",
  "leave-types",
  "leave-balances",
  "leave-ledger-entries",
  "leave-requests",
  "overtime-requests",
  "holidays",
  "alerts",
];
const administratorResources = [
  "users",
  "departments",
  "locations",
  "work-schedules",
  "job-profiles",
  "job-leave-policies",
  "attachments",
  "holiday-calendars",
  "audit-events",
];
const resourceNames = [...employeeResources, ...administratorResources];
const emptyData = { ...Object.fromEntries(resourceNames.map((name) => [name, []])), "job-profile": null };

const human = (value = "") =>
  value
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
const date = (value) =>
  value
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
        new Date(`${value.slice(0, 10)}T00:00:00`),
      )
    : "—";
const dateTime = (value) =>
  value
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
const formatDuration = (totalSeconds = 0) => {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
};
const sessionSeconds = (session, end = Date.now()) => {
  if (!session?.clock_in_at) return 0;
  const start = new Date(session.clock_in_at).getTime();
  const finish = session.clock_out_at
    ? new Date(session.clock_out_at).getTime()
    : end;
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.max(0, Math.floor((finish - start) / 1000));
};
const roleFor = (user) =>
  user?.roles?.includes("Platform Administrator")
    ? "Platform Administrator"
    : user?.roles?.includes("HR Manager")
      ? "HR Manager"
      : user?.roles?.includes("Reporting Manager")
        ? "Reporting Manager"
        : user?.capabilities?.length
          ? "Employee"
          : "Read only";
const initials = (name = "") =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
const chargeableDays = (from, to, holidays = []) => {
  if (!from || !to || to < from) return 0;
  const excluded = new Set(
    holidays
      .filter((item) => item.status === "active")
      .map((item) => item.local_date),
  );
  let total = 0;
  for (
    let cursor = new Date(`${from}T00:00:00Z`);
    cursor <= new Date(`${to}T00:00:00Z`);
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const day = cursor.getUTCDay();
    if (
      day !== 0 &&
      day !== 6 &&
      !excluded.has(cursor.toISOString().slice(0, 10))
    )
      total += 1;
  }
  return total;
};
const timeIntervalMinutes = (start, end) => {
  if (!/^\d{2}:\d{2}$/.test(start || "") || !/^\d{2}:\d{2}$/.test(end || "")) return 0;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return endHour * 60 + endMinute - (startHour * 60 + startMinute);
};

const routePageFromHash = () =>
  window.location.hash.split("/").pop()?.split("?")[0] || "dashboard";

const readViewState = (defaults) => {
  const query = window.location.hash.split("?")[1] || "";
  const params = new URLSearchParams(query);
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      params.has(key) ? params.get(key) : fallback,
    ]),
  );
};

const writeViewState = (state) => {
  const hash = window.location.hash || "#/app/dashboard";
  const path = hash.split("?")[0];
  const params = new URLSearchParams();
  Object.entries(state).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "")
      params.set(key, String(value));
  });
  const next = params.toString() ? `${path}?${params}` : path;
  window.history.replaceState(null, "", next);
};

function useDataViewState(viewKey, defaults) {
  const [state, setState] = useState(() => readViewState(defaults));
  useEffect(() => {
    writeViewState(state);
  }, [state, viewKey]);
  const update = useCallback((patch) => {
    setState((current) => ({
      ...current,
      ...(typeof patch === "function" ? patch(current) : patch),
    }));
  }, []);
  const reset = useCallback(() => setState(defaults), [defaults]);
  return [state, update, reset];
}

function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const submit = async (event) => {
    event.preventDefault();
    const nextErrors = {};
    const normalizedEmail = email.trim();
    if (!normalizedEmail) nextErrors.email = "Enter your email address.";
    else if (!/^\S+@\S+\.\S+$/.test(normalizedEmail))
      nextErrors.email = "Enter an email address in the format name@example.com.";
    if (!password) nextErrors.password = "Enter your password.";
    if (Object.keys(nextErrors).length) {
      setFieldErrors(nextErrors);
      setError("");
      window.setTimeout(() => {
        if (nextErrors.email) emailRef.current?.focus();
        else passwordRef.current?.focus();
      }, 0);
      return;
    }
    setBusy(true);
    setError("");
    setFieldErrors({});
    try {
      const account = await api.login(normalizedEmail, password);
      localStorage.setItem("tlt_has_session", "1");
      onLogin(account);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#fff8ed] p-5">
      <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-[#ffdd9c]/60 blur-3xl" />
      <div className="absolute -right-20 bottom-0 h-80 w-80 rounded-full bg-[#fb6c00]/15 blur-3xl" />
      <Card className="relative w-full max-w-md border-orange-200/70 shadow-2xl shadow-orange-950/10">
        <CardHeader className="space-y-5">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-primary font-bold text-white">
              TL
            </div>
            <div>
              <p className="text-sm font-semibold text-primary">
                OPG Workforce
              </p>
              <p className="text-xs text-muted-foreground">
                Secure employee portal
              </p>
            </div>
          </div>
          <div>
            <h1 className="text-3xl">Welcome back</h1>
            <CardDescription className="mt-2">
              Sign in to manage attendance, leave, and your work profile.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit} noValidate>
            <label className="block text-sm font-semibold" htmlFor="login-email">
              Email
              <input
                id="login-email"
                ref={emailRef}
                aria-label="Email"
                aria-invalid={Boolean(fieldErrors.email)}
                aria-describedby={fieldErrors.email ? "login-email-error" : undefined}
                autoComplete="email"
                type="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setFieldErrors((current) => ({ ...current, email: "" }));
                  setError("");
                }}
                className={`mt-2 h-11 w-full rounded-lg border bg-white px-3 outline-none focus:ring-2 ${fieldErrors.email ? "border-red-500 focus:ring-red-500" : "focus:ring-primary"}`}
              />
              {fieldErrors.email ? <p id="login-email-error" role="alert" className="mt-1 text-sm font-normal text-red-700">{fieldErrors.email}</p> : null}
            </label>
            <label className="block text-sm font-semibold" htmlFor="login-password">
              Password
              <input
                id="login-password"
                ref={passwordRef}
                aria-label="Password"
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={fieldErrors.password ? "login-password-error" : undefined}
                autoComplete="current-password"
                type="password"
                required
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setFieldErrors((current) => ({ ...current, password: "" }));
                  setError("");
                }}
                className={`mt-2 h-11 w-full rounded-lg border bg-white px-3 outline-none focus:ring-2 ${fieldErrors.password ? "border-red-500 focus:ring-red-500" : "focus:ring-primary"}`}
              />
              {fieldErrors.password ? <p id="login-password-error" role="alert" className="mt-1 text-sm font-normal text-red-700">{fieldErrors.password}</p> : null}
            </label>
            {error && (
              <div
                role="alert"
                className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </div>
            )}
            <Button disabled={busy} className="h-11 w-full">
              {busy ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" /> Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>
          <p className="mt-5 text-center text-xs text-muted-foreground">
            Use your organization account credentials.
          </p>
          <p className="mt-2 text-center text-sm">
            <a className="font-semibold text-primary underline" href="#/register">
              Register your organization
            </a>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

const registrationTenantSlug = (name) => {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug.length >= 2 ? slug : `org-${slug || "workspace"}`.slice(0, 48);
};

function TenantRegistration({ onLogin }) {
  const [form, setForm] = useState({ tenant_id: "", name: "", timezone: "Asia/Manila", locale: "en-PH", currency: "PHP", week_start: "1", support_email: "", adminName: "", adminEmail: "", password: "", confirmPassword: "" });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    const next = {};
    if (!form.name.trim()) next.name = "Enter your organization name.";
    if (!form.adminName.trim()) next.adminName = "Enter the initial HR administrator’s name.";
    if (!/^\S+@\S+\.\S+$/.test(form.adminEmail.trim())) next.adminEmail = "Enter a valid administrator email address.";
    if (form.password.length < 12) next.password = "Use at least 12 characters.";
    if (form.password !== form.confirmPassword) next.confirmPassword = "Passwords do not match.";
    if (Object.keys(next).length) { setErrors(next); setError(""); return; }
    setBusy(true); setErrors({}); setError("");
    try {
      const account = await api.registerTenant({ tenant_id: registrationTenantSlug(form.name), name: form.name.trim(), timezone: form.timezone, locale: form.locale, currency: form.currency, week_start: Number(form.week_start), support_email: form.support_email.trim() || undefined, admin: { display_name: form.adminName.trim(), email: form.adminEmail.trim(), password: form.password } });
      localStorage.setItem("tlt_has_session", "1");
      onLogin(account);
      window.location.hash = "/app/dashboard";
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#fff8ed] p-5"><Card className="relative w-full max-w-2xl border-orange-200/70 shadow-2xl shadow-orange-950/10"><CardHeader><div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-xl bg-primary font-bold text-white">TL</div><div><p className="text-sm font-semibold text-primary">OPG Workforce</p><p className="text-xs text-muted-foreground">Create your organization</p></div></div><div><h1 className="text-3xl">Register your organization</h1><CardDescription className="mt-2">Set up your organization and become its initial HR administrator.</CardDescription></div></CardHeader><CardContent><form className="space-y-4" onSubmit={submit} noValidate><div className="grid gap-3 sm:grid-cols-2"><Field label="Organization name" required value={form.name} error={errors.name} onChange={(value) => update("name", value)} /><Field label="Organization ID" required value={form.tenant_id} error={errors.tenant_id} helperText="Use 2–48 lowercase letters, numbers, or hyphens." onChange={(value) => update("tenant_id", value.toLowerCase())} /></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Timezone" required value={form.timezone} onChange={(value) => update("timezone", value)} /><Field label="Locale" required value={form.locale} onChange={(value) => update("locale", value)} /></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Currency" required value={form.currency} onChange={(value) => update("currency", value.toUpperCase())} /><label className="text-sm font-semibold">Week starts<select aria-label="Week starts" value={form.week_start} onChange={(event) => update("week_start", event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-white px-3"><option value="0">Sunday</option><option value="1">Monday</option><option value="6">Saturday</option></select></label></div><Field label="Support email (optional)" type="email" value={form.support_email} onChange={(value) => update("support_email", value)} /><div className="space-y-3 rounded-xl border bg-muted/30 p-4"><p className="font-semibold">Initial HR administrator</p><div className="grid gap-3 sm:grid-cols-2"><Field label="Full name" required value={form.adminName} error={errors.adminName} onChange={(value) => update("adminName", value)} /><Field label="Email" type="email" required value={form.adminEmail} error={errors.adminEmail} onChange={(value) => update("adminEmail", value)} /></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Password" type="password" required minLength="12" autoComplete="new-password" value={form.password} error={errors.password} helperText="Use at least 12 characters." onChange={(value) => update("password", value)} /><Field label="Confirm password" type="password" required minLength="12" autoComplete="new-password" value={form.confirmPassword} error={errors.confirmPassword} onChange={(value) => update("confirmPassword", value)} /></div><p className="text-xs text-muted-foreground">Your account is activated immediately with HR Manager access.</p></div>{error ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}<Button className="w-full" disabled={busy}>{busy ? "Creating organization…" : "Create organization"}</Button></form><p className="mt-5 text-center text-sm text-muted-foreground">Already have an account? <a className="font-semibold text-primary underline" href="#/login">Sign in</a></p></CardContent></Card></main>;
}

function Loading() {
  return (
    <section
      aria-labelledby="workspace-loading"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      <h1 id="workspace-loading" className="sr-only">
        Loading workspace
      </h1>
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="h-32 animate-pulse rounded-xl border bg-white/60"
        />
      ))}
    </section>
  );
}
function ErrorState({ message, retry }) {
  return (
    <Card className="border-red-200 bg-red-50">
      <CardContent className="flex flex-col items-start gap-3 pt-6 sm:flex-row sm:items-center">
        <AlertCircle className="h-5 w-5 text-red-700" />
        <div className="flex-1">
          <h1 className="font-bold text-red-900">
            We couldn’t load this workspace
          </h1>
          <p className="text-sm text-red-800">{message}</p>
        </div>
        <Button variant="outline" onClick={retry}>
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}
function Empty({ title, detail }) {
  return (
    <div className="rounded-xl border border-dashed bg-white/60 px-6 py-12 text-center">
      <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-emerald-600" />
      <p className="font-bold">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}
function Status({ value }) {
  const tone =
    value === "approved" ||
    value === "complete" ||
    value === "closed" ||
    value === "resolved"
      ? "bg-emerald-100 text-emerald-800"
      : value === "rejected" || value === "critical"
        ? "bg-red-100 text-red-800"
        : "bg-amber-100 text-amber-900";
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${tone}`}
    >
      {human(value)}
    </span>
  );
}
function Modal({ title, close, children }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const returnFocusRef = useRef(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex=\"-1\"])";
    const firstField = dialog.querySelector("form input:not([disabled]), form select:not([disabled]), form textarea:not([disabled])");
    (firstField || dialog.querySelector(focusableSelector))?.focus();
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll(focusableSelector)].filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", handleKeyDown);
    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      if (returnFocusRef.current instanceof HTMLElement) returnFocusRef.current.focus();
    };
  }, []);
  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <Card className="max-h-[90vh] w-full max-w-lg overflow-auto shadow-2xl">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle id={titleId}>{title}</CardTitle>
          <Button
            aria-label="Close dialog"
            variant="ghost"
            size="icon"
            onClick={close}
          >
            <X className="h-5 w-5" />
          </Button>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

function Dashboard({
  data,
  employee,
  onNavigate,
  onClock,
  busy,
  canClock,
  tenant,
}) {
  const open = data["attendance-sessions"].find(
    (item) =>
      item.status === "open" && item.employee_id === employee?.employee_id,
  );
  const summaries = data["attendance-summaries"].filter(
    (item) => item.employee_id === employee?.employee_id,
  );
  const balances = data["leave-balances"].filter(
    (item) => item.employee_id === employee?.employee_id,
  );
  const requests = data["leave-requests"].filter(
    (item) => item.employee_id === employee?.employee_id,
  );
  const recentSummaries = [...summaries].sort((left, right) =>
    right.local_date.localeCompare(left.local_date),
  );
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open?.session_id]);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tenant?.timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replaceAll("/", "-");
  const elapsedSeconds = open ? sessionSeconds(open, tick) : 0;
  const todayMinutes =
    summaries.find((item) => item.local_date === today)?.worked_mins || 0;
  const todayClosedSessionSeconds = data["attendance-sessions"]
    .filter(
      (item) =>
        item.employee_id === employee?.employee_id &&
        item.status === "closed" &&
        Boolean(item.clock_out_at) &&
        new Intl.DateTimeFormat("en-CA", {
          timeZone: tenant?.timezone || "UTC",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .format(new Date(item.clock_in_at))
          .replaceAll("/", "-") === today,
    )
    .reduce((sum, item) => sum + sessionSeconds(item), 0);
  const todaySeconds =
    Math.max(todayMinutes * 60, todayClosedSessionSeconds) + elapsedSeconds;
  const jobProfile = data["job-profile"];
  const dailyLimitMins =
    jobProfile && !jobProfile.is_ot_eligible && jobProfile.max_daily_mins !== null
      ? Number(jobProfile.max_daily_mins)
      : null;
  const recordedSeconds = completedRecordedSeconds({
    summaryMinutes: todayMinutes,
    closedSessionSeconds: todayClosedSessionSeconds,
    isOvertimeEligible: Boolean(jobProfile?.is_ot_eligible),
    maxDailyMins: jobProfile?.max_daily_mins,
  });
  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-gradient-to-br from-[#3b160d] to-[#8c2414] p-6 text-white shadow-xl sm:p-8">
        <p className="text-sm font-bold uppercase tracking-[.18em] text-orange-200">
          Today’s workspace
        </p>
        <div className="mt-3 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-3xl sm:text-4xl">Make your time count.</h1>
            <p className="mt-2 max-w-xl text-orange-50/80">
              Clock your work, review exceptions, and keep leave plans moving.
            </p>
            <div
              className="mt-4 flex flex-wrap items-center gap-3"
              aria-live="polite"
            >
              <div
                className="rounded-xl border border-white/20 bg-black/15 px-4 py-2"
                aria-label={`Live work timer ${formatDuration(elapsedSeconds)}`}
              >
                <p className="text-[10px] font-bold uppercase tracking-[.16em] text-orange-200">
                  Live timer
                </p>
                <p className="font-mono text-2xl font-extrabold tracking-tight">
                  {formatDuration(elapsedSeconds)}
                </p>
              </div>
              <p className="text-sm font-semibold text-orange-100">
              Today: {formatDuration(todaySeconds)}
              {open
                ? ` · active since ${new Intl.DateTimeFormat("en", { timeStyle: "short", timeZone: tenant?.timezone || "UTC" }).format(new Date(open.clock_in_at))}`
                : " · currently clocked out"}
              {dailyLimitMins !== null
                ? ` · daily limit ${formatDuration(dailyLimitMins * 60)}`
                : ""}
              </p>
            </div>
          </div>
          {canClock && (
            <Button
              disabled={busy}
              onClick={onClock}
              className="h-12 bg-white text-[#6d1e12] hover:bg-orange-50"
            >
              {busy ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Clock3 className="h-4 w-4" />
              )}
              {open
                ? `Clock out · ${formatDuration(elapsedSeconds)}`
                : "Clock in"}
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          [formatDuration(recordedSeconds), "Recorded hours"],
          [
            balances.reduce((sum, b) => sum + b.remaining, 0),
            "Leave remaining",
          ],
          [
            requests.filter((r) => r.status === "pending").length,
            "Pending requests",
          ],
          [
            summaries.filter(
              (s) => !["complete", "leave", "holiday"].includes(s.status),
            ).length,
            "Attendance exceptions",
          ],
        ].map(([value, label]) => (
          <Card key={label}>
            <CardContent className="pt-6">
              <p className="text-3xl font-extrabold">{value}</p>
              <p className="mt-1 text-sm text-muted-foreground">{label}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Recent attendance</CardTitle>
          <CardDescription>Your latest recorded workdays.</CardDescription>
        </CardHeader>
        <CardContent>
          {summaries.length ? (
            <div className="divide-y">
              {recentSummaries.slice(0, 5).map((item) => (
                <button
                  onClick={() => onNavigate("attendance")}
                  className="flex w-full items-center justify-between gap-3 py-3 text-left hover:text-primary"
                  key={item.summary_id}
                >
                  <span>
                    <b>{date(item.local_date)}</b>
                    <small className="block text-muted-foreground">
                      {item.worked_mins} minutes worked
                    </small>
                  </span>
                  <Status value={item.status} />
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title="No attendance yet"
              detail="Clock in to begin your attendance history."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Attendance({ data, employee, refresh, notify, canWrite, canRequestOvertime, tenant }) {
  const [modal, setModal] = useState(false);
  const [view, setView] = useState("calendar");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [monthOffset, setMonthOffset] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [busy, setBusy] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const formRef = useRef(null);
  const [form, setForm] = useState({
    local_date: new Date().toISOString().slice(0, 10),
    start: "09:00",
    end: "17:00",
    reason: "",
  });
  const updateForm = (patch) => {
    setForm((current) => ({ ...current, ...patch }));
    setFormErrors((current) => {
      const next = { ...current };
      Object.keys(patch).forEach((key) => delete next[key]);
      delete next.form;
      return next;
    });
  };
  const validateForm = () => {
    const next = {};
    if (!form.local_date) next.local_date = "Choose the date to correct.";
    if (!form.start) next.start = "Enter a clock-in time.";
    if (!form.end) next.end = "Enter a clock-out time.";
    if (form.start && form.end && form.end <= form.start) {
      next.end = "Clock-out time must be later than clock-in time.";
    }
    if (!form.reason.trim()) next.reason = "Explain what needs correcting.";
    return next;
  };
  const submit = async (event) => {
    event.preventDefault();
    const nextErrors = validateForm();
    if (Object.keys(nextErrors).length) {
      setFormErrors(nextErrors);
      window.setTimeout(() => {
        formRef.current?.querySelector("[aria-invalid=\"true\"]")?.focus();
      }, 0);
      return;
    }
    setBusy(true);
    try {
      const row = await api.create("attendance-adjustments", {
        employee_id: employee.employee_id,
        local_date: form.local_date,
        original: {},
        proposed: { clock_in: form.start, clock_out: form.end },
        reason: form.reason,
        attachment_ids: [],
        status: "draft",
        submitted_at: new Date().toISOString(),
        decided_by: null,
        decided_at: null,
        decision_note: null,
        version: 0,
      });
      await api.transition(
        `/attendance-adjustments/${row.adjustment_id}/submit`,
        {},
        row.version,
      );
      notify("Attendance adjustment submitted.");
      setModal(false);
      await refresh();
    } catch (e) {
      if (e.status === 409) await refresh();
      setFormErrors({ form: e.message });
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async (item) => {
    if (!window.confirm("Withdraw this pending attendance correction?")) return;
    try {
      await api.transition(
        `/attendance-adjustments/${item.adjustment_id}/withdraw`,
        {},
        item.version,
      );
      notify("Attendance correction withdrawn.");
      await refresh();
    } catch (error) {
      notify(error.message, "error");
    }
  };
  const summaries = data["attendance-summaries"]
    .filter((item) => item.employee_id === employee?.employee_id)
    .filter((item) => statusFilter === "all" || item.status === statusFilter)
    .filter((item) => `${item.local_date} ${item.status} ${item.exception_codes?.join(" ") || ""}`.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => right.local_date.localeCompare(left.local_date));
  const personalAdjustments = data["attendance-adjustments"].filter(
    (item) => item.employee_id === employee?.employee_id,
  );
  const pageCount = Math.max(1, Math.ceil(summaries.length / pageSize));
  const visibleSummaries = summaries.slice((page - 1) * pageSize, page * pageSize);
  const calendarDate = monthDateForTimeZone(tenant?.timezone, monthOffset);
  const calendarKey = `${calendarDate.getFullYear()}-${String(calendarDate.getMonth() + 1).padStart(2, "0")}`;
  const { daysInMonth, leadingDays } = monthGrid(
    calendarDate.getFullYear(),
    calendarDate.getMonth(),
    tenant?.week_start,
  );
  const calendarWeekdays = weekdayLabels(tenant?.week_start);
  const monthLabel = calendarDate.toLocaleDateString("en", { month: "long", year: "numeric" });
  const resetFilters = () => { setQuery(""); setStatusFilter("all"); setPage(1); };
  return (
    <div className="space-y-5">
      <Header
        title="Attendance"
        detail="Review recorded sessions, daily summaries, and correction requests."
        action={canWrite ? <Button onClick={() => setModal(true)}>Request correction</Button> : null}
      />
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <Field label="Search attendance" value={query} onChange={(value) => { setQuery(value); setPage(1); }} />
            <label className="text-sm font-semibold">Status<select aria-label="Attendance status filter" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} className="mt-2 h-11 rounded-lg border bg-white px-3"><option value="all">All statuses</option>{["complete","below_standard","missing_punch","absent","leave","holiday"].map((value) => <option key={value} value={value}>{human(value)}</option>)}</select></label>
            <div className="flex gap-2"><Button variant={view === "calendar" ? "secondary" : "outline"} onClick={() => setView("calendar")}>Month</Button><Button variant={view === "table" ? "secondary" : "outline"} onClick={() => setView("table")}>Table</Button><Button variant="ghost" onClick={resetFilters}>Clear filters</Button></div>
          </div>
          {view === "calendar" ? <div className="space-y-3"><div className="flex items-center justify-between"><Button variant="outline" size="sm" onClick={() => setMonthOffset((value) => value - 1)}>Previous month</Button><b>{monthLabel}</b><Button variant="outline" size="sm" onClick={() => setMonthOffset((value) => value + 1)}>Next month</Button></div><div className="grid grid-cols-7 gap-1" aria-label={`${monthLabel} attendance calendar`}>{calendarWeekdays.map((day) => <div className="p-2 text-center text-xs font-semibold text-muted-foreground" key={day}>{day}</div>)}{Array.from({ length: leadingDays }, (_, index) => <div aria-hidden="true" key={`blank-${index}`} />)}{Array.from({ length: daysInMonth }, (_, index) => { const localDate = `${calendarKey}-${String(index + 1).padStart(2, "0")}`; const row = data["attendance-summaries"].find((item) => item.employee_id === employee?.employee_id && item.local_date === localDate); return <div key={localDate} className={`min-h-16 rounded-md border p-2 text-xs ${row && row.status !== "complete" ? "border-red-300 bg-red-50 text-red-800" : row ? "bg-emerald-50 text-emerald-800" : "bg-white"}`}><b>{index + 1}</b><span className="mt-1 block">{row ? `${row.worked_mins}m · ${human(row.status)}` : "No record"}</span></div>; })}</div></div> : <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead><tr className="border-b">{["Date","Worked","Scheduled","Overtime","Status"].map((label) => <th className="p-3" key={label}>{label}</th>)}</tr></thead><tbody>{visibleSummaries.map((item) => <tr className="border-b" key={item.summary_id}><td className="p-3">{date(item.local_date)}</td><td className="p-3">{item.worked_mins} min</td><td className="p-3">{item.scheduled_mins} min</td><td className="p-3">{item.overtime_mins} min</td><td className="p-3"><Status value={item.status} /></td></tr>)}</tbody></table>{!visibleSummaries.length && <Empty title="No attendance matches" detail="Clear the search or status filter." />}<Pagination page={page} pageCount={pageCount} pageSize={pageSize} total={summaries.length} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} /></div>}
        </CardContent>
      </Card>
      {canRequestOvertime ? <OvertimeRequest data={data} employee={employee} refresh={refresh} notify={notify} /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Daily summaries</CardTitle>
          </CardHeader>
          <CardContent>
            {summaries.length ? (
              <div className="divide-y">
                {summaries.map((item) => (
                  <div
                    className="flex justify-between gap-3 py-3"
                    key={item.summary_id}
                  >
                    <span>
                      <b>{date(item.local_date)}</b>
                      <small className="block text-muted-foreground">
                        {item.worked_mins} of {item.scheduled_mins} minutes
                      </small>
                    </span>
                    <Status value={item.status} />
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                title="No summaries"
                detail="Daily summaries appear after attendance is processed."
              />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Correction requests</CardTitle>
          </CardHeader>
          <CardContent>
            {personalAdjustments.length ? (
              <div className="divide-y">
                {personalAdjustments.map((item) => (
                  <div
                    className="flex justify-between gap-3 py-3"
                    key={item.adjustment_id}
                  >
                    <span>
                      <b>{date(item.local_date)}</b>
                      <small className="block text-muted-foreground">
                        {item.reason}
                      </small>
                    </span>
                    <div className="flex items-center gap-2">
                      <Status value={item.status} />
                      {canWrite && item.status === "pending" && (
                        <Button
                          variant="outline"
                          onClick={() => withdraw(item)}
                        >
                          Withdraw
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                title="No correction requests"
                detail="Your submitted adjustments will appear here."
              />
            )}
          </CardContent>
        </Card>
      </div>
      {modal && (
        <Modal
          title="Request attendance correction"
          close={() => setModal(false)}
        >
          <form ref={formRef} onSubmit={submit} className="space-y-4" noValidate>
            <Field
              label="Date"
              type="date"
              value={form.local_date}
              required
              error={formErrors.local_date}
              onChange={(v) => updateForm({ local_date: v })}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Clock in"
                type="time"
                value={form.start}
                required
                error={formErrors.start}
                onChange={(v) => updateForm({ start: v })}
              />
              <Field
                label="Clock out"
                type="time"
                value={form.end}
                required
                error={formErrors.end}
                onChange={(v) => updateForm({ end: v })}
              />
            </div>
            <Field
              label="Reason"
              value={form.reason}
              required
              error={formErrors.reason}
              helperText="Explain what needs correcting and, if relevant, what caused the mismatch."
              onChange={(v) => updateForm({ reason: v })}
            />
            {formErrors.form ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{formErrors.form}</p> : null}
            <Button disabled={busy} className="w-full">
              {busy ? "Submitting…" : "Submit for approval"}
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function OvertimeRequest({ data, employee, refresh, notify }) {
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    local_date: new Date().toISOString().slice(0, 10),
    start_time: "18:00",
    end_time: "20:00",
    reason: "",
  });
  const requests = data["overtime-requests"].filter((item) => item.employee_id === employee?.employee_id).sort((left, right) => right.local_date.localeCompare(left.local_date));
  const minutes = timeIntervalMinutes(form.start_time, form.end_time);
  const submit = async (event) => {
    event.preventDefault();
    if (minutes <= 0) {
      notify("End time must be after start time.", "error");
      return;
    }
    setBusy(true);
    try {
      const row = await api.create("overtime-requests", {
        employee_id: employee.employee_id,
        local_date: form.local_date,
        start_time: form.start_time,
        end_time: form.end_time,
        requested_mins: minutes,
        reason: form.reason,
        status: "draft",
        approver_id: null,
        submitted_at: null,
        decided_at: null,
        decision_note: null,
        version: 0,
        created_at: new Date().toISOString(),
      });
      await api.transition(`/overtime-requests/${row.overtime_request_id}/submit`, {}, row.version);
      notify("Overtime request submitted for approval.");
      setModal(false);
      setForm({ ...form, reason: "" });
      await refresh();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async (item) => {
    if (!window.confirm("Withdraw this pending overtime request?")) return;
    try {
      await api.transition(`/overtime-requests/${item.overtime_request_id}/withdraw`, {}, item.version);
      notify("Overtime request withdrawn.");
      await refresh();
    } catch (error) {
      notify(error.message, "error");
    }
  };
  return <>
    <Button onClick={() => setModal(true)}>Request overtime</Button>
    {modal ? <Modal title="Request overtime" close={() => setModal(false)}><form onSubmit={submit} className="space-y-4"><Field label="Date" type="date" required value={form.local_date} onChange={(value) => setForm({ ...form, local_date: value })} /><div className="grid gap-3 sm:grid-cols-2"><Field label="Start time" type="time" required value={form.start_time} onChange={(value) => setForm({ ...form, start_time: value })} /><Field label="End time" type="time" required value={form.end_time} onChange={(value) => setForm({ ...form, end_time: value })} /></div><Field label="Reason" required value={form.reason} onChange={(value) => setForm({ ...form, reason: value })} /><div className="rounded-lg bg-muted p-4 text-sm">Requested overtime: <b>{Math.max(0, minutes)} minutes</b><p className="mt-1 text-muted-foreground">Your reporting manager is the normal approver. HR can approve organization-wide requests.</p></div><Button className="w-full" disabled={busy || minutes <= 0}>{busy ? "Submitting…" : "Submit for approval"}</Button></form></Modal> : null}
    {requests.length ? <Card className="mt-5"><CardHeader><CardTitle>Overtime requests</CardTitle></CardHeader><CardContent className="divide-y">{requests.map((item) => <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" key={item.overtime_request_id}><div><b>{date(item.local_date)} · {item.start_time.slice(0, 5)}–{item.end_time.slice(0, 5)}</b><small className="block text-muted-foreground">{item.requested_mins} minutes · {item.reason}</small></div><div className="flex items-center gap-2"><Status value={item.status} />{item.status === "pending" ? <Button variant="outline" size="sm" onClick={() => withdraw(item)}>Withdraw</Button> : null}</div></div>)}</CardContent></Card> : null}
  </>;
}

function Leave({ data, employee, refresh, notify, canWrite }) {
  // HR can load tenant-wide data for team and organization workspaces, but
  // this page is the signed-in employee's personal leave workspace.
  const personalBalances = data["leave-balances"].filter(
    (item) => item.employee_id === employee.employee_id,
  );
  const personalLedgerEntries = data["leave-ledger-entries"].filter(
    (item) => item.employee_id === employee.employee_id,
  );
  const personalRequests = data["leave-requests"].filter(
    (item) => item.employee_id === employee.employee_id,
  );
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const formRef = useRef(null);
  const eligibleTypeIds = new Set(
    personalBalances.map((item) => item.leave_type_id),
  );
  const types = data["leave-types"].filter(
    (item) =>
      item.status === "active" && eligibleTypeIds.has(item.leave_type_id),
  );
  const [form, setForm] = useState({
    leave_type_id: "",
    start_date: "",
    end_date: "",
    partial_day: "none",
    partial_start_time: "07:00",
    partial_end_time: "10:00",
    reason: "",
  });
  const updateForm = (patch) => {
    setForm((current) => ({ ...current, ...patch }));
    setFormErrors((current) => {
      const next = { ...current };
      Object.keys(patch).forEach((key) => delete next[key]);
      if ("start_date" in patch || "end_date" in patch) {
        delete next.dateRange;
      }
      if ("partial_start_time" in patch || "partial_end_time" in patch) {
        delete next.partial_end_time;
      }
      delete next.form;
      return next;
    });
  };
  const validateForm = () => {
    const next = {};
    if (!form.leave_type_id) next.leave_type_id = "Choose a leave type.";
    if (!form.start_date) next.start_date = "Choose a start date.";
    if (!form.end_date) next.end_date = "Choose an end date.";
    if (form.start_date && form.end_date && form.end_date < form.start_date) {
      next.end_date = "The To date must be on or after the From date.";
    } else if (form.partial_day === "custom_hours" && form.start_date && form.end_date && form.start_date !== form.end_date) {
      next.end_date = "Custom-hour leave must use the same date for From and To.";
    } else if (form.partial_day === "custom_hours" && customMinutes <= 0) {
      next.partial_end_time = "End time must be later than start time.";
    } else if (form.start_date && form.end_date && form.partial_day !== "custom_hours" && projectedDays <= 0) {
      next.dateRange = "Choose at least one working day; weekends and holidays are not chargeable."
    }
    if (!form.reason.trim()) next.reason = "Explain why you need this leave.";
    return next;
  };
  useEffect(() => {
    if (types[0] && !form.leave_type_id)
      setForm((value) => ({ ...value, leave_type_id: types[0].leave_type_id }));
  }, [types, form.leave_type_id]);
  const submit = async (event) => {
    event.preventDefault();
    const nextErrors = validateForm();
    if (Object.keys(nextErrors).length) {
      setFormErrors(nextErrors);
      window.setTimeout(() => {
        formRef.current?.querySelector("[aria-invalid=\"true\"]")?.focus();
      }, 0);
      return;
    }
    setBusy(true);
    try {
      const row = await api.create("leave-requests", {
        employee_id: employee.employee_id,
        leave_type_id: form.leave_type_id,
        start_date: form.start_date,
        end_date: form.end_date,
        partial_day: form.partial_day,
        partial_start_time: form.partial_day === "custom_hours" ? form.partial_start_time : null,
        partial_end_time: form.partial_day === "custom_hours" ? form.partial_end_time : null,
        partial_minutes: form.partial_day === "custom_hours" ? timeIntervalMinutes(form.partial_start_time, form.partial_end_time) : null,
        chargeable_amount: projectedDays,
        reason: form.reason,
        attachment_ids: [],
        status: "draft",
        approver_id: null,
        submitted_at: null,
        decided_at: null,
        decision_note: null,
        version: 0,
      });
      await api.transition(
        `/leave-requests/${row.request_id}/submit`,
        {},
        row.version,
      );
      notify("Leave request submitted.");
      setModal(false);
      await refresh();
    } catch (e) {
      setFormErrors({ form: e.message });
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const typeName = (id) =>
    types.find((type) => type.leave_type_id === id)?.name || "Leave";
  const selectedType = types.find((type) => type.leave_type_id === form.leave_type_id);
  const selectedJob = data["job-profile"];
  const customMinutes = timeIntervalMinutes(form.partial_start_time, form.partial_end_time);
  const projectedDays = Math.max(
    0,
    form.partial_day === "custom_hours"
      ? form.start_date === form.end_date && customMinutes > 0
        ? selectedType?.unit === "hours"
          ? customMinutes / 60
          : customMinutes / Number(selectedJob?.standard_daily_mins || 480)
        : 0
      : chargeableDays(form.start_date, form.end_date, data.holidays) -
        (form.partial_day === "none" ? 0 : 0.5),
  );
  const selectedBalance = personalBalances.find(
    (item) => item.leave_type_id === form.leave_type_id,
  );
  const [busyRequestId, setBusyRequestId] = useState("");
  const transitionRequest = async (item, action, confirmation, successMessage) => {
    if (!window.confirm(confirmation)) return;
    setBusyRequestId(item.request_id);
    try {
      await api.transition(
        `/leave-requests/${item.request_id}/${action}`,
        {},
        item.version,
      );
      notify(successMessage);
      await refresh();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusyRequestId("");
    }
  };
  const withdraw = (item) =>
    transitionRequest(
      item,
      "withdraw",
      "Withdraw this pending leave request?",
      "Leave request withdrawn.",
    );
  const cancel = (item) =>
    transitionRequest(
      item,
      "cancel",
      "Cancel this approved leave request? The charged leave will be returned to your balance.",
      "Approved leave cancelled and balance restored.",
    );
  const [view, setView] = useState("calendar");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [monthOffset, setMonthOffset] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const leaveRows = personalRequests
    .filter((item) => statusFilter === "all" || item.status === statusFilter)
    .filter((item) => `${typeName(item.leave_type_id)} ${item.reason} ${item.start_date} ${item.end_date}`.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => right.start_date.localeCompare(left.start_date));
  const leavePageCount = Math.max(1, Math.ceil(leaveRows.length / pageSize));
  const visibleLeaveRows = leaveRows.slice((page - 1) * pageSize, page * pageSize);
  const leaveCalendarDate = new Date();
  leaveCalendarDate.setMonth(leaveCalendarDate.getMonth() + monthOffset, 1);
  const leaveCalendarKey = `${leaveCalendarDate.getFullYear()}-${String(leaveCalendarDate.getMonth() + 1).padStart(2, "0")}`;
  const leaveDays = new Date(leaveCalendarDate.getFullYear(), leaveCalendarDate.getMonth() + 1, 0).getDate();
  return (
    <div className="space-y-5">
      <Header
        title="Leave"
        detail="View balances and submit time-away requests."
        action={
          canWrite ? (
            <Button onClick={() => { setFormErrors({}); setModal(true); }}>Request leave</Button>
          ) : null
        }
      />
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end"><Field label="Search leave" value={query} onChange={(value) => { setQuery(value); setPage(1); }} /><label className="text-sm font-semibold">Status<select aria-label="Leave status filter" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} className="mt-2 h-11 rounded-lg border bg-white px-3"><option value="all">All statuses</option>{["pending","approved","rejected","withdrawn","cancelled"].map((value) => <option key={value} value={value}>{human(value)}</option>)}</select></label><div className="flex gap-2"><Button variant={view === "calendar" ? "secondary" : "outline"} onClick={() => setView("calendar")}>Month</Button><Button variant={view === "table" ? "secondary" : "outline"} onClick={() => setView("table")}>List</Button><Button variant="ghost" onClick={() => { setQuery(""); setStatusFilter("all"); setPage(1); }}>Clear filters</Button></div></div>
          {view === "calendar" ? <div className="space-y-3"><div className="flex items-center justify-between"><Button variant="outline" size="sm" onClick={() => setMonthOffset((value) => value - 1)}>Previous month</Button><b>{leaveCalendarDate.toLocaleDateString("en", { month: "long", year: "numeric" })}</b><Button variant="outline" size="sm" onClick={() => setMonthOffset((value) => value + 1)}>Next month</Button></div><div className="grid grid-cols-7 gap-1" aria-label="Leave calendar">{["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((day) => <div className="p-2 text-center text-xs font-semibold text-muted-foreground" key={day}>{day}</div>)}{Array.from({ length: leaveDays }, (_, index) => { const localDate = `${leaveCalendarKey}-${String(index + 1).padStart(2, "0")}`; const matches = leaveRows.filter((item) => item.start_date <= localDate && item.end_date >= localDate); return <div key={localDate} className={`min-h-16 rounded-md border p-2 text-xs ${matches.some((item) => item.status === "approved") ? "bg-emerald-50 text-emerald-800" : matches.length ? "bg-amber-50 text-amber-800" : "bg-white"}`}><b>{index + 1}</b><span className="mt-1 block">{matches.length ? `${matches.length} request(s)` : "Available"}</span></div>; })}</div></div> : <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr className="border-b">{["Leave type","Dates","Charge","Reason","Status"].map((label) => <th className="p-3" key={label}>{label}</th>)}</tr></thead><tbody>{visibleLeaveRows.map((item) => <tr className="border-b" key={item.request_id}><td className="p-3">{typeName(item.leave_type_id)}</td><td className="p-3">{date(item.start_date)} – {date(item.end_date)}</td><td className="p-3">{item.chargeable_amount}</td><td className="max-w-xs truncate p-3">{item.reason}</td><td className="p-3"><Status value={item.status} /></td></tr>)}</tbody></table>{!visibleLeaveRows.length && <Empty title="No leave matches" detail="Clear the search or status filter." />}<Pagination page={page} pageCount={leavePageCount} pageSize={pageSize} total={leaveRows.length} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} /></div>}
        </CardContent>
      </Card>
      {personalBalances.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {personalBalances.map((item) => (
            <Card key={item.balance_id}>
              <CardContent className="pt-6">
                <p className="text-sm font-bold text-primary">
                  {typeName(item.leave_type_id)}
                </p>
                <p className="mt-1 text-3xl font-extrabold">
                  {item.remaining}{" "}
                  <span className="text-base font-medium">{item.unit}</span>
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {item.pending} pending · {item.used} used
                </p>
                <details className="mt-4 text-sm">
                  <summary className="cursor-pointer font-semibold text-primary">
                    Balance details and ledger
                  </summary>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Row label="Accrued" value={item.accrued} />
                    <Row label="Carried over" value={item.carried_over} />
                    <Row label="Manual" value={item.manual_adjustments} />
                    <Row label="As of" value={date(item.as_of)} />
                  </div>
                  <div className="mt-3 divide-y">
                    {personalLedgerEntries
                      .filter(
                        (entry) =>
                          entry.employee_id === item.employee_id &&
                          entry.leave_type_id === item.leave_type_id,
                      )
                      .map((entry) => (
                        <div key={entry.entry_id} className="py-2">
                          <b>
                            {human(entry.entry_type)} · {entry.amount}
                          </b>
                          <p className="text-xs text-muted-foreground">
                            {date(entry.effective_date)} · {entry.reason}
                          </p>
                        </div>
                      ))}
                  </div>
                </details>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Empty
          title="No eligible leave balances"
          detail="Your active job has no assigned leave policies."
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>Request history</CardTitle>
        </CardHeader>
        <CardContent>
          {personalRequests.length ? (
            <div className="divide-y">
              {visibleLeaveRows.map((item) => (
                <div
                  className="flex flex-col justify-between gap-2 py-4 sm:flex-row sm:items-center"
                  key={item.request_id}
                >
                  <span>
                    <b>{typeName(item.leave_type_id)}</b>
                    <small className="block text-muted-foreground">
                      {date(item.start_date)} – {date(item.end_date)} ·{" "}
                      {item.partial_day === "custom_hours" ? `${item.partial_start_time?.slice(0, 5)}–${item.partial_end_time?.slice(0, 5)} · ` : ""}
                      {item.chargeable_amount} unit(s) · {item.reason}
                    </small>
                  </span>
                  <div className="flex items-center gap-2">
                    <Status value={item.status} />
                    {canWrite && item.status === "pending" && (
                      <Button
                        variant="outline"
                        disabled={Boolean(busyRequestId)}
                        onClick={() => withdraw(item)}
                      >
                        {busyRequestId === item.request_id ? "Withdrawing…" : "Withdraw"}
                      </Button>
                    )}
                    {canWrite && item.status === "approved" && (
                      <Button
                        variant="outline"
                        disabled={Boolean(busyRequestId)}
                        onClick={() => cancel(item)}
                      >
                        {busyRequestId === item.request_id ? "Cancelling…" : "Cancel leave"}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="No leave requests"
              detail="Use Request leave to plan time away."
            />
          )}
        </CardContent>
      </Card>
      {modal && (
        <Modal title="Request leave" close={() => setModal(false)}>
          <form ref={formRef} onSubmit={submit} className="space-y-4" noValidate>
            <label className="block text-sm font-semibold">
              Leave type<span aria-hidden="true" className="ml-1 text-red-700">*</span>
              <select
                id="leave-type"
                aria-label="Leave type"
                aria-invalid={Boolean(formErrors.leave_type_id)}
                aria-describedby={formErrors.leave_type_id ? "leave-type-error" : undefined}
                required
                value={form.leave_type_id}
                onChange={(e) =>
                  updateForm({ leave_type_id: e.target.value })
                }
                className={`mt-2 h-11 w-full rounded-lg border bg-white px-3 ${formErrors.leave_type_id ? "border-red-500" : ""}`}
              >
                {types.map((type) => (
                  <option key={type.leave_type_id} value={type.leave_type_id}>
                    {type.name}
                  </option>
                ))}
              </select>
              {formErrors.leave_type_id ? <p id="leave-type-error" role="alert" className="mt-1 text-sm font-normal text-red-700">{formErrors.leave_type_id}</p> : null}
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="From"
                type="date"
                value={form.start_date}
                required
                error={formErrors.start_date}
                onChange={(v) => updateForm({ start_date: v })}
              />
              <Field
                label="To"
                type="date"
                value={form.end_date}
                required
                min={form.start_date || undefined}
                error={formErrors.end_date || formErrors.dateRange}
                onChange={(v) => updateForm({ end_date: v })}
              />
            </div>
            <label className="block text-sm font-semibold">
              Duration
              <select
                aria-label="Leave duration"
                value={form.partial_day}
                onChange={(e) =>
                  updateForm({ partial_day: e.target.value })
                }
                className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
              >
                <option value="none">Full days</option>
                <option value="start_half">Half day on start</option>
                <option value="end_half">Half day on end</option>
                <option value="custom_hours">Custom hours</option>
              </select>
            </label>
            {form.partial_day === "custom_hours" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Partial start" type="time" required value={form.partial_start_time} onChange={(value) => updateForm({ partial_start_time: value })} />
                <Field label="Partial end" type="time" required value={form.partial_end_time} error={formErrors.partial_end_time} onChange={(value) => updateForm({ partial_end_time: value })} />
                <p className="text-xs text-muted-foreground sm:col-span-2">Times use the organization timezone. Custom-hour leave must use the same date.</p>
              </div>
            )}
            <Field
              label="Reason"
              value={form.reason}
              required
              helperText="Briefly explain why you need leave; include relevant context your approver should know."
              error={formErrors.reason}
              onChange={(v) => updateForm({ reason: v })}
            />
            <div className="rounded-lg bg-muted p-4 text-sm">
              <b>Request preview</b>
              <p className="mt-1">Projected charge: {!form.start_date || !form.end_date || formErrors.dateRange || formErrors.end_date ? "Enter a valid working-day range" : `${projectedDays.toFixed(2)} ${selectedType?.unit || "unit"}`}</p>
              <p>
                Projected remaining:{" "}
                {!form.start_date || !form.end_date || formErrors.dateRange || formErrors.end_date
                  ? "—"
                  : selectedBalance
                  ? selectedBalance.remaining - projectedDays
                  : "Unavailable"}
              </p>
            </div>
            {formErrors.form ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{formErrors.form}</p> : null}
            <Button disabled={busy || !types.length} aria-busy={busy} className="w-full">
              {busy ? "Submitting…" : "Submit request"}
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Holidays({ data, canManage = false, refresh, notify }) {
  const calendars = data["holiday-calendars"] || [];
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({
    holiday_calendar_id: "",
    name: "",
    local_date: "",
    observance_type: "public",
    description: "",
  });
  useEffect(() => {
    if (calendars[0] && !form.holiday_calendar_id)
      setForm((value) => ({
        ...value,
        holiday_calendar_id: calendars[0].holiday_calendar_id,
      }));
  }, [calendars, form.holiday_calendar_id]);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.create("holidays", {
        ...form,
        description: form.description || null,
        status: "active",
      });
      notify("Holiday published.");
      setModal(false);
      await refresh();
    } catch (error) {
      notify(error.message, "error");
    }
  };
  const deactivate = async (item) => {
    if (
      !window.confirm(
        `Deactivate ${item.name}? Future calculations will no longer treat it as active.`,
      )
    )
      return;
    try {
      await api.update("holidays", item.holiday_id, {
        ...item,
        status: "inactive",
      });
      notify("Holiday deactivated.");
      await refresh();
    } catch (error) {
      notify(error.message, "error");
    }
  };
  return (
    <div className="space-y-5">
      <Header
        title="Holiday calendar"
        detail="Public, company, and optional holidays for your location."
        action={
          canManage ? (
            <Button onClick={() => setModal(true)}>Add holiday</Button>
          ) : null
        }
      />
      {data.holidays.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.holidays.map((item) => (
            <Card key={item.holiday_id}>
              <CardContent className="pt-6">
                <div className="flex justify-between gap-3">
                  <CalendarDays className="mb-4 h-7 w-7 text-primary" />
                  <Status value={item.status} />
                </div>
                <p className="text-sm font-bold text-primary">
                  {human(item.observance_type)}
                </p>
                <h2 className="mt-1 text-xl">{item.name}</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {date(item.local_date)}
                </p>
                {item.description && (
                  <p className="mt-3 text-sm">{item.description}</p>
                )}
                {canManage && item.status === "active" && (
                  <Button
                    className="mt-4"
                    variant="outline"
                    onClick={() => deactivate(item)}
                  >
                    Deactivate
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Empty
          title="No holidays scheduled"
          detail="Your organization has not published holidays yet."
        />
      )}
      {modal && (
        <Modal title="Add holiday" close={() => setModal(false)}>
          <form className="space-y-4" onSubmit={submit}>
            <label className="block text-sm font-semibold">
              Calendar
              <select
                aria-label="Holiday calendar"
                value={form.holiday_calendar_id}
                onChange={(e) =>
                  setForm({ ...form, holiday_calendar_id: e.target.value })
                }
                className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
              >
                {calendars.map((item) => (
                  <option
                    key={item.holiday_calendar_id}
                    value={item.holiday_calendar_id}
                  >
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="Holiday name"
              required
              value={form.name}
              onChange={(v) => setForm({ ...form, name: v })}
            />
            <Field
              label="Holiday date"
              type="date"
              required
              value={form.local_date}
              onChange={(v) => setForm({ ...form, local_date: v })}
            />
            <label className="block text-sm font-semibold">
              Observance
              <select
                aria-label="Observance type"
                value={form.observance_type}
                onChange={(e) =>
                  setForm({ ...form, observance_type: e.target.value })
                }
                className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
              >
                <option value="public">Public</option>
                <option value="company">Company</option>
                <option value="optional">Optional</option>
              </select>
            </label>
            <Field
              label="Description"
              value={form.description}
              onChange={(v) => setForm({ ...form, description: v })}
            />
            <Button disabled={!calendars.length} className="w-full">
              Publish holiday
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function Profile({ user, employee, tenant, notify }) {
  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });
  const [passwordError, setPasswordError] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const updatePassword = (key, value) => {
    setPasswords((current) => ({ ...current, [key]: value }));
    setPasswordError("");
  };
  const submitPassword = async (event) => {
    event.preventDefault();
    if (passwords.next.length < 12) {
      setPasswordError("The new password must be at least 12 characters.");
      return;
    }
    if (passwords.next !== passwords.confirm) {
      setPasswordError("The new passwords do not match.");
      return;
    }
    setChangingPassword(true);
    setPasswordError("");
    try {
      await api.changePassword(passwords.current, passwords.next);
      setPasswords({ current: "", next: "", confirm: "" });
      notify("Your password was changed successfully.");
    } catch (failure) {
      setPasswordError(failure.message);
    } finally {
      setChangingPassword(false);
    }
  };
  return (
    <div className="space-y-5">
      <Header
        title="Profile"
        detail="Your verified account and employment assignment."
      />
      <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
        <Card>
          <CardContent className="flex flex-col gap-5 pt-6 sm:flex-row sm:items-center">
            <div className="grid h-20 w-20 place-items-center rounded-2xl bg-secondary text-2xl font-extrabold">
              {initials(employee?.name || user.display_name)}
            </div>
            <div>
              <h2 className="text-2xl">
                {employee?.name || user.display_name}
              </h2>
              <p className="text-muted-foreground">{user.email}</p>
              <div className="mt-3">
                <Status value={employee?.status || user.status} />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Assignment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Employee number" value={employee?.employee_number} />
            <Row label="Start date" value={date(employee?.start_date)} />
            <Row label="Organization" value={tenant?.name} />
            <Row label="Access" value={roleFor(user)} />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>Enter your current password, then choose a new password with at least 12 characters.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="max-w-xl space-y-4" onSubmit={submitPassword} noValidate>
            <Field label="Current password" type="password" autoComplete="current-password" required value={passwords.current} onChange={(value) => updatePassword("current", value)} />
            <Field label="New password" type="password" autoComplete="new-password" minLength="12" required value={passwords.next} helperText="Use at least 12 characters." onChange={(value) => updatePassword("next", value)} />
            <Field label="Confirm new password" type="password" autoComplete="new-password" minLength="12" required value={passwords.confirm} onChange={(value) => updatePassword("confirm", value)} />
            {passwordError ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{passwordError}</p> : null}
            <Button disabled={changingPassword || !passwords.current || !passwords.next || !passwords.confirm}>{changingPassword ? "Changing password…" : "Change password"}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
function Approvals({ data, refresh, notify }) {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [selected, setSelected] = useState(null);
  const [decision, setDecision] = useState(null);
  const [busyId, setBusyId] = useState("");
  const employees = new Map(data.employees.map((item) => [item.employee_id, item]));
  const leaveTypes = new Map(data["leave-types"].map((item) => [item.leave_type_id, item]));
  const pending = [
    ...data["leave-requests"]
      .filter((i) => i.status === "pending")
      .map((i) => ({ ...i, kind: "leave" })),
    ...data["attendance-adjustments"]
      .filter((i) => i.status === "pending")
      .map((i) => ({ ...i, kind: "adjustment" })),
    ...data["overtime-requests"]
      .filter((i) => i.status === "pending")
      .map((i) => ({ ...i, kind: "overtime" })),
  ].map((item) => ({
    ...item,
    employee: employees.get(item.employee_id),
    leaveType: leaveTypes.get(item.leave_type_id),
  }));
  const visiblePending = pending.filter((item) => {
    const haystack = [
      item.employee?.name,
      item.employee?.employee_number,
      item.reason,
      item.leaveType?.name,
      item.start_date,
      item.end_date,
      item.local_date,
    ].filter(Boolean).join(" ").toLowerCase();
    return (kindFilter === "all" || item.kind === kindFilter) && haystack.includes(query.toLowerCase());
  });
  const itemKey = (item) => item.request_id || item.adjustment_id || item.overtime_request_id;
  const decide = async (item, decision) => {
    const key = itemKey(item);
    setBusyId(`${key}:${decision}`);
    try {
      const resource = item.kind === "leave" ? "leave-requests" : item.kind === "adjustment" ? "attendance-adjustments" : "overtime-requests";
      const id = key;
      await api.transition(`/${resource}/${id}/${decision}`, {}, item.version);
      notify(
        `${human(item.kind)} ${decision === "approve" ? "approved" : "rejected"}.`,
      );
      setSelected(null);
      setDecision(null);
      await refresh();
    } catch (e) {
      if (e.status === 409) await refresh();
      notify(e.message, "error");
    } finally {
      setBusyId("");
    }
  };
  const openDecision = (item, nextDecision) => {
    setSelected(item);
    setDecision(nextDecision);
  };
  const selectedKey = selected ? itemKey(selected) : "";
  const selectedBusy = selected && decision ? busyId === `${selectedKey}:${decision}` : false;
  return (
    <div className="space-y-5">
      <Header
        title="Approvals"
        detail="Review pending requests in your authorized team scope."
      />
      {pending.length ? <Card><CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-end">
        <Field label="Search approvals" value={query} onChange={setQuery} helperText="Search by employee, request reason, leave type, or date." />
        <label className="text-sm font-semibold">Request type<select aria-label="Approval request type" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-white px-3"><option value="all">All request types</option><option value="leave">Leave</option><option value="adjustment">Adjustment</option><option value="overtime">Overtime</option></select></label>
        <Button variant="ghost" onClick={() => { setQuery(""); setKindFilter("all"); }}>Clear filters</Button>
      </CardContent></Card> : null}
      {visiblePending.length ? (
        <div className="space-y-3">
          {visiblePending.map((item) => (
            <Card key={itemKey(item)}>
              <CardContent className="flex flex-col gap-4 pt-6 md:flex-row md:items-center">
                <div className="flex-1">
                  <p className="text-sm font-bold text-primary">{human(item.kind)}</p>
                  <h2 className="mt-1">{item.employee?.name || "Unknown employee"}</h2>
                  <p className="text-sm">{item.reason || "No reason provided"}</p>
                  {item.kind === "leave" ? <p className="text-sm text-muted-foreground">{item.leaveType?.name || "Leave"} · {date(item.start_date)} – {date(item.end_date)} · {item.chargeable_amount ?? "—"} day(s)</p> : null}
                  {item.kind === "adjustment" ? <p className="text-sm text-muted-foreground">{date(item.local_date)} · Attendance correction</p> : null}
                  {item.kind === "overtime" ? <p className="text-sm text-muted-foreground">{date(item.local_date)} · {item.start_time.slice(0, 5)}–{item.end_time.slice(0, 5)} · {item.requested_mins} minutes</p> : null}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => openDecision(item, "reject")}
                  >
                    Reject
                  </Button>
                  <Button onClick={() => openDecision(item, "approve")}>
                    Approve
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : pending.length ? (
        <Empty title="No approvals match" detail="Clear the search or request type filter to see pending requests." />
      ) : (
        <Empty
          title="Inbox cleared"
          detail="There are no pending requests in your scope."
        />
      )}
      {selected && decision ? <Modal title={`${decision === "approve" ? "Approve" : "Reject"} ${human(selected.kind).toLowerCase()}`} close={() => { if (!selectedBusy) { setSelected(null); setDecision(null); } }}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">Confirm this decision for the request below. This action changes the workflow status.</p>
          <div className="rounded-lg border bg-muted/40 p-4 text-sm">
            <p className="font-bold">{selected.employee?.name || "Unknown employee"}</p>
            {selected.employee?.employee_number ? <p className="text-muted-foreground">{selected.employee.employee_number}</p> : null}
            <p className="mt-3"><b>Request:</b> {human(selected.kind)}</p>
            <p><b>Reason:</b> {selected.reason || "No reason provided"}</p>
            {selected.kind === "leave" ? <p><b>Dates:</b> {date(selected.start_date)} – {date(selected.end_date)} · {selected.leaveType?.name || "Leave"} · {selected.chargeable_amount ?? "—"} day(s)</p> : null}
            {selected.kind === "adjustment" ? <p><b>Date:</b> {date(selected.local_date)}</p> : null}
            {selected.kind === "overtime" ? <p><b>Schedule:</b> {date(selected.local_date)} · {selected.start_time.slice(0, 5)}–{selected.end_time.slice(0, 5)} · {selected.requested_mins} minutes</p> : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={selectedBusy} onClick={() => { setSelected(null); setDecision(null); }}>Cancel</Button>
            <Button aria-busy={selectedBusy} disabled={selectedBusy} onClick={() => decide(selected, decision)}>{selectedBusy ? "Saving…" : decision === "approve" ? "Confirm approval" : "Confirm rejection"}</Button>
          </div>
        </div>
      </Modal> : null}
    </div>
  );
}
function TeamDashboard({ data, user, onNavigate }) {
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api.teamDashboard().then(setDashboard).catch((failure) => setError(failure.message)), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState message={error} retry={load} />;
  if (!dashboard) return <Loading />;
  return <div className="space-y-5"><Header title="Team dashboard" detail="Live direct-report coverage, approvals, and workload signals." /><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Metric value={dashboard.direct_reports} label="Active direct reports" /><Metric value={dashboard.timesheets?.items?.length || 0} label="Recent timesheets" /><Metric value={dashboard.pending_approvals} label="Pending approvals" /><Metric value={dashboard.pending_overtime_approvals || 0} label="Overtime requests" /></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Button variant="outline" onClick={() => onNavigate("approvals")}>Review approvals ({dashboard.pending_approvals || 0})</Button><Button variant="outline" onClick={() => onNavigate("whos-in")}>View presence</Button><Button variant="outline" onClick={() => onNavigate("team-calendar")}>Review coverage</Button><Button variant="outline" onClick={() => onNavigate("alerts")}>Open alerts ({dashboard.alerts?.length || 0})</Button></div></div>;
}

function LegacyTeamDashboard({ data, user, onNavigate }) {
  const team = data.employees.filter(
    (item) => item.employee_id !== user.employee_id && item.status === "active",
  );
  const teamIds = new Set(team.map((item) => item.employee_id));
  const open = data["attendance-sessions"].filter(
    (item) => teamIds.has(item.employee_id) && item.status === "open",
  ).length;
  const pending =
    data["leave-requests"].filter(
      (item) => teamIds.has(item.employee_id) && item.status === "pending",
    ).length +
    data["attendance-adjustments"].filter(
      (item) => teamIds.has(item.employee_id) && item.status === "pending",
    ).length;
  return (
    <div className="space-y-5">
      <Header
        title="Team dashboard"
        detail="Live direct-report coverage, approvals, and workload signals."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Metric value={team.length} label="Active direct reports" />
        <Metric value={open} label="Clocked in" />
        <Metric value={pending} label="Pending approvals" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Button variant="outline" onClick={() => onNavigate("whos-in")}>
          View presence
        </Button>
        <Button variant="outline" onClick={() => onNavigate("team-calendar")}>
          Review coverage
        </Button>
        <Button variant="outline" onClick={() => onNavigate("alerts")}>
          Open alerts
        </Button>
      </div>
    </div>
  );
}

function Metric({ value, label }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-3xl font-extrabold">{value}</p>
        <p className="mt-1 text-sm text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

function Pagination({ page, pageCount, pageSize, onPage, onPageSize, total }) {
  if (!total) return null;
  return (
    <div className="flex flex-col gap-3 border-t pt-4 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="text-muted-foreground">Page {page} of {pageCount} · {total} matching records</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">Rows<select aria-label="Rows per page" value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))} className="h-9 rounded-md border bg-white px-2"><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label>
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(1)}>First</Button>
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next</Button>
        <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => onPage(pageCount)}>Last</Button>
      </div>
    </div>
  );
}

function WhosIn({ data, user }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const today = new Date().toISOString().slice(0, 10);
  const openByEmployee = new Map(
    data["attendance-sessions"]
      .filter((item) => item.status === "open")
      .map((item) => [item.employee_id, item]),
  );
  const approvedLeave = new Set(
    data["leave-requests"]
      .filter(
        (item) =>
          item.status === "approved" &&
          item.start_date <= today &&
          item.end_date >= today,
      )
      .map((item) => item.employee_id),
  );
  const rows = data.employees
    .filter(
      (item) =>
        item.employee_id !== user.employee_id && item.status === "active",
    )
    .map((item) => ({
      ...item,
      presence: approvedLeave.has(item.employee_id)
        ? "on_leave"
        : openByEmployee.has(item.employee_id)
          ? "clocked_in"
          : "clocked_out",
      session: openByEmployee.get(item.employee_id),
    }))
    .filter(
      (item) =>
        (filter === "all" || item.presence === filter) &&
        item.name.toLowerCase().includes(query.toLowerCase()),
    );
  return (
    <div className="space-y-5">
      <Header
        title="Who’s in"
        detail="Current presence for active direct reports."
      />
      <div className="flex flex-col gap-3 sm:flex-row">
        <Field label="Search team" value={query} onChange={setQuery} />
        <label className="text-sm font-semibold">
          Status
          <select
            aria-label="Presence status"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
          >
            <option value="all">All statuses</option>
            <option value="clocked_in">Clocked in</option>
            <option value="clocked_out">Clocked out</option>
            <option value="on_leave">On leave</option>
          </select>
        </label>
      </div>
      {rows.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {rows.map((item) => (
            <Card key={item.employee_id}>
              <CardContent className="flex items-center justify-between gap-3 pt-6">
                <div>
                  <h2>{item.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    {item.employee_number}
                  </p>
                  {item.session && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Since {dateTime(item.session.clock_in_at)}
                    </p>
                  )}
                </div>
                <Status value={item.presence} />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Empty
          title="No team members match"
          detail="Clear the search or status filter to see the roster."
        />
      )}
    </div>
  );
}

function TeamCalendar({ data, user }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const load = useCallback(() => api.teamCalendar().then(setRows).catch((failure) => setError(failure.message)), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState message={error} retry={load} />;
  if (!rows) return <Loading />;
  const names = new Map(data.employees.map((item) => [item.employee_id, item.name]));
  return <TeamCalendarView
    rows={rows}
    names={names}
    weekStart={data.tenants[0]?.week_start}
    timeZone={data.tenants[0]?.timezone}
  />;
}

function TeamCalendarView({ rows, names, weekStart, timeZone }) {
  const [includePending, setIncludePending] = useState(false);
  const [view, setView] = useState("month");
  const [query, setQuery] = useState("");
  const [monthOffset, setMonthOffset] = useState(0);
  const statuses = includePending ? ["approved", "pending"] : ["approved"];
  const visibleRows = rows
    .filter((item) => statuses.includes(item.status))
    .filter((item) => `${names.get(item.employee_id)} ${item.leave_type_id} ${item.reason}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const calendarDate = monthDateForTimeZone(timeZone, monthOffset);
  const calendarKey = `${calendarDate.getFullYear()}-${String(calendarDate.getMonth() + 1).padStart(2, "0")}`;
  const { daysInMonth, leadingDays } = monthGrid(
    calendarDate.getFullYear(),
    calendarDate.getMonth(),
    weekStart,
  );
  const calendarWeekdays = weekdayLabels(weekStart);
  return (
    <div className="space-y-5">
      <Header
        title="Team leave calendar"
        detail="Upcoming approved leave and optional pending coverage."
        action={
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              checked={includePending}
              onChange={(e) => setIncludePending(e.target.checked)}
            />
            Include pending
          </label>
        }
      />
      <Card><CardContent className="space-y-4 pt-6"><div className="flex flex-col gap-3 sm:flex-row sm:items-end"><Field label="Search team leave" value={query} onChange={setQuery} /><div className="flex gap-2"><Button variant={view === "month" ? "secondary" : "outline"} onClick={() => setView("month")}>Month</Button><Button variant={view === "timeline" ? "secondary" : "outline"} onClick={() => setView("timeline")}>Timeline</Button><Button variant="ghost" onClick={() => setQuery("")}>Clear</Button></div></div>{view === "month" ? <div className="space-y-3"><div className="flex items-center justify-between"><Button variant="outline" size="sm" onClick={() => setMonthOffset((value) => value - 1)}>Previous month</Button><b>{calendarDate.toLocaleDateString("en", { month: "long", year: "numeric" })}</b><Button variant="outline" size="sm" onClick={() => setMonthOffset((value) => value + 1)}>Next month</Button></div><div className="grid grid-cols-7 gap-1" aria-label="Team leave calendar">{calendarWeekdays.map((day) => <div className="p-2 text-center text-xs font-semibold text-muted-foreground" key={day}>{day}</div>)}{Array.from({ length: leadingDays }, (_, index) => <div aria-hidden="true" key={`blank-${index}`} />)}{Array.from({ length: daysInMonth }, (_, index) => { const localDate = `${calendarKey}-${String(index + 1).padStart(2, "0")}`; const matches = visibleRows.filter((item) => item.start_date <= localDate && item.end_date >= localDate); const overlap = matches.length > 1; const dayLabel = new Date(`${localDate}T12:00:00`).toLocaleDateString("en", { month: "long", day: "numeric", year: "numeric" }); const details = matches.length ? matches.map((item) => `${names.get(item.employee_id) || "Team member"}${item.status === "pending" ? " (pending)" : ""}`).join(", ") : "No leave"; return <div key={localDate} role="group" aria-label={`${dayLabel}: ${details}`} className={`min-h-20 rounded-md border p-2 text-xs ${overlap ? "border-red-400 bg-red-50 text-red-900" : matches.length ? "bg-amber-50 text-amber-900" : "bg-white"}`}><b>{index + 1}</b>{matches.map((item) => <span className="mt-1 block truncate" title={names.get(item.employee_id)} key={item.request_id}>{names.get(item.employee_id)}{item.status === "pending" ? " · pending" : ""}</span>)}</div>; })}</div><p className="text-sm text-muted-foreground">Red days indicate overlapping leave; pending requests are shown only when enabled.</p></div> : visibleRows.length ? <div className="space-y-3">{visibleRows.map((item) => <Card key={item.request_id}><CardContent className="flex flex-col justify-between gap-3 pt-6 sm:flex-row sm:items-center"><div><h2>{names.get(item.employee_id)}</h2><p className="text-sm text-muted-foreground">{date(item.start_date)} – {date(item.end_date)} · {item.chargeable_amount} day(s)</p></div><Status value={item.status} /></CardContent></Card>)}</div> : <Empty title="No scheduled team leave" detail="Approved leave will appear here; include pending to preview requests." />}</CardContent></Card>
    </div>
  );
}

function TeamReports({ data, user, tenant }) {
  const [tab, setTab] = useState("timesheets");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [timesheets, setTimesheets] = useState({ items: [], total: 0, page: 1, page_size: 10, page_count: 1 });
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [timesheetResult, alertResult] = await Promise.all([
        api.teamTimesheets({ q: query, status: status === "all" ? "" : status, page, page_size: pageSize }),
        api.teamAlerts(),
      ]);
      setTimesheets(timesheetResult);
      setAlerts(alertResult);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, query, status]);
  useEffect(() => { load(); }, [load]);
  const exportCsv = async () => {
    setExporting(true);
    setExportMessage("");
    try {
      const params = new URLSearchParams({ q: query, ...(status === "all" ? {} : { status }) });
      const result = await api.downloadCsv(`/team/reports/timesheets.csv?${params}`);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(result.blob);
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(link.href);
      setExportMessage("CSV exported successfully.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setExporting(false);
    }
  };
  if (error) return <ErrorState message={error} retry={load} />;
  if (loading) return <Loading />;
  return <div className="space-y-5">
    <Header title="Reports & alerts" detail="Server-calculated timesheets and threshold-based workload signals for your reporting scope." action={tab === "timesheets" ? <div className="flex flex-wrap items-center justify-end gap-3"><Button aria-busy={exporting} disabled={exporting} onClick={exportCsv}>{exporting ? "Exporting…" : "Export filtered CSV"}</Button>{exportMessage ? <span role="status" className="text-sm font-semibold text-green-700">{exportMessage}</span> : null}</div> : null} />
    <div className="flex flex-wrap gap-2">
      <Button variant={tab === "timesheets" ? "secondary" : "outline"} onClick={() => setTab("timesheets")}>Timesheets ({timesheets.total})</Button>
      <Button variant={tab === "alerts" ? "secondary" : "outline"} onClick={() => setTab("alerts")}>Workload alerts ({alerts.length})</Button>
    </div>
    {tab === "timesheets" ? <>
      <Card><CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-end">
        <Field label="Search employee or date" value={query} onChange={(value) => { setQuery(value); setPage(1); }} />
        <label className="text-sm font-semibold">Status<select aria-label="Timesheet status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="mt-1 block h-10 rounded-lg border bg-white px-3"><option value="all">All</option><option value="complete">Complete</option><option value="below_standard">Below standard</option><option value="absent">Absent</option><option value="missing_punch">Missing punch</option></select></label>
      </CardContent></Card>
      <Card><CardContent className="overflow-x-auto pt-6"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr className="border-b">{["Employee", "Date", "Worked", "Scheduled", "Overtime", "Status"].map((label) => <th className="p-3" key={label}>{label}</th>)}</tr></thead><tbody>{timesheets.items.map((item) => <tr className="border-b" key={item.summary_id}><td className="p-3 font-semibold">{item.name}</td><td className="p-3">{date(item.local_date)}</td><td className="p-3">{item.worked_mins} min</td><td className="p-3">{item.scheduled_mins} min</td><td className="p-3">{item.overtime_mins} min</td><td className="p-3"><Status value={item.status} /></td></tr>)}</tbody></table>{!timesheets.items.length && <Empty title="No matching timesheets" detail="Adjust the search or status filter." />}<Pagination page={timesheets.page} pageCount={timesheets.page_count} pageSize={timesheets.page_size} total={timesheets.total} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} /></CardContent></Card>
    </> : alerts.length ? <div className="grid gap-3 lg:grid-cols-2">{alerts.map((item) => <Card key={`${item.employee_id}-${item.type}`}><CardContent className="pt-6"><div className="flex items-start justify-between gap-3"><div><h2>{item.name}</h2><p className="text-sm text-muted-foreground">{item.job_title} | {item.type} | {item.is_ot_eligible ? "overtime eligible" : "standard limit applies"}</p></div><Status value={item.severity} /></div><p className="mt-4 font-semibold">{item.worked_mins} of {item.standard_weekly_mins} weekly minutes ({item.percent}%)</p><p className="text-sm text-muted-foreground">Variance: {item.variance_mins} minutes; scheduled in sample: {item.scheduled_mins}.</p>{item.week_start && item.week_end ? <p className="text-xs text-muted-foreground">Week: {date(item.week_start)} - {date(item.week_end)}</p> : null}</CardContent></Card>)}</div> : <Empty title="No workload alerts" detail="Direct reports are currently within their configured thresholds." />}
  </div>;
}

function LegacyTeamReports({ data, user, tenant }) {
  const [tab, setTab] = useState("timesheets");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const names = new Map(data.employees.map((item) => [item.employee_id, item.name]));
  const jobs = new Map(data["job-profiles"].map((item) => [item.job_id, item]));
  const teamIds = new Set(data.employees.filter((item) => item.employee_id !== user.employee_id && (user.roles || []).includes("HR Manager") ? item.status === "active" : item.manager_id === user.employee_id).map((item) => item.employee_id));
  const summaries = data["attendance-summaries"].filter((item) => teamIds.has(item.employee_id));
  const filtered = summaries.filter((item) => {
    const employee = data.employees.find((entry) => entry.employee_id === item.employee_id);
    const haystack = `${names.get(item.employee_id)} ${employee?.employee_number || ""} ${item.local_date}`.toLowerCase();
    return (!query || haystack.includes(query.toLowerCase())) && (status === "all" || item.status === status);
  }).sort((a, b) => b.local_date.localeCompare(a.local_date));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
  const alerts = [...new Set(summaries.map((item) => item.employee_id))].map((employeeId) => {
    const employeeRows = summaries.filter((item) => item.employee_id === employeeId);
    const employee = data.employees.find((item) => item.employee_id === employeeId);
    const job = jobs.get(employee?.job_id) || {};
    const worked = employeeRows.reduce((sum, item) => sum + Number(item.worked_mins || 0), 0);
    const scheduled = employeeRows.reduce((sum, item) => sum + Number(item.scheduled_mins || 0), 0);
    const dailyBreach = employeeRows.find((item) => job.max_daily_mins && item.worked_mins > job.max_daily_mins);
    const percent = job.standard_weekly_mins ? Math.round((worked / job.standard_weekly_mins) * 100) : 0;
    const type = dailyBreach ? "Daily-limit breach" : percent >= 100 ? (job.is_ot_eligible ? "Overtime" : "Limit exception") : percent >= 80 ? "Approaching limit" : null;
    if (!type) return null;
    const severity = dailyBreach || percent >= 100 ? "critical" : "warning";
    return { employeeId, name: names.get(employeeId), job: job.title, type, severity, worked, scheduled, standard: job.standard_weekly_mins, variance: worked - job.standard_weekly_mins, eligible: Boolean(job.is_ot_eligible) };
  }).filter(Boolean);
  const exportCsv = () => {
    const escape = (value) => { const text = String(value ?? ""); const safe = /^[-=+@]/.test(text) ? `'${text}` : text; return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe; };
    const csv = [["employee", "date", "worked_mins", "scheduled_mins", "status"], ...filtered.map((item) => [names.get(item.employee_id), item.local_date, item.worked_mins, item.scheduled_mins, item.status])].map((row) => row.map(escape).join(",")).join("\\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = `team-timesheets-${tenant?.tenant_id || "tenant"}-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
  };
  return <div className="space-y-5"><Header title="Reports & alerts" detail="Searchable timesheets and threshold-based workload signals for your reporting scope." action={tab === "timesheets" ? <Button onClick={exportCsv}>Export filtered CSV</Button> : null} /><div className="flex flex-wrap gap-2"><Button variant={tab === "timesheets" ? "secondary" : "outline"} onClick={() => setTab("timesheets")}>Timesheets ({filtered.length})</Button><Button variant={tab === "alerts" ? "secondary" : "outline"} onClick={() => setTab("alerts")}>Workload alerts ({alerts.length})</Button></div>{tab === "timesheets" ? <><Card><CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-end"><Field label="Search employee or date" value={query} onChange={(value) => { setQuery(value); setPage(1); }} /><label className="text-sm font-semibold">Status<select aria-label="Timesheet status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="mt-1 block h-10 rounded-lg border bg-white px-3"><option value="all">All</option><option value="complete">Complete</option><option value="below_standard">Below standard</option><option value="absent">Absent</option><option value="missing_punch">Missing punch</option></select></label></CardContent></Card><Card><CardContent className="overflow-x-auto pt-6"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr className="border-b">{["Employee", "Date", "Worked", "Scheduled", "Overtime", "Status"].map((label) => <th className="p-3" key={label}>{label}</th>)}</tr></thead><tbody>{visible.map((item) => <tr className="border-b" key={item.summary_id}><td className="p-3 font-semibold">{names.get(item.employee_id)}</td><td className="p-3">{date(item.local_date)}</td><td className="p-3">{item.worked_mins} min</td><td className="p-3">{item.scheduled_mins} min</td><td className="p-3">{item.overtime_mins} min</td><td className="p-3"><Status value={item.status} /></td></tr>)}</tbody></table>{!visible.length && <Empty title="No matching timesheets" detail="Adjust the search or status filter." />}<Pagination page={page} pageCount={pageCount} pageSize={pageSize} total={filtered.length} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} /></CardContent></Card></> : alerts.length ? <div className="grid gap-3 lg:grid-cols-2">{alerts.map((item) => <Card key={`${item.employeeId}-${item.type}`}><CardContent className="pt-6"><div className="flex items-start justify-between gap-3"><div><h2>{item.name}</h2><p className="text-sm text-muted-foreground">{item.job} · {item.type} · {item.eligible ? "overtime eligible" : "standard limit applies"}</p></div><Status value={item.severity} /></div><p className="mt-4 font-semibold">{item.worked} of {item.standard} weekly minutes ({Math.round((item.worked / item.standard) * 100)}%)</p><p className="text-sm text-muted-foreground">Variance: {item.variance} minutes; scheduled in sample: {item.scheduled}.</p></CardContent></Card>)}</div> : <Empty title="No workload alerts" detail="Direct reports are currently within their configured thresholds." />}</div>;
}

function Alerts({ data }) {
  const [severity, setSeverity] = useState("all");
  const names = new Map(
    data.employees.map((item) => [item.employee_id, item.name]),
  );
  const rows = data.alerts.filter(
    (item) => severity === "all" || item.severity === severity,
  );
  return (
    <div className="space-y-5">
      <Header
        title="Overtime and limit alerts"
        detail="Direct-report workload signals calculated by the backend."
        action={
          <label className="text-sm font-semibold">
            Severity
            <select
              aria-label="Alert severity"
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className="ml-2 h-10 rounded-lg border bg-white px-3"
            >
              <option value="all">All</option>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </label>
        }
      />
      {rows.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((item) => (
            <Card key={item.alert_id}>
              <CardContent className="pt-6">
                <div className="flex justify-between gap-3">
                  <div>
                    <h2>{names.get(item.employee_id) || item.employee_id}</h2>
                    <p className="text-sm text-muted-foreground">
                      {human(item.type)} · {date(item.period_start)} –{" "}
                      {date(item.period_end)}
                    </p>
                  </div>
                  <Status value={item.severity} />
                </div>
                <p className="mt-4 font-semibold">
                  {item.current_mins} of {item.threshold_mins} minutes
                </p>
                <p className="text-sm text-muted-foreground">
                  Variance: {item.current_mins - item.threshold_mins} minutes ·{" "}
                  {human(item.status)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Empty
          title="No alerts match"
          detail="There are no workload alerts for this severity."
        />
      )}
    </div>
  );
}

function LegacyFilterToolbar({ query, onQuery, filters = [], onClear, children }) {
  const active = filters.filter((filter) => filter.value && filter.value !== "all").length;
  return (
    <Card>
      <CardContent className="space-y-3 pt-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1"><Field label="Search" value={query} onChange={onQuery} /></div>
          {filters.map((filter) => (
            <label className="min-w-36 text-sm font-semibold" key={filter.label}>
              {filter.label}
              <select aria-label={filter.label} value={filter.value} onChange={(event) => filter.onChange(event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-white px-3">
                {filter.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
          ))}
          {children}
          <Button variant="ghost" onClick={onClear} disabled={!query && !active}>Clear all</Button>
        </div>
        {active ? <div className="flex flex-wrap gap-2 text-xs">{filters.filter((filter) => filter.value && filter.value !== "all").map((filter) => <button className="rounded-full bg-secondary px-3 py-1 font-semibold" key={filter.label} onClick={() => filter.onChange("all")}>{filter.label}: {filter.options.find((option) => option.value === filter.value)?.label} ×</button>)}</div> : null}
      </CardContent>
    </Card>
  );
}

function FilterToolbar({
  viewKey = "default",
  viewState,
  onApplyState,
  query,
  onQuery,
  filters = [],
  sort,
  onSort,
  sortOptions = [],
  onClear,
  resultCount,
  children,
}) {
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [savePanelOpen, setSavePanelOpen] = useState(false);
  const [viewName, setViewName] = useState("");
  const [savedViews, setSavedViews] = useState([]);
  const [enabledFilterIds, setEnabledFilterIds] = useState(() =>
    filters.slice(0, 2).map((filter) => filter.id || filter.label),
  );
  const activeFilters = filters.filter(
    (filter) => filter.value && filter.value !== "all",
  );
  const active = activeFilters.length + (query ? 1 : 0);
  const storageKey = `tlt_saved_views_${viewKey}`;
  const snapshot = viewState || {
    query,
    ...Object.fromEntries(
      filters.map((filter) => [filter.id || filter.label, filter.value]),
    ),
    ...(sort ? { sort } : {}),
  };
  const filterId = (filter) => filter.id || filter.label;
  const visibleFilters = filterPanelOpen
    ? filters
    : filters.filter(
        (filter) =>
          enabledFilterIds.includes(filterId(filter)) ||
          (filter.value && filter.value !== "all"),
      );
  const optionalFilters = filters.filter(
    (filter) => !enabledFilterIds.includes(filterId(filter)),
  );

  useEffect(() => {
    setEnabledFilterIds((current) =>
      Array.from(
        new Set([
          ...current.filter((id) => filters.some((filter) => filterId(filter) === id)),
          ...filters.slice(0, 2).map(filterId),
        ]),
      ),
    );
  }, [filters.length]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
      setSavedViews(Array.isArray(stored) ? stored : []);
    } catch {
      setSavedViews([]);
    }
  }, [storageKey]);

  const saveView = () => {
    const name = viewName.trim();
    if (!name) return;
    const next = [
      { id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`, name, state: snapshot },
      ...savedViews.filter(
        (item) => item.name.toLowerCase() !== name.toLowerCase(),
      ),
    ].slice(0, 12);
    setSavedViews(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
    setViewName("");
    setSavePanelOpen(false);
  };

  const applyView = (event) => {
    const selected = savedViews.find((item) => item.id === event.target.value);
    if (!selected) return;
    if (onApplyState) onApplyState(selected.state);
    else {
      onQuery(selected.state.query || "");
      filters.forEach((filter) => {
        const key = filter.id || filter.label;
        if (selected.state[key] !== undefined)
          filter.onChange(selected.state[key]);
      });
      if (onSort && selected.state.sort) onSort(selected.state.sort);
    }
    setFilterPanelOpen(false);
  };

  return (
    <Card>
      <CardContent className="space-y-3 pt-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
          <div className="min-w-0 flex-1">
            <Field
              label="Search this view"
              placeholder="Name, ID, email, code, or keyword"
              value={query}
              onChange={onQuery}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="min-w-44 text-sm font-semibold">
              Saved view
              <select
                aria-label="Saved view"
                defaultValue=""
                onChange={applyView}
                className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
              >
                <option value="">Current filters</option>
                {savedViews.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSavePanelOpen((value) => !value)}
              aria-expanded={savePanelOpen}
            >
              <Save className="h-4 w-4" /> Save view
            </Button>
            <Button
              type="button"
              variant="outline"
              className="lg:hidden"
              onClick={() => setFilterPanelOpen((value) => !value)}
              aria-expanded={filterPanelOpen}
            >
              <Filter className="h-4 w-4" /> Filters{active ? ` (${active})` : ""}
            </Button>
            {optionalFilters.length ? (
              <Button
                type="button"
                variant="outline"
                className="hidden lg:inline-flex"
                onClick={() => setFilterMenuOpen((value) => !value)}
                aria-expanded={filterMenuOpen}
              >
                <Filter className="h-4 w-4" /> Add filter
              </Button>
            ) : null}
            {onSort && sortOptions.length ? (
              <label className="min-w-36 text-sm font-semibold">
                Sort
                <select
                  aria-label="Sort"
                  value={sort}
                  onChange={(event) => onSort(event.target.value)}
                  className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
                >
                  {sortOptions.map((option) => (
                    <option value={option.value} key={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button type="button" variant="ghost" onClick={onClear} disabled={!active}>
              Clear all
            </Button>
          </div>
        </div>
        {savePanelOpen ? (
          <div className="flex flex-col gap-2 rounded-xl border bg-muted/30 p-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Field
                label="View name"
                placeholder="e.g. Active employees without login"
                value={viewName}
                onChange={setViewName}
              />
            </div>
            <Button type="button" onClick={saveView} disabled={!viewName.trim()}>
              Save current view
            </Button>
          </div>
        ) : null}
        {filterMenuOpen ? (
          <div className="hidden flex-wrap gap-2 rounded-xl border bg-muted/30 p-3 lg:flex">
            <span className="w-full text-xs font-semibold uppercase tracking-wider text-muted-foreground">Add a field to this view</span>
            {optionalFilters.map((filter) => (
              <button
                type="button"
                className="rounded-lg border bg-white px-3 py-2 text-sm font-semibold hover:border-primary"
                key={filterId(filter)}
                onClick={() => setEnabledFilterIds((current) => [...current, filterId(filter)])}
              >
                + {filter.label}
              </button>
            ))}
          </div>
        ) : null}
        <div
          className={`${filterPanelOpen ? "flex" : "hidden lg:flex"} flex-wrap items-end gap-3 rounded-xl lg:rounded-none`}
        >
          {visibleFilters.map((filter) => (
            <label className="min-w-44 flex-1 text-sm font-semibold" key={filterId(filter)}>
              {filter.label}
              <select
                aria-label={filter.label}
                value={filter.value}
                onChange={(event) => filter.onChange(event.target.value)}
                className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
              >
                {filter.options.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {children}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {resultCount === undefined
              ? ""
              : `${resultCount.toLocaleString()} result${resultCount === 1 ? "" : "s"}`}
          </span>
          <span>
            {active
              ? `${active} active filter${active === 1 ? "" : "s"}`
              : "No filters applied"}
          </span>
        </div>
        {active ? (
          <div className="flex flex-wrap gap-2 text-xs">
            {query ? (
              <button
                type="button"
                className="rounded-full bg-secondary px-3 py-1 font-semibold"
                onClick={() => onQuery("")}
              >
                Search: {query} ×
              </button>
            ) : null}
            {activeFilters.map((filter) => (
              <button
                type="button"
                className="rounded-full bg-secondary px-3 py-1 font-semibold"
                key={filter.id || filter.label}
                onClick={() => filter.onChange("all")}
              >
                {filter.label}: {filter.options.find((option) => option.value === filter.value)?.label} ×
              </button>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Departments({ data, refresh, notify }) {
  const defaults = { query: "", status: "active", sort: "name", page: "1", pageSize: "10" };
  const [view, setView, resetView] = useDataViewState("departments", defaults);
  const query = view.query;
  const status = view.status;
  const sort = view.sort;
  const page = Number(view.page) || 1;
  const pageSize = Number(view.pageSize) || 10;
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ name: "", code: "", status: "active" });
  const employeesByDepartment = (id) => data.employees.filter((item) => item.department_id === id);
  const jobsByDepartment = (id) => data["job-profiles"].filter((item) => item.department_id === id);
  const rows = data.departments.filter((item) => (status === "all" || item.status === status) && `${item.name} ${item.code}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => {
    const left = String(a[sort] || a.name).toLowerCase();
    const right = String(b[sort] || b.name).toLowerCase();
    return left.localeCompare(right);
  });
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const visible = rows.slice((page - 1) * pageSize, page * pageSize);
  const submit = async (event) => {
    event.preventDefault();
    try {
      if (modal === "create") await api.create("departments", form);
      else await api.update("departments", modal.department_id, { ...modal, ...form });
      notify(modal === "create" ? "Department created." : "Department updated.");
      setModal(null);
      await refresh();
    } catch (error) { notify(error.message, "error"); }
  };
  const toggle = async (item) => {
    const employeeCount = employeesByDepartment(item.department_id).length;
    const jobCount = jobsByDepartment(item.department_id).length;
    const next = item.status === "active" ? "inactive" : "active";
    if (!window.confirm(`${next === "inactive" ? "Deactivate" : "Activate"} ${item.name}? ${employeeCount} employees and ${jobCount} jobs reference this department.`)) return;
    try { await api.update("departments", item.department_id, { ...item, status: next }); notify(`Department ${next}.`); await refresh(); } catch (error) { notify(error.message, "error"); }
  };
  return (
    <div className="space-y-5">
      <Header title="Departments" detail="Maintain tenant departments while preserving historical assignments." action={<Button onClick={() => { setForm({ name: "", code: "", status: "active" }); setModal("create"); }}>Add department</Button>} />
      <FilterToolbar viewKey="departments" viewState={view} onApplyState={(next) => setView({ ...defaults, ...next })} query={query} onQuery={(value) => setView({ query: value, page: "1" })} sort={sort} onSort={(value) => setView({ sort: value, page: "1" })} sortOptions={[{ value: "name", label: "Name" }, { value: "code", label: "Code" }, { value: "status", label: "Status" }]} resultCount={rows.length} filters={[{ id: "status", label: "Status", value: status, onChange: (value) => setView({ status: value, page: "1" }), options: [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }, { value: "all", label: "All statuses" }] }]} onClear={() => setView({ ...defaults, status: "all" })} />
      {visible.length ? <Card><CardContent className="overflow-x-auto p-0"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr className="border-b">{["Department", "Code", "Employees", "Jobs", "Status", "Actions"].map((label) => <th className="p-4" key={label}>{label}</th>)}</tr></thead><tbody>{visible.map((item) => <tr className="border-b last:border-0" key={item.department_id}><td className="p-4 font-semibold">{item.name}</td><td className="p-4">{item.code}</td><td className="p-4">{employeesByDepartment(item.department_id).length}</td><td className="p-4">{jobsByDepartment(item.department_id).length}</td><td className="p-4"><Status value={item.status} /></td><td className="p-4"><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { setForm({ name: item.name, code: item.code, status: item.status }); setModal(item); }}>Edit</Button><Button size="sm" variant="outline" onClick={() => toggle(item)}>{item.status === "active" ? "Deactivate" : "Activate"}</Button></div></td></tr>)}</tbody></table><Pagination page={page} pageCount={pageCount} pageSize={pageSize} total={rows.length} onPage={(value) => setView({ page: String(value) })} onPageSize={(value) => setView({ pageSize: String(value), page: "1" })} /></CardContent></Card> : <Empty title="No departments match" detail="Clear the filters or add a department." />}
      {modal ? <Modal title={modal === "create" ? "Add department" : "Edit department"} close={() => setModal(null)}><form className="space-y-4" onSubmit={submit}><Field label="Department name" value={form.name} required onChange={(value) => setForm({ ...form, name: value })} /><Field label="Code" value={form.code} required onChange={(value) => setForm({ ...form, code: value.toUpperCase() })} /><label className="block text-sm font-semibold">Status<select aria-label="Department status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })} className="mt-2 h-11 w-full rounded-lg border bg-white px-3"><option value="active">Active</option><option value="inactive">Inactive</option></select></label><Button className="w-full">Save department</Button></form></Modal> : null}
    </div>
  );
}

function Directory({ data, refresh, notify, user, onUserChange }) {
  const viewDefaults = { query: "", status: "active", department: "all", job: "all", location: "all", sort: "name", page: "1", pageSize: "10" };
  const [view, setView, resetView] = useDataViewState("directory", viewDefaults);
  const query = view.query;
  const status = view.status;
  const department = view.department;
  const job = view.job;
  const location = view.location;
  const sort = view.sort;
  const page = Number(view.page) || 1;
  const pageSize = Number(view.pageSize) || 10;
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const jobs = new Map(data["job-profiles"].map((item) => [item.job_id, item.title]));
  const activeJobs = data["job-profiles"].filter((item) => item.status === "active");
  const departments = new Map(data.departments.map((item) => [item.department_id, item.name]));
  const locations = new Map(data.locations.map((item) => [item.location_id, item.name]));
  const managers = new Map(data.employees.map((item) => [item.employee_id, item.name]));
  const userByEmployee = new Map(data.users.map((item) => [item.employee_id, item]));
  const defaults = () => ({ employee_number: "", name: "", job_id: activeJobs[0]?.job_id || "", manager_id: "", department_id: data.departments[0]?.department_id || "", location_id: data.locations[0]?.location_id || "", holiday_calendar_id: data["holiday-calendars"][0]?.holiday_calendar_id || "", schedule_id: data["work-schedules"][0]?.schedule_id || "", start_date: new Date().toISOString().slice(0, 10), status: "active", account_enabled: false, account_exists: false, email: "", password: "", roles: ["Employee"] });
  const rows = data.employees.filter((item) => (status === "all" || item.status === status) && (department === "all" || item.department_id === department) && (job === "all" || item.job_id === job) && (location === "all" || item.location_id === location) && `${item.name} ${item.employee_number}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => {
    const left = String(sort === "department" ? departments.get(a.department_id) : sort === "job" ? jobs.get(a.job_id) : sort === "location" ? locations.get(a.location_id) : a.name).toLowerCase();
    const right = String(sort === "department" ? departments.get(b.department_id) : sort === "job" ? jobs.get(b.job_id) : sort === "location" ? locations.get(b.location_id) : b.name).toLowerCase();
    return left.localeCompare(right);
  });
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const visible = rows.slice((page - 1) * pageSize, page * pageSize);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const openCreate = () => { setForm(defaults()); setModal("create"); };
  const accountRole = (account) => account?.capabilities?.includes("users:write") ? "HR Manager" : account?.capabilities?.includes("leave:approve") ? "Reporting Manager" : "Employee";
  const openEdit = (item) => { const account = userByEmployee.get(item.employee_id); const roles = [accountRole(account)]; setForm({ ...defaults(), ...item, manager_id: item.manager_id || "", schedule_id: item.work_schedule?.schedule_id || "", account_enabled: false, account_exists: Boolean(account), email: account?.email || "", roles, initial_roles: roles, password: "" }); setModal(item); };
  const copyInvitationLink = async (url) => {
    if (!url) return false;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return true;
    }
    window.prompt("Copy this one-time invitation link:", url);
    return false;
  };
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const body = { employee_number: modal === "create" ? undefined : form.employee_number, name: form.name, job_id: form.job_id, manager_id: form.manager_id || null, department_id: form.department_id, location_id: form.location_id, holiday_calendar_id: form.holiday_calendar_id, work_schedule: { schedule_id: form.schedule_id }, start_date: form.start_date, status: form.status };
    try {
      if ((modal === "create" || !form.account_exists) && form.account_enabled) body.account = { enabled: true, email: form.email, invite: true, roles: form.roles };
      else if (form.account_exists && form.roles[0] !== form.initial_roles[0]) body.account = { roles: form.roles };
      const result = modal === "create" ? await api.createDirectoryEntry(body) : await api.updateDirectoryEntry(modal.employee_id, body);
      const copied = result?.account?.invite_url ? await copyInvitationLink(result.account.invite_url) : false;
      notify(result?.account?.invite_url ? `${modal === "create" ? "Employee added" : "Employee updated"}. ${copied ? "The one-time invitation link was copied." : "Copy the one-time invitation link from the prompt."}` : modal === "create" ? "Employee added to the directory." : result?.account?.changed ? "Employee assignment and portal role updated." : body.account?.enabled ? "Employee updated and portal login created." : "Employee assignment updated."); setModal(null); if (modal?.employee_id === user?.employee_id && result?.account?.changed) onUserChange(await api.me()); else await refresh();
    } catch (error) { notify(error.message, "error"); }
    finally { setBusy(false); }
  };
  const resetPassword = async (item) => {
    if (!window.confirm(`Generate a password reset link for ${item.name}? Their current password remains active until they use the link.`)) return;
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.resetDirectoryPassword(item.employee_id);
      const copied = await copyInvitationLink(result.invite_url);
      notify(copied ? "Password reset link copied. Share it securely with the employee." : "Copy the password reset link from the prompt.");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return <div className="space-y-5"><Header title="Employee directory" detail="Tenant-scoped employees, reporting assignments, and portal access." action={<Button onClick={openCreate}>Add employee</Button>} /><FilterToolbar viewKey="directory" viewState={view} onApplyState={(next) => setView({ ...viewDefaults, ...next })} query={query} onQuery={(value) => setView({ query: value, page: "1" })} sort={sort} onSort={(value) => setView({ sort: value, page: "1" })} sortOptions={[{ value: "name", label: "Name" }, { value: "department", label: "Department" }, { value: "job", label: "Job" }, { value: "location", label: "Location" }]} resultCount={rows.length} filters={[{ id: "status", label: "Status", value: status, onChange: (value) => setView({ status: value, page: "1" }), options: [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }, { value: "all", label: "All statuses" }] }, { id: "department", label: "Department", value: department, onChange: (value) => setView({ department: value, page: "1" }), options: [{ value: "all", label: "All departments" }, ...data.departments.map((item) => ({ value: item.department_id, label: item.name }))] }, { id: "job", label: "Job", value: job, onChange: (value) => setView({ job: value, page: "1" }), options: [{ value: "all", label: "All jobs" }, ...data["job-profiles"].map((item) => ({ value: item.job_id, label: item.title }))] }, { id: "location", label: "Location", value: location, onChange: (value) => setView({ location: value, page: "1" }), options: [{ value: "all", label: "All locations" }, ...data.locations.map((item) => ({ value: item.location_id, label: item.name }))] }]} onClear={() => resetView()} />{visible.length ? <Card><CardContent className="overflow-x-auto p-0"><table className="w-full min-w-[1050px] text-left text-sm"><thead><tr className="border-b">{["Employee", "Job", "Department", "Manager", "Location", "Start date", "Login", "Status", "Actions"].map((label) => <th className="p-4" key={label}>{label}</th>)}</tr></thead><tbody>{visible.map((item) => <tr className="border-b last:border-0" key={item.employee_id}><td className="p-4"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-secondary font-bold">{initials(item.name)}</span><span><b>{item.name}</b><span className="block text-xs text-muted-foreground">{item.employee_number}</span></span></div></td><td className="p-4">{jobs.get(item.job_id)}</td><td className="p-4">{departments.get(item.department_id)}</td><td className="p-4">{managers.get(item.manager_id) || "None"}</td><td className="p-4">{locations.get(item.location_id)}</td><td className="p-4">{date(item.start_date)}</td><td className="p-4">{userByEmployee.has(item.employee_id) ? "Enabled" : "Not provisioned"}</td><td className="p-4"><Status value={item.status} /></td><td className="p-4"><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => openEdit(item)}>Edit</Button>{userByEmployee.has(item.employee_id) ? <Button size="sm" variant="outline" onClick={() => resetPassword(item)}>Reset password</Button> : null}</div></td></tr>)}</tbody></table><Pagination page={page} pageCount={pageCount} pageSize={pageSize} total={rows.length} onPage={(value) => setView({ page: String(value) })} onPageSize={(value) => setView({ pageSize: String(value), page: "1" })} /></CardContent></Card> : <Empty title="No employees match" detail="Clear the filters or add an employee." />}{modal ? <Modal title={modal === "create" ? "Add employee" : `Edit ${modal.name}`} close={() => setModal(null)}><form className="space-y-4" onSubmit={submit}><div className="grid gap-3 sm:grid-cols-2"><Field label="Employee number" value={form.employee_number} required onChange={(value) => update("employee_number", value)} /><Field label="Full name" value={form.name} required onChange={(value) => update("name", value)} /></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold">Job<select aria-label="Employee job" required value={form.job_id} onChange={(event) => update("job_id", event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-white px-3">{activeJobs.map((item) => <option value={item.job_id} key={item.job_id}>{item.title}</option>)}</select></label><label className="text-sm font-semibold">Department<select aria-label="Employee department" required value={form.department_id} onChange={(event) => update("department_id", event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-white px-3">{data.departments.map((item) => <option value={item.department_id} key={item.department_id}>{item.name}</option>)}</select></label></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold">Reporting manager<select aria-label="Reporting manager" value={form.manager_id} onChange={(event) => update("manager_id", event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-white px-3"><option value="">No manager</option>{data.employees.filter((item) => item.employee_id !== modal?.employee_id && item.status === "active").map((item) => <option value={item.employee_id} key={item.employee_id}>{item.name}</option>)}</select></label><label className="text-sm font-semibold">Location<select aria-label="Employee location" required value={form.location_id} onChange={(event) => update("location_id", event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-white px-3">{data.locations.map((item) => <option value={item.location_id} key={item.location_id}>{item.name}</option>)}</select></label></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold">Holiday calendar<select aria-label="Employee holiday calendar" required value={form.holiday_calendar_id} onChange={(event) => update("holiday_calendar_id", event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-white px-3">{data["holiday-calendars"].map((item) => <option value={item.holiday_calendar_id} key={item.holiday_calendar_id}>{item.name}</option>)}</select></label><label className="text-sm font-semibold">Work schedule<select aria-label="Work schedule" required value={form.schedule_id} onChange={(event) => update("schedule_id", event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-white px-3">{data["work-schedules"].map((item) => <option value={item.schedule_id} key={item.schedule_id}>{item.name}</option>)}</select></label></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Start date" type="date" required value={form.start_date} onChange={(value) => update("start_date", value)} /><label className="text-sm font-semibold">Status<select aria-label="Employee status" value={form.status} onChange={(event) => update("status", event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-white px-3"><option value="active">Active</option><option value="inactive">Inactive</option></select></label></div>{(modal === "create" || !form.account_exists) ? <div className="space-y-3 rounded-xl border bg-muted/30 p-4"><p className="font-semibold">Portal access</p><label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={form.account_enabled} onChange={(event) => update("account_enabled", event.target.checked)} />Create portal login and invitation link</label>{form.account_enabled ? <><Field label="Login email" type="email" required value={form.email} onChange={(value) => update("email", value)} /><label className="text-sm font-semibold">Role<select aria-label="Portal role" value={form.roles[0]} onChange={(event) => update("roles", [event.target.value])} className="mt-2 h-11 w-full rounded-lg border bg-white px-3"><option>Employee</option><option>Reporting Manager</option><option>HR Manager</option></select></label><p className="text-xs text-muted-foreground">Saving creates a one-time invitation link. No email is sent and no password is requested here.</p></> : null}</div> : form.account_exists ? <div className="space-y-3 rounded-xl border bg-muted/30 p-4"><p className="font-semibold">Portal access</p><label className="text-sm font-semibold">Role<select aria-label="Portal role" value={form.roles[0]} onChange={(event) => update("roles", [event.target.value])} className="mt-2 h-11 w-full rounded-lg border bg-white px-3"><option>Employee</option><option>Reporting Manager</option><option>HR Manager</option></select></label><p className="text-xs text-muted-foreground">Role changes take effect on the account&apos;s next request and are recorded in the audit log.</p></div> : null}<Button className="w-full" disabled={busy}>{busy ? "Saving employee…" : "Save employee"}</Button></form></Modal> : null}</div>;
}

function LegacyDirectory({ data }) {
  const [query, setQuery] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const jobs = new Map(
    data["job-profiles"].map((item) => [item.job_id, item.title]),
  );
  const departments = new Map(
    data.departments.map((item) => [item.department_id, item.name]),
  );
  const locations = new Map(
    data.locations.map((item) => [item.location_id, item.name]),
  );
  const managers = new Map(
    data.employees.map((item) => [item.employee_id, item.name]),
  );
  const rows = data.employees
    .filter(
      (item) =>
        (includeInactive || item.status === "active") &&
        `${item.name} ${item.employee_number}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="space-y-5">
      <Header
        title="Employee directory"
        detail="Tenant-scoped employees and assignments."
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field label="Search employees" value={query} onChange={setQuery} />
        </div>
        <label className="flex h-11 items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Include inactive
        </label>
      </div>
      {rows.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((item) => (
            <Card key={item.employee_id}>
              <CardContent className="flex items-center gap-4 pt-6">
                <div className="grid h-12 w-12 place-items-center rounded-xl bg-secondary font-extrabold">
                  {initials(item.name)}
                </div>
                <div>
                  <h2>{item.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    {item.employee_number} ·{" "}
                    {jobs.get(item.job_id) || item.job_id}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {departments.get(item.department_id)} ·{" "}
                    {locations.get(item.location_id)}
                  </p>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Manager: {managers.get(item.manager_id) || "None"} · Started{" "}
                    {date(item.start_date)}
                  </p>
                  <Status value={item.status} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Empty
          title="No employees match"
          detail="Clear the search or include inactive employees."
        />
      )}
    </div>
  );
}
function Jobs({ data, refresh, notify }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const departments = data.departments;
  const [form, setForm] = useState({
    title: "",
    department_id: "",
    standard_daily_mins: 480,
    standard_weekly_mins: 2400,
    is_ot_eligible: false,
    max_daily_mins: "",
    effective_from: new Date().toISOString().slice(0, 10),
  });
  useEffect(() => {
    if (departments[0] && !form.department_id)
      setForm((value) => ({
        ...value,
        department_id: departments[0].department_id,
      }));
  }, [departments, form.department_id]);
  const rows = data["job-profiles"].filter((item) =>
    (status === "all" || item.status === status) && item.title.toLowerCase().includes(query.toLowerCase()),
  );
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await api.create("job-profiles", {
        ...form,
        standard_daily_mins: Number(form.standard_daily_mins),
        standard_weekly_mins: Number(form.standard_weekly_mins),
        max_daily_mins:
          form.max_daily_mins === "" ? null : Number(form.max_daily_mins),
        effective_to: null,
        status: "active",
      });
      setModal(false);
      notify("Job profile created.");
      await refresh();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const deactivate = async (item) => {
    if (
      !window.confirm(
        `Deactivate ${item.title}? Assigned employees keep their historical job reference.`,
      )
    )
      return;
    try {
      await api.update("job-profiles", item.job_id, {
        ...item,
        status: "inactive",
      });
      notify("Job profile deactivated.");
      await refresh();
    } catch (error) {
      notify(error.message, "error");
    }
  };
  return (
    <div className="space-y-5">
      <Header
        title="Jobs and policies"
        detail="Effective-dated tenant job profiles and work limits."
        action={<Button onClick={() => setModal(true)}>Create job</Button>}
      />
      <FilterToolbar viewKey="jobs" resultCount={rows.length} query={query} onQuery={setQuery} filters={[{ label: "Status", value: status, onChange: setStatus, options: [{ value: "all", label: "All statuses" }, { value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }] }]} onClear={() => { setQuery(""); setStatus("all"); }} />
      {rows.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((item) => (
            <Card key={item.job_id}>
              <CardContent className="pt-6">
                <div className="flex justify-between gap-3">
                  <div>
                    <h2>{item.title}</h2>
                    <p className="text-sm text-muted-foreground">
                      {item.standard_daily_mins} daily ·{" "}
                      {item.standard_weekly_mins} weekly minutes
                    </p>
                  </div>
                  <Status value={item.status} />
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <p className="text-sm">
                    {item.is_ot_eligible
                      ? "Overtime eligible"
                      : "Limit exceptions only"}
                  </p>
                  {item.status === "active" && (
                    <Button variant="outline" onClick={() => deactivate(item)}>
                      Deactivate
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Empty
          title="No jobs match"
          detail="Clear the search or create a job profile."
        />
      )}
      {modal && (
        <Modal title="Create job profile" close={() => setModal(false)}>
          <form className="space-y-4" onSubmit={submit}>
            <Field
              label="Title"
              value={form.title}
              required
              onChange={(v) => setForm({ ...form, title: v })}
            />
            <label className="block text-sm font-semibold">
              Department
              <select
                aria-label="Department"
                required
                value={form.department_id}
                onChange={(e) =>
                  setForm({ ...form, department_id: e.target.value })
                }
                className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
              >
                {departments.map((item) => (
                  <option key={item.department_id} value={item.department_id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Daily minutes"
                type="number"
                min="0"
                value={form.standard_daily_mins}
                onChange={(v) => setForm({ ...form, standard_daily_mins: v })}
              />
              <Field
                label="Weekly minutes"
                type="number"
                min="0"
                value={form.standard_weekly_mins}
                onChange={(v) => setForm({ ...form, standard_weekly_mins: v })}
              />
            </div>
            <Field
              label="Maximum daily minutes"
              type="number"
              min={form.standard_daily_mins}
              value={form.max_daily_mins}
              onChange={(v) => setForm({ ...form, max_daily_mins: v })}
            />
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={form.is_ot_eligible}
                onChange={(e) =>
                  setForm({ ...form, is_ot_eligible: e.target.checked })
                }
              />
              Overtime eligible
            </label>
            <Field
              label="Effective from"
              type="date"
              value={form.effective_from}
              required
              onChange={(v) => setForm({ ...form, effective_from: v })}
            />
            <Button className="w-full" disabled={busy}>
              {busy ? "Creating job…" : "Create job"}
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Overrides({ data, refresh, notify, user }) {
  const employees = data.employees.filter((item) => item.status === "active");
  const types = data["leave-types"].filter((item) => item.status === "active");
  const [form, setForm] = useState({
    employee_id: "",
    leave_type_id: "",
    amount: "",
    effective_date: new Date().toISOString().slice(0, 10),
    reason: "",
  });
  const [timeForm, setTimeForm] = useState({
    employee_id: "",
    local_date: new Date().toISOString().slice(0, 10),
    clock_in_time: "09:00",
    clock_out_time: "",
    reason: "",
  });
  useEffect(() => {
    setForm((value) => ({
      ...value,
      employee_id: value.employee_id || employees[0]?.employee_id || "",
      leave_type_id: value.leave_type_id || types[0]?.leave_type_id || "",
    }));
  }, [employees.length, types.length]);
  const balance = data["leave-balances"].find(
    (item) =>
      item.employee_id === form.employee_id &&
      item.leave_type_id === form.leave_type_id,
  );
  const after = balance
    ? Number(balance.remaining) + Number(form.amount || 0)
    : null;
  const submit = async (e) => {
    e.preventDefault();
    if (
      !window.confirm(
        `Apply a ${form.amount} manual leave adjustment? This ledger entry is append-only.`,
      )
    )
      return;
    try {
      await api.create("leave-ledger-entries", {
        employee_id: form.employee_id,
        leave_type_id: form.leave_type_id,
        effective_date: form.effective_date,
        amount: Number(form.amount),
        entry_type: "manual_adjustment",
        source_id: `manual-${Date.now()}`,
        reason: form.reason,
        created_by: user.user_id,
        created_at: new Date().toISOString(),
      });
      notify("Manual balance adjustment applied.");
      setForm({ ...form, amount: "", reason: "" });
      await refresh();
    } catch (error) {
      notify(error.message, "error");
    }
  };
  const submitTimeOverride = async (e) => {
    e.preventDefault();
    if (!window.confirm("Apply this attendance override immediately? Any overlapping session will be voided and preserved in the audit history.")) return;
    try {
      const result = await api.createAttendanceOverride({
        employee_id: timeForm.employee_id || employees[0]?.employee_id,
        local_date: timeForm.local_date,
        clock_in_time: timeForm.clock_in_time,
        clock_out_time: timeForm.clock_out_time || null,
        reason: timeForm.reason,
      });
      notify(result.replaced_session_ids?.length ? "Attendance added and overlapping session replaced." : "Attendance added.");
      setTimeForm({ ...timeForm, clock_out_time: "", reason: "" });
      await refresh();
    } catch (error) {
      notify(error.message, "error");
    }
  };
  return (
    <div className="space-y-5">
      <Header
        title="Override controls"
        detail="Append-only leave adjustments with a required reason and balance preview."
      />
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={submit} className="grid gap-4 lg:grid-cols-2">
            <label className="text-sm font-semibold">
              Employee
              <select
                aria-label="Override employee"
                value={form.employee_id}
                onChange={(e) =>
                  setForm({ ...form, employee_id: e.target.value })
                }
                className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
              >
                {employees.map((item) => (
                  <option key={item.employee_id} value={item.employee_id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-semibold">
              Leave type
              <select
                aria-label="Override leave type"
                value={form.leave_type_id}
                onChange={(e) =>
                  setForm({ ...form, leave_type_id: e.target.value })
                }
                className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
              >
                {types.map((item) => (
                  <option key={item.leave_type_id} value={item.leave_type_id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="Signed amount"
              type="number"
              step="0.25"
              required
              value={form.amount}
              onChange={(v) => setForm({ ...form, amount: v })}
            />
            <Field
              label="Effective date"
              type="date"
              required
              value={form.effective_date}
              onChange={(v) => setForm({ ...form, effective_date: v })}
            />
            <div className="lg:col-span-2">
              <Field
                label="Required reason"
                required
                value={form.reason}
                onChange={(v) => setForm({ ...form, reason: v })}
              />
            </div>
            <div className="rounded-lg bg-muted p-4 text-sm">
              <b>Balance preview</b>
              <p className="mt-1">
                {balance
                  ? `${balance.remaining} → ${after} ${balance.unit}`
                  : "No matching balance exists"}
              </p>
            </div>
            <Button disabled={!balance || !Number(form.amount)}>
              Confirm adjustment
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Add employee time</CardTitle>
          <CardDescription>Immediately record or replace attendance for an employee. Existing overlapping sessions are voided, never deleted.</CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          <form onSubmit={submitTimeOverride} className="grid gap-4 lg:grid-cols-2">
            <label className="text-sm font-semibold">Employee<select aria-label="Attendance override employee" required value={timeForm.employee_id || employees[0]?.employee_id || ""} onChange={(e) => setTimeForm({ ...timeForm, employee_id: e.target.value })} className="mt-2 h-11 w-full rounded-lg border bg-white px-3">{employees.map((item) => <option key={item.employee_id} value={item.employee_id}>{item.name}</option>)}</select></label>
            <Field label="Date" type="date" required value={timeForm.local_date} onChange={(value) => setTimeForm({ ...timeForm, local_date: value })} />
            <Field label="Clock in" type="time" required value={timeForm.clock_in_time} onChange={(value) => setTimeForm({ ...timeForm, clock_in_time: value })} />
            <Field label="Clock out (optional)" type="time" value={timeForm.clock_out_time} onChange={(value) => setTimeForm({ ...timeForm, clock_out_time: value })} />
            <div className="lg:col-span-2"><Field label="Required reason" required value={timeForm.reason} onChange={(value) => setTimeForm({ ...timeForm, reason: value })} /></div>
            <Button className="lg:col-span-2">Apply attendance override</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function LegacyOrganizationReports({ data, tenant }) {
  const today = new Date().toISOString().slice(0, 10);
  const defaults = { preset: "payroll-timesheet", query: "", status: "all", department: "all", manager: "all", job: "all", location: "all", from: `${today.slice(0, 8)}01`, to: today, sort: "name", page: "1", pageSize: "25" };
  const [view, setView, resetView] = useDataViewState("organization-reports", defaults);
  const preset = view.preset;
  const query = view.query;
  const status = view.status;
  const department = view.department;
  const manager = view.manager;
  const job = view.job;
  const location = view.location;
  const from = view.from;
  const to = view.to;
  const sort = view.sort;
  const page = Number(view.page) || 1;
  const pageSize = Number(view.pageSize) || 25;
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setReport(await api.report(preset, { q: query, status: status === "all" ? "" : status, department_id: department === "all" ? "" : department, manager_id: manager === "all" ? "" : manager, job_id: job === "all" ? "" : job, location_id: location === "all" ? "" : location, from, to, sort, page, page_size: pageSize })); } catch (failure) { setError(failure.message); } finally { setLoading(false); }
  }, [preset, query, status, department, manager, job, location, from, to, sort, page, pageSize]);
  useEffect(() => { load(); }, [load]);
  const download = async () => { try { const result = await api.downloadCsv(`/reports/${preset}.csv?${new URLSearchParams({ q: query, status: status === "all" ? "" : status, department_id: department === "all" ? "" : department, manager_id: manager === "all" ? "" : manager, job_id: job === "all" ? "" : job, location_id: location === "all" ? "" : location, from, to, sort })}`); const link = document.createElement("a"); link.href = URL.createObjectURL(result.blob); link.download = result.filename; link.click(); URL.revokeObjectURL(link.href); } catch (failure) { setError(failure.message); } };
   const columns = preset === "payroll-timesheet" ? [["name", "Employee"], ["department_name", "Department"], ["manager_name", "Manager"], ["worked_mins", "Worked minutes"], ["overtime_mins", "Attendance OT"], ["approved_overtime_mins", "Approved OT"], ["paid_leave_units", "Paid leave"], ["unpaid_leave_units", "Unpaid leave"]] : preset === "organization-absenteeism" ? [["name", "Employee"], ["department_name", "Department"], ["absent_days", "Absent"], ["leave_days", "Approved leave"], ["incomplete_days", "Incomplete"], ["recorded_days", "Recorded days"]] : preset === "overtime-by-department" ? [["department_name", "Department"], ["employee_count", "Employees"], ["overtime_mins", "Attendance OT"], ["approved_overtime_mins", "Approved OT"], ["limit_exception_mins", "Limit exceptions"]] : [["name", "Employee"], ["department_name", "Department"], ["leave_type_name", "Leave type"], ["remaining", "Balance"], ["unit", "Unit"], ["estimated_value", "Estimated value"]];
  return <div className="space-y-5"><Header title="Organization reports" detail="Tenant-wide reporting for HR and payroll preparation. Exports include every matching row." action={<Button onClick={download} disabled={loading}>Export filtered CSV</Button>} /><div className="flex flex-wrap gap-2">{[["payroll-timesheet", "Payroll timesheet"], ["organization-absenteeism", "Absenteeism"], ["overtime-by-department", "Overtime by department"], ["leave-balance-liability", "Leave liability"]].map(([value, label]) => <Button key={value} variant={preset === value ? "secondary" : "outline"} onClick={() => { setPreset(value); setPage(1); }}>{label}</Button>)}</div><FilterToolbar query={query} onQuery={(value) => { setQuery(value); setPage(1); }} filters={[{ label: "Status", value: status, onChange: (value) => { setStatus(value); setPage(1); }, options: [{ value: "all", label: "All employee statuses" }, { value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }] }, { label: "Department", value: department, onChange: (value) => { setDepartment(value); setPage(1); }, options: [{ value: "all", label: "All departments" }, ...(tenant?.departments || []).map((item) => ({ value: item.department_id, label: item.name }))] }]} onClear={() => { setQuery(""); setStatus("all"); setDepartment("all"); setFrom(`${today.slice(0, 8)}01`); setTo(today); setPage(1); }}><div className="flex gap-2"><label className="text-sm font-semibold">From<input aria-label="Report from" type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} className="mt-2 block h-11 rounded-lg border bg-white px-3" /></label><label className="text-sm font-semibold">To<input aria-label="Report to" type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} className="mt-2 block h-11 rounded-lg border bg-white px-3" /></label></div></FilterToolbar>{loading ? <Loading /> : error ? <ErrorState message={error} retry={load} /> : <><Card><CardContent className="space-y-2 pt-6"><p className="font-semibold">{report?.title}</p><p className="text-sm text-muted-foreground">{report?.basis}</p><p className="text-xs text-muted-foreground">{report?.total || 0} matching rows · generated {dateTime(report?.generated_at)} · {report?.tenant?.timezone}</p></CardContent></Card>{report?.items?.length ? <Card><CardContent className="overflow-x-auto p-0"><table className="w-full min-w-[900px] text-left text-sm"><thead><tr className="border-b">{columns.map(([, label]) => <th className="p-4" key={label}>{label}</th>)}</tr></thead><tbody>{report.items.map((row, index) => <tr className="border-b last:border-0" key={`${row.employee_id || row.department_id}-${index}`}>{columns.map(([key]) => <td className="p-4" key={key}>{key.includes("mins") ? `${row[key] || 0} min` : key.includes("days") || key.includes("units") || key === "remaining" || key === "estimated_value" ? row[key] ?? 0 : row[key] || "—"}</td>)}</tr>)}</tbody></table><Pagination page={report.page} pageCount={report.page_count} pageSize={report.page_size} total={report.total} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} /></CardContent></Card> : <Empty title="No report rows" detail="Adjust the date range or filters." />}</>}</div>;
}

function OrganizationReports({ data, tenant }) {
  const today = new Date().toISOString().slice(0, 10);
  const defaults = {
    preset: "payroll-timesheet",
    query: "",
    status: "all",
    department: "all",
    manager: "all",
    job: "all",
    location: "all",
    month: today.slice(0, 7),
    from: `${today.slice(0, 8)}01`,
    to: today,
    sort: "name",
    page: "1",
    pageSize: "25",
  };
  const [view, setView, resetView] = useDataViewState("organization-reports", defaults);
  const { preset, query, status, department, manager, job, location, month, from, to, sort } = view;
  const page = Number(view.page) || 1;
  const pageSize = Number(view.pageSize) || 25;
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const selectedMonth = /^\d{4}-\d{2}$/.test(month || "") ? month : today.slice(0, 7);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const reportFrom = preset === "payroll-timesheet" ? `${selectedMonth}-01` : from;
      const reportTo = preset === "payroll-timesheet" ? new Date(Date.UTC(Number(selectedMonth.slice(0, 4)), Number(selectedMonth.slice(5, 7)), 0)).toISOString().slice(0, 10) : to;
      setReport(await api.report(preset, {
        q: query,
        status: status === "all" ? "" : status,
        department_id: department === "all" ? "" : department,
        manager_id: manager === "all" ? "" : manager,
        job_id: job === "all" ? "" : job,
        location_id: location === "all" ? "" : location,
        from: reportFrom,
        to: reportTo,
        sort,
        page,
        page_size: pageSize,
      }));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setLoading(false);
    }
  }, [preset, query, status, department, manager, job, location, selectedMonth, from, to, sort, page, pageSize]);
  useEffect(() => { load(); }, [load]);
  const download = async () => {
    try {
      const reportFrom = preset === "payroll-timesheet" ? `${selectedMonth}-01` : from;
      const reportTo = preset === "payroll-timesheet" ? new Date(Date.UTC(Number(selectedMonth.slice(0, 4)), Number(selectedMonth.slice(5, 7)), 0)).toISOString().slice(0, 10) : to;
      const extension = preset === "payroll-timesheet" ? "xls" : "csv";
      const result = await api.downloadCsv(`/reports/${preset}.${extension}?${new URLSearchParams({
        q: query,
        status: status === "all" ? "" : status,
        department_id: department === "all" ? "" : department,
        manager_id: manager === "all" ? "" : manager,
        job_id: job === "all" ? "" : job,
        location_id: location === "all" ? "" : location,
        ...(preset === "payroll-timesheet" ? { month: selectedMonth } : { from: reportFrom, to: reportTo }),
        sort,
      })}`);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(result.blob);
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (failure) {
      setError(failure.message);
    }
  };
  const columns = preset === "payroll-timesheet"
     ? [["name", "Employee"], ["department_name", "Department"], ["manager_name", "Manager"], ["worked_mins", "Worked minutes"], ["overtime_mins", "Attendance OT"], ["approved_overtime_mins", "Approved OT"], ["paid_leave_units", "Paid leave"], ["unpaid_leave_units", "Unpaid leave"]]
    : preset === "organization-absenteeism"
      ? [["name", "Employee"], ["department_name", "Department"], ["absent_days", "Absent"], ["leave_days", "Approved leave"], ["incomplete_days", "Incomplete"], ["recorded_days", "Recorded days"]]
      : preset === "overtime-by-department"
         ? [["department_name", "Department"], ["employee_count", "Employees"], ["overtime_mins", "Attendance OT"], ["approved_overtime_mins", "Approved OT"], ["limit_exception_mins", "Limit exceptions"]]
        : [["name", "Employee"], ["department_name", "Department"], ["leave_type_name", "Leave type"], ["remaining", "Balance"], ["unit", "Unit"], ["estimated_value", "Estimated value"]];
  const setFilter = (key, value) => setView({ [key]: value, page: "1" });
  return (
    <div className="space-y-5">
      <Header title="Organization reports" detail="Tenant-wide reporting for HR and payroll preparation. Exports include every matching row." action={<Button onClick={download} disabled={loading}>{preset === "payroll-timesheet" ? "Export monthly time logs" : "Export all filtered rows"}</Button>} />
      <div className="flex flex-wrap gap-2">
        {[["payroll-timesheet", "Payroll timesheet"], ["organization-absenteeism", "Absenteeism"], ["overtime-by-department", "Overtime by department"], ["leave-balance-liability", "Leave liability"]].map(([value, label]) => <Button key={value} variant={preset === value ? "secondary" : "outline"} onClick={() => setView({ preset: value, page: "1" })}>{label}</Button>)}
      </div>
      <FilterToolbar
        viewKey="organization-reports"
        viewState={view}
        onApplyState={(next) => setView({ ...defaults, ...next })}
        query={query}
        onQuery={(value) => setFilter("query", value)}
        sort={sort}
        onSort={(value) => setFilter("sort", value)}
        sortOptions={[{ value: "name", label: "Employee / name" }, { value: "department_name", label: "Department" }, { value: "worked_mins", label: "Worked minutes" }]}
        resultCount={report?.total || 0}
        filters={[
          { id: "status", label: "Status", value: status, onChange: (value) => setFilter("status", value), options: [{ value: "all", label: "All employee statuses" }, { value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }] },
          { id: "department", label: "Department", value: department, onChange: (value) => setFilter("department", value), options: [{ value: "all", label: "All departments" }, ...(tenant?.departments || []).map((item) => ({ value: item.department_id, label: item.name }))] },
          { id: "manager", label: "Manager", value: manager, onChange: (value) => setFilter("manager", value), options: [{ value: "all", label: "All managers" }, ...data.employees.filter((item) => item.status === "active").map((item) => ({ value: item.employee_id, label: item.name }))] },
          { id: "job", label: "Job", value: job, onChange: (value) => setFilter("job", value), options: [{ value: "all", label: "All jobs" }, ...data["job-profiles"].map((item) => ({ value: item.job_id, label: item.title }))] },
          { id: "location", label: "Location", value: location, onChange: (value) => setFilter("location", value), options: [{ value: "all", label: "All locations" }, ...data.locations.map((item) => ({ value: item.location_id, label: item.name }))] },
        ]}
        onClear={() => resetView()}
      >
        {preset === "payroll-timesheet" ? <label className="text-sm font-semibold">Month<input aria-label="Report month" type="month" value={month} onChange={(event) => setFilter("month", event.target.value)} className="mt-2 block h-11 rounded-lg border bg-white px-3" /></label> : <><label className="text-sm font-semibold">From<input aria-label="Report from" type="date" value={from} onChange={(event) => setFilter("from", event.target.value)} className="mt-2 block h-11 rounded-lg border bg-white px-3" /></label><label className="text-sm font-semibold">To<input aria-label="Report to" type="date" value={to} onChange={(event) => setFilter("to", event.target.value)} className="mt-2 block h-11 rounded-lg border bg-white px-3" /></label></>}
      </FilterToolbar>
      {loading ? <Loading /> : error ? <ErrorState message={error} retry={load} /> : <>
        <Card><CardContent className="space-y-2 pt-6"><p className="font-semibold">{report?.title}</p><p className="text-sm text-muted-foreground">{report?.basis}</p><p className="text-xs text-muted-foreground">{report?.total || 0} matching rows · generated {dateTime(report?.generated_at)} · {report?.tenant?.timezone}</p></CardContent></Card>
        {report?.items?.length ? <Card><CardContent className="overflow-x-auto p-0"><table className="w-full min-w-[900px] text-left text-sm"><thead><tr className="border-b">{columns.map(([, label]) => <th className="p-4" key={label}>{label}</th>)}</tr></thead><tbody>{report.items.map((row, index) => <tr className="border-b last:border-0" key={`${row.employee_id || row.department_id}-${index}`}>{columns.map(([key]) => <td className="p-4" key={key}>{key.includes("mins") ? `${row[key] || 0} min` : key.includes("days") || key.includes("units") || key === "remaining" || key === "estimated_value" ? row[key] ?? 0 : row[key] || "—"}</td>)}</tr>)}</tbody></table><Pagination page={report.page} pageCount={report.page_count} pageSize={report.page_size} total={report.total} onPage={(value) => setView({ page: String(value) })} onPageSize={(value) => setView({ pageSize: String(value), page: "1" })} /></CardContent></Card> : <Empty title="No report rows" detail="Adjust the date range or filters." />}
      </>}
    </div>
  );
}

function Reports({ data, tenant }) {
  const [status, setStatus] = useState("all");
  const names = new Map(
    data.employees.map((item) => [item.employee_id, item.name]),
  );
  const rows = data["attendance-summaries"].filter(
    (item) => status === "all" || item.status === status,
  );
  const exportCsv = () => {
    const escape = (value) => {
      const text = String(value ?? "");
      const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
      return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
    };
    const csv = [
      [
        "employee",
        "date",
        "worked_mins",
        "scheduled_mins",
        "overtime_mins",
        "status",
      ],
      ...rows.map((item) => [
        names.get(item.employee_id),
        item.local_date,
        item.worked_mins,
        item.scheduled_mins,
        item.overtime_mins,
        item.status,
      ]),
    ]
      .map((row) => row.map(escape).join(","))
      .join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = `attendance-${tenant?.tenant_id}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <div className="space-y-5">
      <Header
        title="Master reports"
        detail="Tenant attendance detail with stable, spreadsheet-safe CSV export."
        action={<Button onClick={exportCsv}>Export all filtered rows</Button>}
      />
      <div className="flex items-center justify-between rounded-xl border bg-white p-4">
        <label className="text-sm font-semibold">
          Attendance status
          <select
            aria-label="Report status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="ml-2 h-10 rounded-lg border bg-white px-3"
          >
            <option value="all">All</option>
            <option value="complete">Complete</option>
            <option value="below_standard">Below standard</option>
            <option value="absent">Absent</option>
          </select>
        </label>
        <p className="text-sm text-muted-foreground">
          {rows.length} rows · generated {dateTime(new Date().toISOString())}
        </p>
      </div>
      {rows.length ? (
        <Card>
          <CardContent className="overflow-x-auto pt-6">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead>
                <tr className="border-b">
                  {[
                    "Employee",
                    "Date",
                    "Worked",
                    "Scheduled",
                    "Overtime",
                    "Status",
                  ].map((label) => (
                    <th className="p-3" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr className="border-b" key={item.summary_id}>
                    <td className="p-3 font-semibold">
                      {names.get(item.employee_id)}
                    </td>
                    <td className="p-3">{date(item.local_date)}</td>
                    <td className="p-3">{item.worked_mins}</td>
                    <td className="p-3">{item.scheduled_mins}</td>
                    <td className="p-3">{item.overtime_mins}</td>
                    <td className="p-3">
                      <Status value={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : (
        <Empty
          title="No report rows"
          detail="Reset the status filter to include more attendance records."
        />
      )}
    </div>
  );
}
function Policies({ data, refresh, notify }) {
  const [modal, setModal] = useState(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const [leaveType, setLeaveType] = useState({
    name: "",
    code: "",
    unit: "days",
    is_paid: true,
    color: "#2563eb",
    description: "",
  });
  const [mapping, setMapping] = useState({
    job_id: "",
    leave_type_id: "",
    annual_allotment: 20,
    carry_over_limit: 5,
    allow_negative: false,
    allow_partial_day: true,
    effective_from: new Date().toISOString().slice(0, 10),
  });
  const type = (id) =>
    data["leave-types"].find((x) => x.leave_type_id === id)?.name || id;
  const job = (id) =>
    data["job-profiles"].find((x) => x.job_id === id)?.title || id;
  useEffect(() => {
    setMapping((value) => ({
      ...value,
      job_id: value.job_id || data["job-profiles"][0]?.job_id || "",
      leave_type_id:
        value.leave_type_id || data["leave-types"][0]?.leave_type_id || "",
    }));
  }, [data["job-profiles"].length, data["leave-types"].length]);
  const createType = async (e) => {
    e.preventDefault();
    try {
      await api.create("leave-types", {
        ...leaveType,
        description: leaveType.description || null,
        status: "active",
      });
      notify("Leave type created.");
      setModal(null);
      await refresh();
    } catch (error) {
      notify(error.message, "error");
    }
  };
  const createMapping = async (e) => {
    e.preventDefault();
    try {
      await api.create("job-leave-policies", {
        ...mapping,
        annual_allotment: Number(mapping.annual_allotment),
        carry_over_limit: Number(mapping.carry_over_limit),
        accrual_rule: { type: "monthly" },
        counting_rule: { weekends: false, holidays: false },
        request_window: { min_days: 1, max_days: 365 },
        documentation_rule: { required_after_days: 5 },
        effective_to: null,
        status: "active",
      });
      notify("Policy mapping created.");
      setModal(null);
      await refresh();
    } catch (error) {
      notify(error.message, "error");
    }
  };
  return (
    <div className="space-y-5">
      <Header
        title="Leave policies"
        detail="Current job-to-leave mappings for this tenant."
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setModal("type")}>
              New leave type
            </Button>
            <Button onClick={() => setModal("mapping")}>New mapping</Button>
          </div>
        }
      />
      <FilterToolbar viewKey="policies" resultCount={data["job-leave-policies"].length} query={query} onQuery={setQuery} filters={[{ label: "Status", value: status, onChange: setStatus, options: [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }, { value: "all", label: "All statuses" }] }]} onClear={() => { setQuery(""); setStatus("active"); }} />
      {data["job-leave-policies"].filter((item) => (status === "all" || item.status === status) && `${type(item.leave_type_id)} ${job(item.job_id)}`.toLowerCase().includes(query.toLowerCase())).length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {data["job-leave-policies"].filter((item) => (status === "all" || item.status === status) && `${type(item.leave_type_id)} ${job(item.job_id)}`.toLowerCase().includes(query.toLowerCase())).map((item) => (
            <Card key={item.policy_id}>
              <CardHeader>
                <CardTitle>{type(item.leave_type_id)}</CardTitle>
                <CardDescription>Job: {job(item.job_id)}</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3 text-sm">
                <Row label="Annual allowance" value={item.annual_allotment} />
                <Row label="Carry-over limit" value={item.carry_over_limit} />
                <Row
                  label="Negative balance"
                  value={item.allow_negative ? "Allowed" : "Not allowed"}
                />
                <Row
                  label="Partial day"
                  value={item.allow_partial_day ? "Allowed" : "Not allowed"}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Empty
          title="No policies"
          detail="No active leave policies are configured."
        />
      )}
      {modal === "type" && (
        <Modal title="Create leave type" close={() => setModal(null)}>
          <form className="space-y-4" onSubmit={createType}>
            <Field
              label="Name"
              value={leaveType.name}
              required
              onChange={(v) => setLeaveType({ ...leaveType, name: v })}
            />
            <Field
              label="Code"
              value={leaveType.code}
              required
              onChange={(v) => setLeaveType({ ...leaveType, code: v })}
            />
            <label className="block text-sm font-semibold">
              Unit
              <select
                aria-label="Leave unit"
                value={leaveType.unit}
                onChange={(e) =>
                  setLeaveType({ ...leaveType, unit: e.target.value })
                }
                className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
              >
                <option value="days">Days</option>
                <option value="hours">Hours</option>
              </select>
            </label>
            <Field
              label="Color"
              type="color"
              value={leaveType.color}
              onChange={(v) => setLeaveType({ ...leaveType, color: v })}
            />
            <Field
              label="Description"
              value={leaveType.description}
              onChange={(v) => setLeaveType({ ...leaveType, description: v })}
            />
            <label className="flex gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={leaveType.is_paid}
                onChange={(e) =>
                  setLeaveType({ ...leaveType, is_paid: e.target.checked })
                }
              />
              Paid leave
            </label>
            <Button className="w-full">Create leave type</Button>
          </form>
        </Modal>
      )}
      {modal === "mapping" && (
        <Modal title="Create policy mapping" close={() => setModal(null)}>
          <form className="space-y-4" onSubmit={createMapping}>
            <label className="block text-sm font-semibold">
              Job
              <select
                aria-label="Policy job"
                value={mapping.job_id}
                onChange={(e) =>
                  setMapping({ ...mapping, job_id: e.target.value })
                }
                className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
              >
                {data["job-profiles"]
                  .filter((item) => item.status === "active")
                  .map((item) => (
                    <option key={item.job_id} value={item.job_id}>
                      {item.title}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block text-sm font-semibold">
              Leave type
              <select
                aria-label="Policy leave type"
                value={mapping.leave_type_id}
                onChange={(e) =>
                  setMapping({ ...mapping, leave_type_id: e.target.value })
                }
                className="mt-2 h-11 w-full rounded-lg border bg-white px-3"
              >
                {data["leave-types"]
                  .filter((item) => item.status === "active")
                  .map((item) => (
                    <option key={item.leave_type_id} value={item.leave_type_id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Annual allowance"
                type="number"
                min="0"
                value={mapping.annual_allotment}
                onChange={(v) =>
                  setMapping({ ...mapping, annual_allotment: v })
                }
              />
              <Field
                label="Carry-over limit"
                type="number"
                min="0"
                value={mapping.carry_over_limit}
                onChange={(v) =>
                  setMapping({ ...mapping, carry_over_limit: v })
                }
              />
            </div>
            <label className="flex gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={mapping.allow_negative}
                onChange={(e) =>
                  setMapping({ ...mapping, allow_negative: e.target.checked })
                }
              />
              Allow negative balance
            </label>
            <label className="flex gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={mapping.allow_partial_day}
                onChange={(e) =>
                  setMapping({
                    ...mapping,
                    allow_partial_day: e.target.checked,
                  })
                }
              />
              Allow partial days
            </label>
            <Field
              label="Effective from"
              type="date"
              value={mapping.effective_from}
              required
              onChange={(v) => setMapping({ ...mapping, effective_from: v })}
            />
            <Button className="w-full">Create mapping</Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function LegacyAuditTable({ data, notify }) {
  const [query, setQuery] = useState("");
  const [action, setAction] = useState("all");
  const [target, setTarget] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const actions = [...new Set(data["audit-events"].map((item) => item.action))].sort();
  const targets = [...new Set(data["audit-events"].map((item) => item.target_type))].sort();
  const rows = data["audit-events"].filter((item) => (action === "all" || item.action === action) && (target === "all" || item.target_type === target) && `${item.action} ${item.target_type} ${item.target_id} ${item.reason || ""}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const visible = rows.slice((page - 1) * pageSize, page * pageSize);
  const exportCsv = async () => { try { const result = await api.downloadCsv(`/audit-events/export.csv?${new URLSearchParams({ q: query, action: action === "all" ? "" : action, target_type: target === "all" ? "" : target })}`); const link = document.createElement("a"); link.href = URL.createObjectURL(result.blob); link.download = result.filename; link.click(); URL.revokeObjectURL(link.href); notify("Audit CSV exported."); } catch (error) { notify(error.message, "error"); } };
  return <div className="space-y-5"><Header title="Audit events" detail="Immutable tenant activity with filtered CSV export." action={<Button onClick={exportCsv}>Export CSV</Button>} /><FilterToolbar query={query} onQuery={(value) => { setQuery(value); setPage(1); }} filters={[{ label: "Action", value: action, onChange: (value) => { setAction(value); setPage(1); }, options: [{ value: "all", label: "All actions" }, ...actions.map((value) => ({ value, label: human(value) }))] }, { label: "Target", value: target, onChange: (value) => { setTarget(value); setPage(1); }, options: [{ value: "all", label: "All targets" }, ...targets.map((value) => ({ value, label: human(value) }))] }]} onClear={() => { setQuery(""); setAction("all"); setTarget("all"); setPage(1); }} />{visible.length ? <Card><CardContent className="overflow-x-auto p-0"><table className="w-full min-w-[800px] text-left text-sm"><thead><tr className="border-b">{["Time", "Action", "Target", "Reason"].map((label) => <th className="p-4" key={label}>{label}</th>)}</tr></thead><tbody>{visible.map((item) => <tr className="border-b last:border-0" key={item.event_id}><td className="p-4">{dateTime(item.occurred_at)}</td><td className="p-4 font-semibold">{human(item.action)}</td><td className="p-4">{item.target_type} · {item.target_id}</td><td className="p-4">{item.reason || "—"}</td></tr>)}</tbody></table><Pagination page={page} pageCount={pageCount} pageSize={pageSize} total={rows.length} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} /></CardContent></Card> : <Empty title="No audit activity matches" detail="Clear the filters to see more tenant activity." />}</div>;
}

function Audit({ data, notify }) {
  const defaults = { query: "", action: "all", target: "all", actor: "all", from: "", to: "", sort: "newest", page: "1", pageSize: "25" };
  const [view, setView, resetView] = useDataViewState("audit", defaults);
  const { query, action, target, actor, from, to, sort } = view;
  const page = Number(view.page) || 1;
  const pageSize = Number(view.pageSize) || 25;
  const actions = [...new Set(data["audit-events"].map((item) => item.action))].sort();
  const targets = [...new Set(data["audit-events"].map((item) => item.target_type))].sort();
  const actors = [...new Map(data["audit-events"].filter((item) => item.actor_user_id).map((item) => [item.actor_user_id, item.actor || item.actor_user_id])).entries()];
  const rows = data["audit-events"].filter((item) => {
    const occurred = String(item.occurred_at || "").slice(0, 10);
    return (action === "all" || item.action === action) &&
      (target === "all" || item.target_type === target) &&
      (actor === "all" || item.actor_user_id === actor) &&
      (!from || occurred >= from) && (!to || occurred <= to) &&
      `${item.actor || ""} ${item.action} ${item.target_type} ${item.target_id} ${item.reason || ""}`.toLowerCase().includes(query.toLowerCase());
  }).sort((a, b) => sort === "oldest" ? String(a.occurred_at).localeCompare(String(b.occurred_at)) : String(b.occurred_at).localeCompare(String(a.occurred_at)));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const visible = rows.slice((page - 1) * pageSize, page * pageSize);
  const setFilter = (key, value) => setView({ [key]: value, page: "1" });
  const exportCsv = async () => {
    try {
      const result = await api.downloadCsv(`/audit-events/export.csv?${new URLSearchParams({ q: query, actor_user_id: actor === "all" ? "" : actor, action: action === "all" ? "" : action, target_type: target === "all" ? "" : target, from, to, direction: sort === "oldest" ? "asc" : "desc" })}`);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(result.blob);
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(link.href);
      notify(`Exported ${rows.length} filtered audit events.`);
    } catch (error) { notify(error.message, "error"); }
  };
  return (
    <div className="space-y-5">
      <Header title="Audit events" detail="Immutable tenant activity with server-safe filtered CSV export." action={<Button onClick={exportCsv}>Export all filtered events</Button>} />
      <FilterToolbar
        viewKey="audit"
        viewState={view}
        onApplyState={(next) => setView({ ...defaults, ...next })}
        query={query}
        onQuery={(value) => setFilter("query", value)}
        sort={sort}
        onSort={(value) => setFilter("sort", value)}
        sortOptions={[{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]}
        resultCount={rows.length}
        filters={[
          { id: "action", label: "Action", value: action, onChange: (value) => setFilter("action", value), options: [{ value: "all", label: "All actions" }, ...actions.map((value) => ({ value, label: human(value) }))] },
          { id: "target", label: "Target", value: target, onChange: (value) => setFilter("target", value), options: [{ value: "all", label: "All targets" }, ...targets.map((value) => ({ value, label: human(value) }))] },
          { id: "actor", label: "Actor", value: actor, onChange: (value) => setFilter("actor", value), options: [{ value: "all", label: "All actors" }, ...actors.map(([value, label]) => ({ value, label }))] },
        ]}
        onClear={() => resetView()}
      >
        <label className="text-sm font-semibold">From<input aria-label="Audit from" type="date" value={from} onChange={(event) => setFilter("from", event.target.value)} className="mt-2 block h-11 rounded-lg border bg-white px-3" /></label>
        <label className="text-sm font-semibold">To<input aria-label="Audit to" type="date" value={to} onChange={(event) => setFilter("to", event.target.value)} className="mt-2 block h-11 rounded-lg border bg-white px-3" /></label>
      </FilterToolbar>
      {visible.length ? <Card><CardContent className="overflow-x-auto p-0"><table className="w-full min-w-[900px] text-left text-sm"><thead><tr className="border-b">{["Time", "Actor", "Action", "Target", "Reason"].map((label) => <th className="p-4" key={label}>{label}</th>)}</tr></thead><tbody>{visible.map((item) => <tr className="border-b last:border-0" key={item.event_id}><td className="p-4">{dateTime(item.occurred_at)}</td><td className="p-4">{item.actor || item.actor_user_id || "System"}</td><td className="p-4 font-semibold">{human(item.action)}</td><td className="p-4">{item.target_type} · {item.target_id}</td><td className="p-4">{item.reason || "—"}</td></tr>)}</tbody></table><Pagination page={page} pageCount={pageCount} pageSize={pageSize} total={rows.length} onPage={(value) => setView({ page: String(value) })} onPageSize={(value) => setView({ pageSize: String(value), page: "1" })} /></CardContent></Card> : <Empty title="No audit activity matches" detail="Clear a filter or broaden the date range." />}
    </div>
  );
}

function VeryLegacyAudit({ data }) {
  return (
    <div className="space-y-5">
      <Header
        title="Audit events"
        detail="Immutable administrative and workflow activity."
      />
      <Card>
        <CardContent className="pt-6">
          {data["audit-events"].length ? (
            <div className="divide-y">
              {data["audit-events"].map((item) => (
                <div className="py-4" key={item.event_id}>
                  <div className="flex justify-between gap-3">
                    <b>{human(item.action)}</b>
                    <time className="text-xs text-muted-foreground">
                      {dateTime(item.occurred_at)}
                    </time>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {item.target_type} · {item.target_id}
                    {item.reason ? ` · ${item.reason}` : ""}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="No audit activity"
              detail="Workflow and administrative changes will appear here."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Header({ title, detail, action }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-[.2em] text-primary">
          Workspace
        </p>
        <h1 className="mt-1 text-3xl">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      </div>
      {action}
    </div>
  );
}

function LocalDateTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const formatted = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(now);
  return <time dateTime={now.toISOString()}>{formatted}</time>;
}

function Field({ label, onChange, error, helperText, id, className, required = false, ...props }) {
  const generatedId = useId();
  const inputId = id || `field-${generatedId.replace(/:/g, "")}`;
  if (label === "Organization ID" && window.location.hash.startsWith("#/register")) return null;
  if (label === "Employee number") return null;
  const invitePassword = label === "Temporary password";
  const contextualHelperText = helperText || (invitePassword ? "Optional: leave blank to generate a unique one-time invitation link to copy and paste." : label === "Organization name" && window.location.hash.startsWith("#/register") ? "Your workspace identifier is generated automatically." : "");
  const helperId = contextualHelperText ? `${inputId}-help` : "";
  const errorId = error ? `${inputId}-error` : "";
  const {
    ["aria-describedby"]: externalDescribedBy,
    name: explicitName,
    ...inputProps
  } = props;
  const inputName = explicitName || {
    "Organization ID": "tenant_id",
    "Organization name": "name",
    Timezone: "timezone",
    Locale: "locale",
    Currency: "currency",
    "Support email": "support_email",
    "Full name": "full_name",
    Email: "email",
  }[label];
  const describedBy = [externalDescribedBy, helperId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <label className="block text-sm font-semibold" htmlFor={inputId}>
      {label}{required && !invitePassword ? <span aria-hidden="true" className="ml-1 text-red-700">*</span> : null}
      <input
        id={inputId}
        aria-label={label}
        name={inputName}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        required={required && !invitePassword}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-2 h-11 w-full rounded-lg border bg-white px-3 outline-none focus:ring-2 ${error ? "border-red-500 focus:ring-red-500" : "focus:ring-primary"} ${className || ""}`}
        {...inputProps}
      />
      {contextualHelperText ? <p id={helperId} className="mt-1 text-xs font-normal text-muted-foreground">{contextualHelperText}</p> : null}
      {error ? <p id={errorId} role="alert" className="mt-1 text-sm font-normal text-red-700">{error}</p> : null}
    </label>
  );
}
function Row({ label, value }) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-semibold">{value ?? "—"}</p>
    </div>
  );
}

function PlatformOverviewLegacy({ onEnter, notify }) {
  const [tenants, setTenants] = useState([]);
  const [access, setAccess] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [tenantRows, accessRows] = await Promise.all([
        api.platformTenants(),
        api.platformAccess(),
      ]);
      setTenants(tenantRows);
      setAccess(accessRows);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const rows = tenants.filter(
    (tenant) =>
      (status === "all" || tenant.status === status) &&
      `${tenant.name} ${tenant.tenant_id}`.toLowerCase().includes(query.toLowerCase()),
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} retry={load} />;
  return (
    <div className="space-y-5">
      <Header title="Platform overview" detail="Global organization and access control plane." />
      <div className="grid gap-4 sm:grid-cols-3">
        <Metric value={tenants.length} label="Organizations" />
        <Metric value={tenants.filter((item) => item.status === "active").length} label="Active organizations" />
        <Metric value={access.length} label="Tenant access assignments" />
      </div>
      <Card>
        <CardHeader><CardTitle>Organizations</CardTitle><CardDescription>Enter an organization to operate its HR workspace.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <Field label="Search organizations" value={query} onChange={setQuery} />
            <label className="text-sm font-semibold">Status<select aria-label="Organization status" value={status} onChange={(event) => setStatus(event.target.value)} className="mt-2 h-11 rounded-lg border bg-white px-3"><option value="all">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
          </div>
          {rows.length ? rows.map((tenant) => (
            <div key={tenant.tenant_id} className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div><h2>{tenant.name}</h2><p className="text-sm text-muted-foreground">{tenant.tenant_id} · {tenant.active_employees} active employees · {tenant.pending_requests} pending requests</p></div>
              <div className="flex flex-wrap gap-2"><Status value={tenant.status} /><Button onClick={() => onEnter(tenant.tenant_id)}>Enter organization</Button></div>
            </div>
          )) : <Empty title="No organizations match" detail="Clear the search or status filter." />}
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">Platform actions are audited separately from tenant HR activity.</p>
    </div>
  );
}

function PlatformOverview({ onEnter, notify }) {
  const [tenants, setTenants] = useState([]);
  const [access, setAccess] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const defaults = () => ({ tenant_id: "", name: "", timezone: "Asia/Manila", locale: "en-PH", week_start: "1", currency: "PHP", support_email: "", initial_admin: { display_name: "", email: "" } });
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [tenantRows, accessRows] = await Promise.all([api.platformTenants(), api.platformAccess()]);
      setTenants(tenantRows);
      setAccess(accessRows);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  const rows = tenants.filter((tenant) => (status === "all" || tenant.status === status) && `${tenant.name} ${tenant.tenant_id}`.toLowerCase().includes(query.toLowerCase()));
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const close = () => { setModal(null); setForm(null); };
  const openCreate = () => { setForm(defaults()); setModal("create"); };
  const openEdit = (tenant) => { setForm({ ...defaults(), ...tenant, support_email: tenant.settings?.support_email || "" }); setModal("edit"); };
  const copyInvitationUrl = async (url) => {
    if (!url) return false;
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
    else window.prompt("Copy this one-time invitation link:", url);
    return true;
  };
  const save = async (event) => {
    event.preventDefault();
    // Browser autofill can update the visible input value without firing a
    // React change event. Read named controls at submit time so the API gets
    // the values the user can actually see.
    const nativeForm = new FormData(event.currentTarget);
    const nativeValue = (name, fallback = "") => {
      const value = nativeForm.get(name);
      return value === null ? fallback : String(value).trim();
    };
    const submitted = {
      ...form,
      tenant_id: nativeValue("tenant_id", form.tenant_id).toLowerCase(),
      name: nativeValue("name", form.name),
      timezone: nativeValue("timezone", form.timezone),
      locale: nativeValue("locale", form.locale),
      currency: nativeValue("currency", form.currency).toUpperCase(),
      week_start: nativeValue("week_start", String(form.week_start)),
      support_email: nativeValue("support_email", form.support_email),
      initial_admin: {
        ...form.initial_admin,
        display_name: nativeValue("full_name", form.initial_admin?.display_name),
        email: nativeValue("email", form.initial_admin?.email),
      },
    };
    setBusy(true);
    try {
      if (modal === "create") {
        const created = await api.createPlatformTenant({ ...submitted, week_start: Number(submitted.week_start), support_email: submitted.support_email || undefined });
        const copied = await copyInvitationUrl(created.invite_url);
        notify(copied ? "Organization created. Invitation link copied." : created.invitation_delivery === "sent" ? "Organization created and invitation sent." : created.invitation_delivery === "failed" ? "Organization created, but the invitation could not be delivered. Use Resend invite after checking delivery configuration." : "Organization created. Invitation delivery is not configured.");
      } else {
        await api.updatePlatformTenant(submitted.tenant_id, { name: submitted.name, timezone: submitted.timezone, locale: submitted.locale, week_start: Number(submitted.week_start), currency: submitted.currency, support_email: submitted.support_email || undefined });
        notify("Organization details updated.");
      }
      close();
      await load();
    } catch (failure) {
      notify(failure.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const changeStatus = async (tenant) => {
    const next = tenant.status === "active" ? "suspended" : "active";
    if (!window.confirm(`${next === "suspended" ? "Suspend" : "Reactivate"} ${tenant.name}?`)) return;
    try {
      await api.updatePlatformTenantStatus(tenant.tenant_id, next, `Platform administrator changed organization status to ${next}`);
      notify(`${tenant.name} is now ${next}.`);
      await load();
    } catch (failure) { notify(failure.message, "error"); }
  };
  const resend = async (tenant) => {
    try {
      const result = await api.resendPlatformInvitation(tenant.tenant_id, "Platform administrator resent the HR invitation");
      const copied = await copyInvitationUrl(result.invite_url);
      notify(copied ? "Invitation refreshed. The one-time link was copied." : result.invitation_delivery === "sent" ? "Invitation resent." : result.invitation_delivery === "failed" ? "Invitation refreshed, but delivery failed." : "Invitation refreshed; delivery is not configured.");
      await load();
    } catch (failure) { notify(failure.message, "error"); }
  };
  const copyInviteLink = async (tenant) => {
    try {
      const result = await api.generatePlatformInvitationLink(tenant.tenant_id);
      const copied = await copyInvitationUrl(result.invite_url);
      notify(copied ? "Invitation link generated and copied. Share it securely with the HR administrator." : "Invitation link generated.");
      await load();
    } catch (failure) { notify(failure.message, "error"); }
  };
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} retry={load} />;
  return <div className="space-y-5">
    <Header title="Platform overview" detail="Global organization and access control plane." action={<Button onClick={openCreate}>Create organization</Button>} />
    <div className="grid gap-4 sm:grid-cols-3"><Metric value={tenants.length} label="Organizations" /><Metric value={tenants.filter((item) => item.status === "active").length} label="Active organizations" /><Metric value={access.length} label="Tenant access assignments" /></div>
    <Card><CardHeader><CardTitle>Organizations</CardTitle><CardDescription>Create and maintain organizations here. Public registration is also available from the sign-in page.</CardDescription></CardHeader><CardContent className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row"><Field label="Search organizations" value={query} onChange={setQuery} /><label className="text-sm font-semibold">Status<select aria-label="Organization status" value={status} onChange={(event) => setStatus(event.target.value)} className="mt-2 h-11 rounded-lg border bg-white px-3"><option value="all">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option></select></label></div>
      {rows.length ? rows.map((tenant) => <div key={tenant.tenant_id} className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><h2>{tenant.name}</h2><p className="text-sm text-muted-foreground">{tenant.tenant_id} · {tenant.active_employees} active employees · {tenant.pending_requests} pending requests</p><p className="mt-1 text-xs text-muted-foreground">HR invitation: {tenant.invitation?.status ? `${human(tenant.invitation.status)}${tenant.invitation.email ? ` · ${tenant.invitation.email}` : ""}` : "Not created"}</p></div><div className="flex flex-wrap gap-2"><Status value={tenant.status} /><Button size="sm" onClick={() => onEnter(tenant.tenant_id)}>Enter organization</Button><Button size="sm" variant="outline" onClick={() => openEdit(tenant)}>Edit</Button><Button size="sm" variant="outline" onClick={() => changeStatus(tenant)}>{tenant.status === "active" ? "Suspend" : "Reactivate"}</Button>{tenant.invitation?.status !== "accepted" ? <Button size="sm" variant="outline" onClick={() => resend(tenant)}>Resend invite</Button> : null}</div></div>) : <Empty title="No organizations match" detail="Clear the search or status filter." />}
    </CardContent></Card><p className="text-sm text-muted-foreground">Platform actions are audited separately from tenant HR activity.</p>
{modal ? <Modal title={modal === "create" ? "Create organization" : `Edit ${form.name}`} close={close}><form className="space-y-4" onSubmit={save}><div className="grid gap-3 sm:grid-cols-2">{modal === "create" ? <Field label="Organization ID" required pattern="[a-z0-9][a-z0-9\-]{1,47}" value={form.tenant_id} onChange={(value) => update("tenant_id", value.toLowerCase())} /> : <Field label="Organization ID" value={form.tenant_id} disabled onChange={() => {}} />}<Field label="Organization name" required value={form.name} onChange={(value) => update("name", value)} /></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Timezone" required value={form.timezone} onChange={(value) => update("timezone", value)} /><Field label="Locale" required value={form.locale} onChange={(value) => update("locale", value)} /></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Currency" required value={form.currency} onChange={(value) => update("currency", value.toUpperCase())} /><label className="text-sm font-semibold">Week starts<select aria-label="Week starts" value={form.week_start} onChange={(event) => update("week_start", event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-white px-3"><option value="0">Sunday</option><option value="1">Monday</option><option value="6">Saturday</option></select></label></div><Field label="Support email" type="email" value={form.support_email} onChange={(value) => update("support_email", value)} />{modal === "create" ? <div className="space-y-3 rounded-xl border bg-muted/30 p-4"><p className="font-semibold">Initial HR administrator</p><Field label="Full name" required value={form.initial_admin.display_name} onChange={(value) => setForm((current) => ({ ...current, initial_admin: { ...current.initial_admin, display_name: value } }))} /><Field label="Email" type="email" required value={form.initial_admin.email} onChange={(value) => setForm((current) => ({ ...current, initial_admin: { ...current, email: value } }))} /><p className="text-xs text-muted-foreground">The administrator receives a one-time invitation link. No password is shown to the platform administrator.</p></div> : null}<Button className="w-full" disabled={busy}>{busy ? "Saving…" : "Save organization"}</Button></form></Modal> : null}
  </div>;
}

function PlatformAccess() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => { api.platformAccess().then(setRows).catch((failure) => setError(failure.message)); }, []);
  return <div className="space-y-5"><Header title="Access and roles" detail="Platform assignments and tenant workspaces." />{error ? <ErrorState message={error} retry={() => window.location.reload()} /> : <Card><CardContent className="overflow-x-auto pt-6"><table className="w-full min-w-[620px] text-left text-sm"><thead><tr className="border-b">{["Administrator","Email","Organization","Tenant role","Status"].map((label) => <th className="p-3" key={label}>{label}</th>)}</tr></thead><tbody>{rows.map((row) => <tr className="border-b" key={`${row.platform_user_id}-${row.tenant_id}`}><td className="p-3 font-semibold">{row.display_name}</td><td className="p-3">{row.email}</td><td className="p-3">{row.tenant_id}</td><td className="p-3">{row.roles?.join(", ")}</td><td className="p-3"><Status value={row.status} /></td></tr>)}</tbody></table></CardContent></Card>}</div>;
}

function PlatformAudit() {
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState("");
  useEffect(() => { api.platformAudit().then(setRows).catch(() => setRows([])); }, []);
  const filtered = rows.filter((row) => `${row.action} ${row.target_type} ${row.target_id}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="space-y-5"><Header title="Platform audit log" detail="Global organization and access changes." /><Field label="Search platform audit" value={query} onChange={setQuery} />{filtered.length ? <Card><CardContent className="p-0">{filtered.map((row) => <div className="border-b p-4 last:border-0" key={row.event_id}><p className="font-semibold">{human(row.action)}</p><p className="text-sm text-muted-foreground">{row.target_type}: {row.target_id} · {dateTime(row.occurred_at)}</p></div>)}</CardContent></Card> : <Empty title="No platform activity" detail="Global platform events will appear here." />}</div>;
}

function PlatformSettings() {
  const [rows, setRows] = useState([]);
  const [tenantId, setTenantId] = useState("");
  const [coverage, setCoverage] = useState(0);
  const [warning, setWarning] = useState(80);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api.platformSettings();
      setRows(result);
      const first = result[0];
      if (first) {
        setTenantId(first.tenant_id);
        setCoverage(Number(first.settings?.minimum_coverage || 0));
        setWarning(Number(first.settings?.overtime_warning_percent || 80));
      }
    } catch (failure) { setError(failure.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const selectTenant = (value) => {
    const row = rows.find((item) => item.tenant_id === value);
    setTenantId(value);
    setCoverage(Number(row?.settings?.minimum_coverage || 0));
    setWarning(Number(row?.settings?.overtime_warning_percent || 80));
    setSaved("");
  };
  const save = async (event) => {
    event.preventDefault();
    setError("");
    try {
      await api.updatePlatformSettings(tenantId, { minimum_coverage: coverage, overtime_warning_percent: warning }, "Platform settings updated");
      setSaved("Settings saved and audited.");
      await load();
    } catch (failure) { setError(failure.message); }
  };
  if (error && !rows.length) return <ErrorState message={error} retry={load} />;
  if (!rows.length) return <Loading />;
  return <div className="space-y-5"><Header title="Platform settings" detail="Tenant defaults and security boundaries." /><Card><CardContent className="space-y-4 pt-6 text-sm"><Row label="Data boundary" value="Platform actions require an explicit tenant context for tenant data." /><Row label="Tenant lifecycle" value="Suspended organizations remain retained for historical reporting." /><Row label="Audit" value="Organization and settings changes are recorded in the platform audit log." /><form className="grid gap-4 border-t pt-5 sm:grid-cols-3" onSubmit={save}><label className="text-sm font-semibold">Organization<select aria-label="Settings organization" value={tenantId} onChange={(event) => selectTenant(event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-white px-3">{rows.map((row) => <option key={row.tenant_id} value={row.tenant_id}>{row.name}</option>)}</select></label><Field label="Minimum coverage" type="number" min="0" value={coverage} onChange={(value) => setCoverage(Number(value))} /><Field label="Overtime warning %" type="number" min="1" max="100" value={warning} onChange={(value) => setWarning(Number(value))} /><div className="sm:col-span-3 flex flex-wrap items-center gap-3"><Button>Save settings</Button>{saved ? <span role="status" className="text-sm font-semibold text-green-700">{saved}</span> : null}{error ? <span role="alert" className="text-sm text-red-700">{error}</span> : null}</div></form></CardContent></Card></div>;
}

function OrganizationOverview({ data, onNavigate }) {
  return <div className="space-y-5"><Header title="Organization overview" detail="Tenant administration, workforce visibility, and policy health." /><div className="grid gap-4 sm:grid-cols-4"><Metric value={data.employees.filter((item) => item.status === "active").length} label="Active employees" /><Metric value={data["job-profiles"].length} label="Job profiles" /><Metric value={data["leave-requests"].length} label="Leave requests" /><Metric value={data["audit-events"].length} label="Audit events" /></div><Card><CardHeader><CardTitle>Administration workspace</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-3"><Button variant="outline" onClick={() => onNavigate("jobs")}>Jobs and policies</Button><Button variant="outline" onClick={() => onNavigate("directory")}>Directory</Button><Button variant="outline" onClick={() => onNavigate("reports")}>Reports</Button></CardContent></Card></div>;
}

function Shell({ user, data, loading, error, refresh, logout, onContextChange }) {
  const role = roleFor(user);
  const platformGlobal = user.actor_kind === "platform" && !user.active_tenant_id;
  const isHr = user.roles?.includes("HR Manager") || role === "HR Manager";
  const isManager = user.roles?.includes("Reporting Manager") || role === "Reporting Manager";
  const [page, setPage] = useState(
    () => routePageFromHash() || (platformGlobal ? "platform-overview" : "dashboard"),
  );
  const [mobile, setMobile] = useState(false);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const teamPages = new Set([
    "team-dashboard",
    "approvals",
    "whos-in",
    "team-calendar",
    "alerts",
  ]);
  const [scope, setScope] = useState(() =>
    teamPages.has(routePageFromHash()) ? "team" : "myself",
  );
  const [groups, setGroups] = useState({ workspace: true, team: true, organization: true, platform: true });
  useEffect(() => {
    document.title = `${human(page)} · Time & Leave Tracker`;
  }, [page]);
  useEffect(() => {
    if (platformGlobal && !page.startsWith("platform-")) setPage("platform-overview");
    if (!platformGlobal && page.startsWith("platform-")) setPage("dashboard");
  }, [platformGlobal, page]);
  const notify = (message, type = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };
  useEffect(() => {
    if (sessionStorage.getItem("tlt_password_reset_success") !== "1") return;
    sessionStorage.removeItem("tlt_password_reset_success");
    notify("Your password was reset successfully.");
  }, []);
  let nav = [
    ["dashboard", "Dashboard", LayoutDashboard],
    ["attendance", "Attendance", Clock3],
    ["leave", "Leave", Palmtree],
    ["holidays", "Holidays", CalendarDays],
    ["profile", "Profile", UserRound],
  ];
  if (role === "Manager" && scope === "team")
    nav = [
      ["team-dashboard", "Team dashboard", LayoutDashboard],
      ["approvals", "Approvals", ClipboardCheck],
      ["whos-in", "Who’s in", Users],
      ["team-calendar", "Team leave calendar", CalendarDays],
      ["alerts", "Reports & alerts", AlertCircle],
    ];
  if (role === "Administrator") {
    nav.splice(4, 0, ["approvals", "Approvals", ClipboardCheck]);
    nav.splice(
      5,
      0,
      ["jobs", "Jobs", ShieldCheck],
      ["directory", "Directory", Users],
      ["policies", "Policies", ShieldCheck],
      ["overrides", "Overrides", ClipboardCheck],
      ["reports", "Reports", LayoutDashboard],
      ["audit", "Audit", ShieldCheck],
    );
  }
  const navGroups = platformGlobal
    ? [{ id: "platform", label: "Platform", items: [["platform-overview", "Overview", LayoutDashboard], ["platform-access", "Access & Roles", ShieldCheck], ["platform-audit", "Audit Log", ShieldCheck], ["platform-settings", "Settings", ShieldCheck]] }]
    : [
        { id: "workspace", label: "My workspace", items: [["dashboard", "Dashboard", LayoutDashboard], ["attendance", "Attendance", Clock3], ["leave", "Leave", Palmtree], ["holidays", "Holidays", CalendarDays], ["profile", "Profile", UserRound]] },
        ...(isManager || isHr ? [{ id: "team", label: "Team", items: [["team-dashboard", "Team dashboard", LayoutDashboard], ["approvals", "Approvals", ClipboardCheck], ["whos-in", "Who’s in", Users], ["team-calendar", "Team leave calendar", CalendarDays], ["alerts", "Reports & alerts", AlertCircle]] }] : []),
        ...(isHr ? [{ id: "organization", label: "Organization", items: [["organization", "Overview", LayoutDashboard], ["departments", "Departments", Users], ["jobs", "Jobs & policies", ShieldCheck], ["directory", "Directory", Users], ["policies", "Leave policies", ShieldCheck], ["overrides", "Overrides", ClipboardCheck], ["reports", "Reports", LayoutDashboard], ["audit", "Audit", ShieldCheck]] }] : []),
      ];
  const employee =
    data.employees.find((item) => item.employee_id === user.employee_id) ||
    data.employees[0];
  const tenant = data.tenants[0];
  const canClock = user.capabilities.includes("attendance:write");
  const canRequestLeave = user.capabilities.includes("leave:write");
  const clock = async () => {
    setBusy(true);
    try {
      const open = data["attendance-sessions"].find(
        (item) =>
          item.employee_id === employee.employee_id && item.status === "open",
      );
      await api.transition(
        `/attendance-sessions/${open ? "clock-out" : "clock-in"}`,
      );
      notify(open ? "Clocked out successfully." : "Clocked in successfully.");
      await refresh();
    } catch (e) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const choose = (value) => {
    setPage(value);
    setMobile(false);
    window.location.hash = `/app/${value}`;
  };
  const enterTenant = async (tenantId) => {
    try {
      const next = await api.context(tenantId);
      onContextChange(next);
      window.location.hash = "/app/dashboard";
    } catch (failure) {
      notify(failure.message, "error");
    }
  };
  const exitTenant = async () => {
    try {
      const next = await api.context(null);
      onContextChange(next);
      window.location.hash = "/app/platform-overview";
    } catch (failure) {
      notify(failure.message, "error");
    }
  };
  let content;
  if (loading) content = <Loading />;
  else if (error) content = <ErrorState message={error} retry={refresh} />;
  else if (platformGlobal && page === "platform-overview")
    content = <PlatformOverview onEnter={enterTenant} notify={notify} />;
  else if (platformGlobal && page === "platform-access") content = <PlatformAccess />;
  else if (platformGlobal && page === "platform-audit") content = <PlatformAudit />;
  else if (platformGlobal && page === "platform-settings") content = <PlatformSettings />;
  else if (platformGlobal)
    content = <Empty title="Platform view unavailable" detail="Choose a platform workspace from the navigation." />;
  else if (page === "dashboard")
    content = (
      <Dashboard
        data={data}
        employee={employee}
        onNavigate={choose}
        onClock={clock}
        busy={busy}
        canClock={canClock}
        tenant={tenant}
      />
    );
  else if (page === "attendance")
    content = (
      <Attendance
        data={data}
        employee={employee}
        refresh={refresh}
        notify={notify}
        canWrite={canClock}
        canRequestOvertime={user.capabilities.includes("overtime-requests:write")}
        tenant={tenant}
      />
    );
  else if (page === "leave")
    content = (
      <Leave
        data={data}
        employee={employee}
        refresh={refresh}
        notify={notify}
        canWrite={canRequestLeave}
      />
    );
  else if (page === "holidays")
    content = (
      <Holidays
        data={data}
        canManage={isHr}
        refresh={refresh}
        notify={notify}
      />
    );
  else if (page === "profile")
    content = <Profile user={user} employee={employee} tenant={tenant} notify={notify} />;
  else if (page === "organization") content = <OrganizationOverview data={data} onNavigate={choose} />;
  else if (page === "approvals")
    content = <Approvals data={data} refresh={refresh} notify={notify} />;
  else if (page === "team-dashboard")
    content = <TeamDashboard data={data} user={user} onNavigate={choose} />;
  else if (page === "whos-in") content = <WhosIn data={data} user={user} />;
  else if (page === "team-calendar")
    content = <TeamCalendar data={data} user={user} />;
  else if (page === "alerts") content = <TeamReports data={data} user={user} tenant={tenant} />;
  else if (page === "jobs")
    content = <Jobs data={data} refresh={refresh} notify={notify} />;
  else if (page === "departments") content = <Departments data={data} refresh={refresh} notify={notify} />;
  else if (page === "directory") content = <Directory data={data} refresh={refresh} notify={notify} user={user} onUserChange={onContextChange} />;
  else if (page === "policies")
    content = <Policies data={data} refresh={refresh} notify={notify} />;
  else if (page === "overrides")
    content = (
      <Overrides data={data} refresh={refresh} notify={notify} user={user} />
    );
  else if (page === "reports")
    content = <OrganizationReports data={data} tenant={{ ...tenant, departments: data.departments }} />;
  else content = <Audit data={data} notify={notify} />;
  return (
    <div className="min-h-screen bg-[#fffaf2]">
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col overflow-hidden border-r bg-[#2a120c] p-5 text-white transition-transform lg:translate-x-0 ${mobile ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary font-bold">
              TL
            </div>
            <div>
              <b>Time & Leave</b>
              <p className="text-xs text-orange-100/60">{role}</p>
            </div>
          </div>
          <button
            className="lg:hidden"
            onClick={() => setMobile(false)}
            aria-label="Close navigation"
          >
            <X />
          </button>
        </div>
        <nav className="mt-8 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1" aria-label="Primary navigation">
          {navGroups.map((group) => (
            <section key={group.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between px-2 pb-1 text-left text-[10px] font-bold uppercase tracking-[.16em] text-orange-100/60"
                aria-expanded={groups[group.id]}
                onClick={() => setGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}
              >
                {group.label}<span aria-hidden="true">{groups[group.id] ? "−" : "+"}</span>
              </button>
              {groups[group.id] && <div className="space-y-1">
                {group.items.map(([id, label, Icon]) => (
                  <button
                    key={id}
                    onClick={() => choose(id)}
                    className={`flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold transition ${page === id ? "bg-primary !text-white" : "text-orange-50/75 hover:bg-white/10 hover:text-white"}`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className={`truncate ${page === id ? "!text-white" : ""}`}>{label}</span>
                  </button>
                ))}
              </div>}
            </section>
          ))}
        </nav>
        <div className="mt-4 shrink-0 rounded-xl border border-white/10 bg-white/5 p-3">
          <p className="truncate font-semibold">{user.display_name}</p>
          <p className="truncate text-xs text-orange-100/60">{user.email}</p>
          <button
            onClick={logout}
            className="mt-3 flex items-center gap-2 text-sm font-semibold text-orange-100 hover:text-white"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>
      {mobile && (
        <button
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setMobile(false)}
          aria-label="Close navigation overlay"
        />
      )}
      <div className="lg:pl-72">
        <header className="sticky top-0 z-20 flex min-w-0 h-16 items-center justify-between gap-3 border-b bg-[#fffaf2]/90 px-4 backdrop-blur sm:px-7">
          <button
            className="lg:hidden"
            onClick={() => setMobile(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </button>
          <div className="hidden sm:block">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              {tenant?.name || "Organization"}
            </p>
          </div>
          <div className="shrink-0 text-right text-[11px] font-semibold text-muted-foreground sm:text-sm" aria-label="Current local date and time">
            <LocalDateTime />
          </div>
          {user.actor_kind === "platform" && user.active_tenant_id && <Button variant="outline" size="sm" onClick={exitTenant}>Exit organization</Button>}
          {(isManager || isHr) && !platformGlobal && (
            <div
              className="flex rounded-lg border bg-white p-1"
              aria-label="Current scope"
            >
              <button
                aria-pressed={scope === "myself"}
                onClick={() => {
                  setScope("myself");
                  choose("dashboard");
                }}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold ${scope === "myself" ? "bg-primary text-white" : "text-muted-foreground"}`}
              >
                Myself
              </button>
              <button
                aria-pressed={scope === "team"}
                onClick={() => {
                  setScope("team");
                  choose("team-dashboard");
                }}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold ${scope === "team" ? "bg-primary text-white" : "text-muted-foreground"}`}
              >
                Team
              </button>
              {isHr && <button
                aria-pressed={scope === "organization"}
                onClick={() => {
                  setScope("organization");
                  choose("organization");
                }}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold ${scope === "organization" ? "bg-primary text-white" : "text-muted-foreground"}`}
              >
                Organization
              </button>}
            </div>
          )}
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-bold">{user.display_name}</p>
              <p className="text-xs text-muted-foreground">{role}</p>
            </div>
            <div className="grid h-9 w-9 place-items-center rounded-full bg-secondary text-sm font-bold">
              {initials(user.display_name)}
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl p-4 sm:p-7 lg:p-9">{content}</main>
      </div>
      {toast && (
        <div
          role={toast.type === "error" ? "alert" : "status"}
          className={`fixed bottom-5 right-5 z-[60] max-w-sm rounded-xl px-4 py-3 text-sm font-semibold shadow-xl ${toast.type === "error" ? "bg-red-700 text-white" : "bg-[#2a120c] text-white"}`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

function InvitationAccept({ onLogin, passwordReset = false }) {
  const token = new URLSearchParams(window.location.hash.split("?")[1] || "").get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (password !== confirm) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const account = await api.acceptInvitation(token, password);
      localStorage.setItem("tlt_has_session", "1");
      if (passwordReset) sessionStorage.setItem("tlt_password_reset_success", "1");
      onLogin(account);
      window.location.hash = "/app/dashboard";
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const title = passwordReset ? "Reset your password" : "Set up your account";
  const detail = passwordReset ? "Choose a new password for your account." : "Create a password to activate your account.";
  const action = passwordReset ? "Reset password" : "Activate account";
  return <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#fff8ed] p-5"><Card className="relative w-full max-w-md border-orange-200/70 shadow-2xl shadow-orange-950/10"><CardHeader><div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-xl bg-primary font-bold text-white">TL</div><div><p className="text-sm font-semibold text-primary">OPG Workforce</p><p className="text-xs text-muted-foreground">{passwordReset ? "Password reset" : "Organization invitation"}</p></div></div><div><h1 className="text-3xl">{title}</h1><CardDescription className="mt-2">{detail}</CardDescription></div></CardHeader><CardContent><form className="space-y-4" onSubmit={submit}>{!token ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">This {passwordReset ? "password reset" : "invitation"} link is missing its token.</p> : null}<Field label="Password" type="password" minLength="12" required value={password} onChange={setPassword} /><Field label="Confirm password" type="password" minLength="12" required value={confirm} onChange={setConfirm} />{error ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}<Button className="w-full" disabled={busy || !token}>{busy ? (passwordReset ? "Resetting…" : "Activating…") : action}</Button></form></CardContent></Card></main>;
}

function App() {
  const [user, setUser] = useState(null);
  const [hash, setHash] = useState(() => window.location.hash);
  const [checking, setChecking] = useState(true);
  const [data, setData] = useState(emptyData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!user) return;
    if (user.actor_kind === "platform" && !user.active_tenant_id) {
      setData(emptyData);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const selectedResources = user.capabilities.includes("users:write")
        ? resourceNames
        : employeeResources;
      const values = await Promise.all([
        ...selectedResources.map((name) => api.list(name)),
        api.myJobProfile(),
      ]);
      setData({
        ...emptyData,
        ...Object.fromEntries(
          selectedResources.map((name, index) => [name, values[index]]),
        ),
        "job-profile": values[selectedResources.length],
      });
    } catch (failure) {
      if (failure.status === 401) {
        setUser(null);
      } else setError(failure.message);
    } finally {
      setLoading(false);
    }
  }, [user]);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => {
    if (!localStorage.getItem("tlt_has_session")) {
      setChecking(false);
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => {
        localStorage.removeItem("tlt_has_session");
        setUser(null);
      })
      .finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (user) refresh();
  }, [user, refresh]);
  useEffect(() => {
    const expired = () => {
      localStorage.removeItem("tlt_has_session");
      setUser(null);
      setData(emptyData);
    };
    window.addEventListener("tlt:unauthorized", expired);
    return () => window.removeEventListener("tlt:unauthorized", expired);
  }, []);
  const logout = async () => {
    try {
      await api.logout();
    } finally {
      localStorage.removeItem("tlt_has_session");
      setUser(null);
      setData(emptyData);
      window.location.hash = "/login";
    }
  };
  if (checking)
    return (
      <main className="grid min-h-screen place-items-center bg-[#fff8ed]">
        <div className="text-center">
          <h1 className="sr-only">Restoring secure session</h1>
          <RefreshCw className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-3 text-sm font-semibold">
            Restoring secure session…
          </p>
        </div>
      </main>
    );
  const isInvitationRoute = hash.startsWith("#/accept-invitation");
  const isPasswordResetRoute = hash.startsWith("#/reset-password");
  const isRegistrationRoute = hash.startsWith("#/register");
  return isPasswordResetRoute ? (
    <InvitationAccept onLogin={setUser} passwordReset />
  ) : user ? (
    <Shell
      user={user}
      data={data}
      loading={loading}
      error={error}
      refresh={refresh}
      logout={logout}
      onContextChange={setUser}
    />
  ) : isRegistrationRoute ? (
    <TenantRegistration onLogin={setUser} />
  ) : isInvitationRoute ? (
    <InvitationAccept onLogin={setUser} />
  ) : (
    <Login onLogin={setUser} />
  );
}

const root =
  globalThis.__timeLeaveTrackerRoot ||
  createRoot(document.getElementById("root"));
globalThis.__timeLeaveTrackerRoot = root;
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
