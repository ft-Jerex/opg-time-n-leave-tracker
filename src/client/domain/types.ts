export type JsonObject = Record<string, unknown>;
export type EntityStatus = "active" | "inactive";
export type RequestStatus =
  "draft" | "pending" | "approved" | "rejected" | "withdrawn" | "cancelled";

export interface Tenant {
  tenant_id: string;
  name: string;
  timezone: string;
  locale: string;
  week_start: number;
  currency: string;
  settings: JsonObject;
}
export interface User {
  user_id: string;
  tenant_id: string | null;
  employee_id: string | null;
  display_name: string;
  email: string;
  capabilities: string[];
  status: EntityStatus;
}
export interface Employee {
  employee_id: string;
  tenant_id: string;
  employee_number: string;
  name: string;
  job_id: string;
  manager_id: string | null;
  department_id: string;
  location_id: string;
  holiday_calendar_id: string;
  work_schedule: JsonObject;
  start_date: string;
  status: EntityStatus;
}
export interface Department {
  department_id: string;
  tenant_id: string;
  name: string;
  code: string;
  status: EntityStatus;
}
export interface Location {
  location_id: string;
  tenant_id: string;
  name: string;
  timezone: string;
  holiday_calendar_id: string;
  status: EntityStatus;
}
export interface WorkSchedule {
  schedule_id: string;
  tenant_id: string;
  name: string;
  weekday_rules: JsonObject;
  effective_from: string;
  effective_to: string | null;
  status: EntityStatus;
}
export interface JobProfile {
  job_id: string;
  tenant_id: string;
  title: string;
  department_id: string;
  standard_daily_mins: number;
  standard_weekly_mins: number;
  is_ot_eligible: boolean;
  max_daily_mins: number | null;
  effective_from: string;
  effective_to: string | null;
  status: EntityStatus;
}
export interface AttendanceSession {
  session_id: string;
  tenant_id: string;
  employee_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  source: "responsive_web" | "attendance_adjustment" | "hr_bulk_override";
  status: "open" | "closed" | "voided";
  version: number;
}
export interface AttendanceSummary {
  summary_id: string;
  tenant_id: string;
  employee_id: string;
  local_date: string;
  worked_mins: number;
  scheduled_mins: number;
  overtime_mins: number;
  status:
    | "complete"
    | "below_standard"
    | "missing_punch"
    | "absent"
    | "leave"
    | "holiday"
    | "non_working"
    | "future"
    | "pending_adjustment";
  exception_codes: string[];
  effective_job_id: string;
}
export interface AttendanceAdjustment {
  adjustment_id: string;
  tenant_id: string;
  employee_id: string;
  local_date: string;
  original: JsonObject;
  proposed: JsonObject;
  reason: string;
  attachment_ids: string[];
  status: RequestStatus;
  submitted_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  version: number;
}
export interface LeaveType {
  leave_type_id: string;
  tenant_id: string;
  name: string;
  code: string;
  unit: "days" | "hours";
  is_paid: boolean;
  color: string;
  description: string | null;
  status: EntityStatus;
}
export interface JobLeavePolicy {
  policy_id: string;
  tenant_id: string;
  job_id: string;
  leave_type_id: string;
  annual_allotment: number;
  accrual_rule: JsonObject;
  carry_over_limit: number;
  allow_negative: boolean;
  allow_partial_day: boolean;
  counting_rule: JsonObject;
  request_window: JsonObject;
  documentation_rule: JsonObject;
  effective_from: string;
  effective_to: string | null;
  status: EntityStatus;
}
export interface LeaveBalance {
  balance_id: string;
  tenant_id: string;
  employee_id: string;
  leave_type_id: string;
  period: string;
  accrued: number;
  carried_over: number;
  manual_adjustments: number;
  used: number;
  pending: number;
  remaining: number;
  unit: "days" | "hours";
  as_of: string;
}
export interface LeaveOption {
  policy_id: string;
  leave_type_id: string;
  name: string;
  code: string;
  unit: "days" | "hours";
  is_paid: boolean;
  color: string;
  description: string | null;
  annual_allotment: number;
  accrual_rule: JsonObject;
  carry_over_limit: number;
  allow_negative: boolean;
  allow_partial_day: boolean;
  balance_id: string | null;
  period: string | null;
  accrued: number;
  carried_over: number;
  manual_adjustments: number;
  used: number;
  pending: number;
  remaining: number;
  available: number;
  as_of: string | null;
}
export interface LeaveLedgerEntry {
  entry_id: string;
  tenant_id: string;
  employee_id: string;
  leave_type_id: string;
  effective_date: string;
  amount: number;
  entry_type:
    | "accrual"
    | "carry_over"
    | "usage"
    | "reversal"
    | "manual_adjustment"
    | "expiry";
  source_id: string;
  reason: string;
  created_by: string;
  created_at: string;
}
export interface LeaveRequest {
  request_id: string;
  tenant_id: string;
  employee_id: string;
  leave_type_id: string;
  start_date: string;
  end_date: string;
  partial_day: "none" | "start_half" | "end_half" | "custom_hours";
  partial_start_time: string | null;
  partial_end_time: string | null;
  partial_minutes: number | null;
  chargeable_amount: number;
  reason: string;
  attachment_ids: string[];
  status: RequestStatus;
  approver_id: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  decision_note: string | null;
  version: number;
}
export interface OvertimeRequest {
  overtime_request_id: string;
  tenant_id: string;
  employee_id: string;
  local_date: string;
  start_time: string;
  end_time: string;
  requested_mins: number;
  reason: string;
  status: RequestStatus;
  approver_id: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  decision_note: string | null;
  version: number;
  created_at: string;
}
export interface Attachment {
  attachment_id: string;
  tenant_id: string;
  owner_type: string;
  owner_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  mock_url: string;
  validation_status: "pending" | "accepted" | "rejected";
}
export interface HolidayCalendar {
  holiday_calendar_id: string;
  tenant_id: string;
  name: string;
  location_ids: string[];
  status: EntityStatus;
}
export interface Holiday {
  holiday_id: string;
  tenant_id: string;
  holiday_calendar_id: string;
  name: string;
  local_date: string;
  observance_type: "public" | "company" | "optional";
  description: string | null;
  status: EntityStatus;
}
export interface Alert {
  alert_id: string;
  tenant_id: string;
  employee_id: string;
  type: string;
  severity: "info" | "warning" | "critical";
  period_start: string;
  period_end: string;
  current_mins: number;
  threshold_mins: number;
  created_at: string;
  status: "open" | "acknowledged" | "resolved";
}
export interface AuditEvent {
  event_id: string;
  tenant_id: string;
  actor_user_id: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string;
  occurred_at: string;
  reason: string | null;
  metadata: JsonObject;
}

export interface EntityMap {
  tenants: Tenant;
  users: User;
  employees: Employee;
  departments: Department;
  locations: Location;
  "work-schedules": WorkSchedule;
  "job-profiles": JobProfile;
  "attendance-sessions": AttendanceSession;
  "attendance-summaries": AttendanceSummary;
  "attendance-adjustments": AttendanceAdjustment;
  "leave-types": LeaveType;
  "job-leave-policies": JobLeavePolicy;
  "leave-balances": LeaveBalance;
  "leave-ledger-entries": LeaveLedgerEntry;
  "leave-requests": LeaveRequest;
  "overtime-requests": OvertimeRequest;
  attachments: Attachment;
  "holiday-calendars": HolidayCalendar;
  holidays: Holiday;
  alerts: Alert;
  "audit-events": AuditEvent;
}
