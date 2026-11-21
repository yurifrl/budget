/**
 * Category target engine — pure functions for the plan-screen funding
 * targets (syscd-app-nc5). Weekly / Monthly / Yearly / Custom, mirroring the
 * YNAB target model at docs/ynab-ref/target-*.png:
 *
 *  - weekly:  "Set aside R$X every week"; the month's need is the per-week
 *             amount times the number of target weekdays in the month
 *             (4-5 turns), anchored on `config.dayOfWeek`.
 *  - monthly: "Set aside R$X monthly"; the full amount every month on/after
 *             `config.fromMonth`, repeated every `config.repeatEvery` months.
 *  - yearly:  "Set aside R$X by <month/day>"; split evenly across the months
 *             from now until the due month (per-month need grows as the due
 *             month approaches), 0 once the due month has passed.
 *  - custom:  "Set aside R$X by <date>", repeat every N <unit>; the month's
 *             need is the amount split across the repeat window while the
 *             due date is current or future, then 0.
 *
 * SHARED CONTRACT: the plan-screen indicator and the target sheet both read
 * `neededBy` / `suggestedToAssign` from here; the persistence layer stores
 * `CategoryTargetConfig` as the `category_targets.config` JSONB.
 */
import type { Cents, CategoryTarget, MonthKey } from "./types";
import { daysInMonth, makeMonth, splitMonth } from "./format";
import { t } from "./i18n";

/** Weekday (0=Sunday) of the month identified by `key`, day 1. */
function firstWeekdayOfMonth(key: MonthKey): number {
  const { year, month } = splitMonth(key);
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}

/** Number of days in the month identified by `key`. */
function daysInMonthKey(key: MonthKey): number {
  const { year, month } = splitMonth(key);
  return daysInMonth(year, month);
}

/** Clamp `day` into 1..daysInMonth(`key`) so due days like 31 never overflow. */
function clampDay(day: number, key: MonthKey): number {
  return Math.min(Math.max(day, 1), daysInMonthKey(key));
}

/**
 * Count of `anchor` weekdays (0=Sunday) falling inside the month identified
 * by `key` — how many times a weekly target "turns over" that month.
 */
function weeklyTurns(key: MonthKey, anchor: number): number {
  const firstHit = ((anchor - firstWeekdayOfMonth(key) + 7) % 7) + 1;
  const days = daysInMonthKey(key);
  if (firstHit > days) return 0;
  return Math.floor((days - firstHit) / 7) + 1;
}

/** True when the ISO date's month is the given month or later. */
function dueNotPassed(iso: string, month: MonthKey): boolean {
  const [y, m] = iso.split("-").map(Number);
  return makeMonth(y, m) >= month;
}

/**
 * Cents the category needs assigned in `month` to stay on-track for its
 * target. 0 without a target, in a snoozed month (syscd-app-hsjm), or after
 * a custom target's due month.
 */
export function neededBy(target: CategoryTarget, month: MonthKey): Cents {
  const { year } = splitMonth(month);
  if (target.snoozeMonth === month) return 0;
  switch (target.kind) {
    case "weekly": {
      const every = Math.max(1, target.config.repeatEvery ?? 1);
      const anchor = target.config.dayOfWeek ?? 1;
      const turns = weeklyTurns(month, anchor) / every;
      return Math.round(target.amountCents * Math.max(0, turns));
    }
    case "monthly": {
      const from = target.config.fromMonth;
      if (from === undefined) return target.amountCents;
      if (month < from) return 0;
      const every = Math.max(1, target.config.repeatEvery ?? 1);
      return (month - from) % every === 0 ? target.amountCents : 0;
    }
    case "yearly": {
      const dueMonth = makeMonth(year, target.config.monthOfYear ?? 12);
      if (month > dueMonth) return 0;
      const monthsUntil = dueMonth - month + 1;
      return Math.round(target.amountCents / monthsUntil);
    }
    case "custom": {
      const byDate = target.config.byDate;
      if (!byDate || !dueNotPassed(byDate, month)) return 0;
      const [y, m] = byDate.split("-").map(Number);
      const dueMonth = makeMonth(y, m);
      const from = target.config.fromMonth;
      if (from !== undefined && month < from) return 0;
      // One-time "set aside R$X by <date>" created in `fromMonth` spreads the
      // amount over every month from the start to the due month (inclusive);
      // without a start month it is the full amount every month until the
      // due date (refill-style).
      const span = from === undefined ? 1 : Math.max(1, dueMonth - from + 1);
      return Math.round(target.amountCents / span);
    }
  }
}

/** Day-of-month the target is due on, clamped to `month`'s length. */
export function targetDueDay(target: CategoryTarget, month: MonthKey): number {
  if (target.kind === "custom" && target.config.byDate) {
    const [, , d] = target.config.byDate.split("-").map(Number);
    return d;
  }
  const defaultDay = target.kind === "weekly" ? 1 : target.config.dayOfMonth ?? 1;
  return clampDay(defaultDay, month);
}

/**
 * Cents to assign THIS month: the on-track need minus what is already
 * assigned, clamped to what is actually available to assign.
 */
export function suggestedToAssign(
  target: CategoryTarget,
  month: MonthKey,
  alreadyAssigned: Cents,
  available: Cents,
): Cents {
  const need = neededBy(target, month);
  return Math.max(0, Math.min(need - alreadyAssigned, available));
}

/** Short badge for plan rows: "Funded" or "R$X more ate <due>". */
export function targetBadge(
  target: CategoryTarget,
  month: MonthKey,
  assigned: Cents,
): { state: "funded" | "needed"; more: Cents; byLabel: string | null } {
  const need = neededBy(target, month);
  if (need > 0 && assigned >= need) {
    return { state: "funded", more: 0, byLabel: null };
  }
  let byLabel: string | null = null;
  const { year } = splitMonth(month);
  switch (target.kind) {
    case "weekly":
      byLabel = t('target.perWeek');
      break;
    case "monthly":
      byLabel = t('target.perMonth');
      break;
    case "yearly": {
      const due = makeMonth(year, target.config.monthOfYear ?? 12);
      const day = clampDay(target.config.dayOfMonth ?? 1, due);
      byLabel = t('target.byDate', { date: `${day}/${due % 100}` });
      break;
    }
    case "custom":
      if (target.config.byDate) byLabel = t('target.byDate', { date: target.config.byDate.split("-").reverse().join("/") });
      break;
  }
  return { state: "needed", more: Math.max(0, need - assigned), byLabel };
}
