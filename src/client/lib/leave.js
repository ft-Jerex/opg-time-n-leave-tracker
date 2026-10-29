const leaveAmountFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export {
  DAY_LEAVE_CREDITS_PER_HOUR,
  partialLeaveCharge,
} from "../../shared/leave.js";

export const formatLeaveAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? leaveAmountFormatter.format(amount) : "—";
};
