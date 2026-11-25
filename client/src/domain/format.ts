/**
 * Localized formatting helpers: pt-BR (R$), DD/MM/YYYY, decimal comma by
 * default, or whatever the user's format prefs say.
 *
 * Pure: every formatter takes the prefs (and the Hide Amounts mask)
 * explicitly. Components get a bound `MoneyFormat` from
 * `useMoneyFormat()` (prefs live in the budgetUi redux slice); non-React
 * callers receive one as an argument. Money is integer cents everywhere (see
 * types.ts).
 */

import { tCommon } from "@shared/i18n/common";

import { localToday } from "./date";
import type { Cents, MonthKey } from "./types";
import { DEFAULT_FMT_PREFS, type FmtCurrency, type FmtNumberLocale, type FmtPrefs } from "./fmtPrefs";

/** Placeholder shown instead of any amount while the Hide Amounts mask is on. */
export const MONEY_MASK_TEXT = "••••••";

/** One cached formatter per locale — Intl construction is expensive. */
const numberFormatters = new Map<string, Intl.NumberFormat>();
function numberFormatter(locale: string): Intl.NumberFormat {
  let fmt = numberFormatters.get(locale);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    numberFormatters.set(locale, fmt);
  }
  return fmt;
}

const CURRENCY_SYMBOLS: Record<FmtCurrency, string> = { BRL: "R$", USD: "US$" };

/**
 * Format integer cents as "R$1.314,51" — or per the Settings panel's
 * money-format prefs (currency, placement, number locale). Sign stays before
 * the symbol ("-R$\u00a04.453,69") in every placement.
 */
export function formatMoneyWith(prefs: FmtPrefs, cents: Cents, masked = false): string {
  if (masked) return MONEY_MASK_TEXT;
  const sign = cents < 0 ? "-" : "";
  const amount = numberFormatter(prefs.numberLocale).format(Math.abs(cents) / 100);
  if (prefs.currencyPlacement === "hidden") return sign + amount;
  const symbol = CURRENCY_SYMBOLS[prefs.currency];
  const body =
    prefs.currencyPlacement === "after"
      ? `${amount}\u00a0${symbol}`
      : `${symbol}\u00a0${amount}`;
  return sign + body;
}

/**
 * Format integer cents without the currency symbol: "1.314,51".
 * Useful inside inputs / tight columns.
 */
export function formatAmountWith(prefs: Pick<FmtPrefs, "numberLocale">, cents: Cents, masked = false): string {
  if (masked) return MONEY_MASK_TEXT;
  return numberFormatter(prefs.numberLocale).format(cents / 100);
}

/**
 * Parse a money string written in `locale`'s number format into integer
 * cents — the inverse of `formatAmount` / `formatMoneyWith` for that locale.
 * Accepts currency symbols ("R$", "US$", "$"), spaces/nbsp and U+2212 minus.
 * Returns 0 for unparseable input.
 *
 * pt-BR: "." thousands, "," decimal ("1.314,51"); en-US: the reverse
 * ("1,314.51"). Lenient typing habits are kept for both: the opposite
 * separator is read as a decimal when it appears once with <=2 trailing
 * digits ("1314.51" in pt-BR, "1314,5" in en-US), else as thousands ("1.314").
 */
export function parseMoneyWith(locale: FmtNumberLocale, input: string): Cents {
  if (!input) return 0;
  let s = input.replace(/US\$/gi, "").replace(/[R$\s\u00a0]/g, "").trim();
  // Some keyboards / pasted text use the typographic minus (U+2212); Number()
  // rejects it and would silently zero a signed outflow draft.
  s = s.replace(/\u2212/g, "-");
  if (!s) return 0;
  const decimal = locale === "en-US" ? "." : ",";
  const thousands = locale === "en-US" ? "," : ".";
  if (s.includes(decimal)) {
    s = s.split(thousands).join("").replace(decimal, ".");
  } else if (s.includes(thousands)) {
    // Ambiguous "1.314" vs "1314.51" (pt-BR). Treat a single separator with
    // <=2 trailing digits as a decimal point; otherwise as thousands.
    const parts = s.split(thousands);
    const last = parts[parts.length - 1];
    s = parts.length === 2 && last.length <= 2 ? parts.join(".") : parts.join("");
  }
  const value = Number(s);
  if (Number.isNaN(value)) return 0;
  return Math.round(value * 100);
}

/** True when the draft was typed with an explicit USD ("$") prefix — e.g.
 * "$10,50". A leading "R$" or a bare number is a BRL draft. Used by the
 * scheduled-row USD conversion: the USD entry is an affordance, the stored
 * amount stays in the ledger currency (BRL). */
export function isUsdDraft(input: string): boolean {
  return /^\s*\$/.test(input);
}

/** Format USD cents for display, distinguishing it from the ledger's R$. */
export function formatUsd(cents: Cents): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Format an ISO date string (YYYY-MM-DD) per the date-format pref. */
export function formatDateWith(prefs: Pick<FmtPrefs, 'dateFormat'>, iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return prefs.dateFormat === "MM/DD/YYYY" ? `${m}/${d}/${y}` : `${d}/${m}/${y}`;
}

/** Day and month without the year, in the date-format pref's order ("21/11" / "11/21"). */
export function formatDateShortWith(prefs: Pick<FmtPrefs, 'dateFormat'>, iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return prefs.dateFormat === "MM/DD/YYYY" ? `${m}/${d}` : `${d}/${m}`;
}

const MONTH_SHORT_KEYS = [
  "month.short.1", "month.short.2", "month.short.3", "month.short.4", "month.short.5", "month.short.6",
  "month.short.7", "month.short.8", "month.short.9", "month.short.10", "month.short.11", "month.short.12",
] as const;
const MONTH_LONG_KEYS = [
  "month.long.1", "month.long.2", "month.long.3", "month.long.4", "month.long.5", "month.long.6",
  "month.long.7", "month.long.8", "month.long.9", "month.long.10", "month.long.11", "month.long.12",
] as const;
const WEEKDAY_KEYS = [
  "weekday.0", "weekday.1", "weekday.2", "weekday.3", "weekday.4", "weekday.5", "weekday.6",
] as const;
const WEEKDAY_MIN_KEYS = [
  "weekday.min.0", "weekday.min.1", "weekday.min.2", "weekday.min.3", "weekday.min.4", "weekday.min.5", "weekday.min.6",
] as const;

/** Month abbreviation in the active language, `m` 1-12 ("Jan" / "Jan"; "Feb" / "Fev"). "?" when out of range. */
export function monthAbbr(m: number): string {
  const key = MONTH_SHORT_KEYS[m - 1];
  return key ? tCommon(key) : "?";
}

/** Month name in the active language, `m` 1-12, first letter capitalised ("June" / "Junho"). "?" when out of range. */
export function monthName(m: number): string {
  const key = MONTH_LONG_KEYS[m - 1];
  if (!key) return "?";
  const name = tCommon(key);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Weekday abbreviation in the active language, `d` 0-6 with Sunday = 0 (Date#getDay order). "?" when out of range. */
export function weekdayAbbr(d: number): string {
  const key = WEEKDAY_KEYS[d];
  return key ? tCommon(key) : "?";
}

/** Shortest weekday label for calendar headers ("Su" / "D"), `d` 0-6 with Sunday = 0. "?" when out of range. */
export function weekdayMin(d: number): string {
  const key = WEEKDAY_MIN_KEYS[d];
  return key ? tCommon(key) : "?";
}

/** Split a MonthKey (202606) into { year, month } where month is 1-12. */
export function splitMonth(key: MonthKey): { year: number; month: number } {
  return { year: Math.floor(key / 100), month: key % 100 };
}

/** Build a MonthKey from year + month (1-12). */
export function makeMonth(year: number, month: number): MonthKey {
  return year * 100 + month;
}

/** Format a MonthKey as "Jun 2026". */
export function formatMonth(key: MonthKey): string {
  const { year, month } = splitMonth(key);
  return `${monthAbbr(month)} ${year}`;
}

/** Format a MonthKey as "June 2026". */
export function formatMonthLong(key: MonthKey): string {
  const { year, month } = splitMonth(key);
  return `${monthName(month)} ${year}`;
}

/** The MonthKey immediately before the given one. */
export function prevMonth(key: MonthKey): MonthKey {
  const { year, month } = splitMonth(key);
  return month === 1 ? makeMonth(year - 1, 12) : makeMonth(year, month - 1);
}

/** The MonthKey immediately after the given one. */
export function nextMonth(key: MonthKey): MonthKey {
  const { year, month } = splitMonth(key);
  return month === 12 ? makeMonth(year + 1, 1) : makeMonth(year, month + 1);
}

/** MonthKey of an ISO date: "2026-06-13" -> 202606. */
export function monthOfDate(iso: string): MonthKey {
  return Number(iso.slice(0, 4)) * 100 + Number(iso.slice(5, 7));
}

/** MonthKey of a Date in the LOCAL zone: 2026-06-05 -> 202606. */
export function monthKeyFromDate(date: Date): MonthKey {
  return date.getFullYear() * 100 + (date.getMonth() + 1);
}

/** The current real-world month as a MonthKey (e.g. 202606). */
export function currentMonthKey(now: Date = new Date()): MonthKey {
  return monthKeyFromDate(now);
}

/** True if the ISO date falls within the given MonthKey. */
export function isInMonth(iso: string, key: MonthKey): boolean {
  const [y, m] = iso.split("-");
  return makeMonth(Number(y), Number(m)) === key;
}

/** Ordinal day-of-month from an ISO date ("2026-06-30" -> 30). */
export function dayOfMonth(iso: string): number {
  const d = iso.split("-")[2];
  return Number(d);
}

/** Today as an ISO date string (YYYY-MM-DD) in the user's LOCAL zone. */
export function todayIso(now: Date = new Date()): string {
  return localToday(now);
}

/**
 * Long date in the active language following the date-format pref: en "5 June
 * 2026" for DD/MM/YYYY and "June 5, 2026" for MM/DD/YYYY; pt-BR "5 de junho de
 * 2026" for both. Section headers (Spending).
 */
export function formatDateLongWith(prefs: Pick<FmtPrefs, "dateFormat">, iso: string): string {
  const [y, m, d] = iso.split("-");
  const monthKey = MONTH_LONG_KEYS[Number(m) - 1];
  if (!y || !monthKey || !d) return iso;
  const params = { day: Number(d), month: tCommon(monthKey), year: y };
  return prefs.dateFormat === "MM/DD/YYYY"
    ? tCommon("date.long.monthFirst", params)
    : tCommon("date.long.dayFirst", params);
}

const DATE_SEP = /[-/.]/;

/** Days in a month (1-12) for a given year, honoring leap years. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parse a user date entry written in `prefs.dateFormat` into an ISO date
 * (YYYY-MM-DD) — the inverse of `formatDateWith`. Tolerates partial forms:
 * D, D/M, D/M/YY, D/M/YYYY for "DD/MM/YYYY"; D, M/D, M/D/YY, M/D/YYYY for
 * "MM/DD/YYYY" — separators "-", "/" or "." — plus strict ISO passthrough
 * (year first, format-independent). Missing parts default to today's; a
 * 2-digit year is 2000-prefixed. Invalid dates (month > 12, day beyond the
 * month, "5/") → null. Pure: inject `today` in tests.
 */
export function parseDateInputWith(
  prefs: Pick<FmtPrefs, "dateFormat">,
  raw: string,
  today = todayIso(),
): string | null {
  const s = raw.trim();
  if (!s) return null;
  const [ty, tm] = today.split("-");

  const pad = (n: number) => String(n).padStart(2, "0");
  const parts = DATE_SEP.test(s) ? s.split(DATE_SEP) : [s];

  // Strict ISO passthrough ("2026-09-05"), component-validated.
  if (parts.length === 3 && parts[0].length === 4) {
    const [ys, ms, ds] = parts;
    if (!/^\d{4}$/.test(ys) || !/^\d{1,2}$/.test(ms) || !/^\d{1,2}$/.test(ds)) return null;
    const y = Number(ys);
    const m = Number(ms);
    const d = Number(ds);
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return `${ys}-${pad(m)}-${pad(d)}`;
  }

  // Day-first (pt-BR) or month-first (en-US) per the active format.
  const monthFirst = prefs.dateFormat === "MM/DD/YYYY";
  if (parts.length > 3 || parts.some((p) => !/^\d{1,4}$/.test(p))) return null;
  const nums = parts.map(Number);
  let d: number;
  let m: number;
  let y: number;
  if (nums.length === 1) {
    d = nums[0];
    m = Number(tm);
    y = Number(ty);
  } else {
    [d, m] = monthFirst ? [nums[1], nums[0]] : [nums[0], nums[1]];
    y = nums.length === 2 ? Number(ty) : nums[2] < 100 ? 2000 + nums[2] : nums[2];
  }
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// ---------------------------------------------------------------------------
// Bound formatter
// ---------------------------------------------------------------------------

/**
 * The formatters bound to one set of prefs and one mask state. What
 * `useMoneyFormat()` returns; pass it to non-React code that renders money.
 */
export interface MoneyFormat {
  readonly prefs: FmtPrefs;
  /** Hide Amounts is on: money renders as MONEY_MASK_TEXT and editors drop commits. */
  readonly masked: boolean;
  formatMoney(cents: Cents): string;
  formatAmount(cents: Cents): string;
  parseMoney(input: string): Cents;
  formatDate(iso: string): string;
  /** Day and month only ("21/11"), for tight ranges. */
  formatDateShort(iso: string): string;
  formatDateLong(iso: string): string;
  parseDateInput(raw: string, today?: string): string | null;
}

/** Bind the formatters to `prefs` and the mask. */
export function moneyFormat(prefs: FmtPrefs = DEFAULT_FMT_PREFS, masked = false): MoneyFormat {
  return {
    prefs,
    masked,
    formatMoney: (cents) => formatMoneyWith(prefs, cents, masked),
    formatAmount: (cents) => formatAmountWith(prefs, cents, masked),
    parseMoney: (input) => parseMoneyWith(prefs.numberLocale, input),
    formatDate: (iso) => formatDateWith(prefs, iso),
    formatDateShort: (iso) => formatDateShortWith(prefs, iso),
    formatDateLong: (iso) => formatDateLongWith(prefs, iso),
    parseDateInput: (raw, today = todayIso()) => parseDateInputWith(prefs, raw, today),
  };
}

/** The default (pt-BR, R$ before, DD/MM/YYYY), unmasked. */
export const DEFAULT_MONEY_FORMAT: MoneyFormat = moneyFormat(DEFAULT_FMT_PREFS, false);
