import { describe, it, expect, afterEach } from "bun:test";
import { DEFAULT_FMT_PREFS, getFmtPrefs, setFmtPrefs, type FmtPrefs } from "./fmtPrefs";
import {
  formatMoney,
  formatMoneyWith,
  formatAmount,
  parseMoney,
  isUsdDraft,
  formatUsd,
  formatDate,
  formatMonth,
  prevMonth,
  nextMonth,
  isInMonth,
  dayOfMonth,
  parseDateInput,
  parseDateInputWith,
  formatDateWith,
} from "./format";

describe("formatMoney", () => {
  it("formats integer cents as pt-BR currency", () => {
    expect(formatMoney(131451)).toBe("R$\u00a01.314,51");
    expect(formatMoney(0)).toBe("R$\u00a00,00");
    expect(formatMoney(-445369)).toBe("-R$\u00a04.453,69");
  });
});

describe("formatAmount", () => {
  it("formats without the currency symbol", () => {
    expect(formatAmount(131451)).toBe("1.314,51");
  });
});

describe("parseMoney", () => {
  it("parses pt-BR decimal comma with thousands dots", () => {
    expect(parseMoney("1.314,51")).toBe(131451);
    expect(parseMoney("R$ 1.314,51")).toBe(131451);
    expect(parseMoney("800,00")).toBe(80000);
  });

  it("parses plain integers and decimal points", () => {
    expect(parseMoney("1314")).toBe(131400);
    expect(parseMoney("1314.51")).toBe(131451);
  });

  it("treats a single dot with >2 trailing digits as thousands separator", () => {
    expect(parseMoney("1.314")).toBe(131400);
  });

  it("returns 0 for empty / garbage", () => {
    expect(parseMoney("")).toBe(0);
    expect(parseMoney("abc")).toBe(0);
  });

  it("signed drafts carry the operand as the sign (AmountCell storage)", () => {
    expect(parseMoney("-55,90")).toBe(-5590);
    expect(parseMoney("+55,90")).toBe(5590);
    expect(parseMoney("55,90")).toBe(5590);
    expect(parseMoney("-1.314,51")).toBe(-131451);
    // Typographic minus from keyboards/paste still parses as negative.
    expect(parseMoney("\u221255,90")).toBe(-5590);
  });

  it("round-trips with formatAmount", () => {
    expect(parseMoney(formatAmount(987654))).toBe(987654);
  });
});

describe("isUsdDraft", () => {
  it("detects a $ prefix, not R$ or bare numbers", () => {
    expect(isUsdDraft("$100")).toBe(true);
    expect(isUsdDraft(" $100")).toBe(true);
    expect(isUsdDraft("100")).toBe(false);
    expect(isUsdDraft("R$ 100")).toBe(false);
  });
});

describe("formatUsd", () => {
  it("formats cents as US$", () => {
    expect(formatUsd(10000)).toBe("US$\u00a0100,00");
  });
});

describe("dates", () => {
  it("formats ISO as DD/MM/YYYY", () => {
    expect(formatDate("2026-06-30")).toBe("30/06/2026");
  });

  it("formats a MonthKey", () => {
    expect(formatMonth(202606)).toBe("Jun 2026");
  });

  it("steps months across year boundaries", () => {
    expect(prevMonth(202601)).toBe(202512);
    expect(nextMonth(202612)).toBe(202701);
  });

  it("checks month membership", () => {
    expect(isInMonth("2026-06-05", 202606)).toBe(true);
    expect(isInMonth("2026-05-05", 202606)).toBe(false);
  });

  it("extracts day of month", () => {
    expect(dayOfMonth("2026-06-30")).toBe(30);
  });
});

describe("parseDateInput", () => {
  const TODAY = "2026-09-26";

  it("parses full day-first dates with each separator", () => {
    expect(parseDateInput("5/3/2026", TODAY)).toBe("2026-03-05");
    expect(parseDateInput("5-3-2026", TODAY)).toBe("2026-03-05");
    expect(parseDateInput("5.3.2026", TODAY)).toBe("2026-03-05");
  });

  it("pads single-digit day and month", () => {
    expect(parseDateInput("31/1/2026", TODAY)).toBe("2026-01-31");
  });

  it("defaults missing parts to today's", () => {
    expect(parseDateInput("5", TODAY)).toBe("2026-09-05");
    expect(parseDateInput("5/3", TODAY)).toBe("2026-03-05");
  });

  it("2000-prefixes 2-digit years", () => {
    expect(parseDateInput("5/3/26", TODAY)).toBe("2026-03-05");
    expect(parseDateInput("31/12/99", TODAY)).toBe("2099-12-31");
  });

  it("passes strict ISO through, validating and padding components", () => {
    expect(parseDateInput("2026-03-05", TODAY)).toBe("2026-03-05");
    expect(parseDateInput("2026-3-5", TODAY)).toBe("2026-03-05");
  });

  it("rejects Feb 29 in non-leap years, accepts in leap years", () => {
    expect(parseDateInput("29/02/2025", TODAY)).toBeNull();
    expect(parseDateInput("29/02/2024", TODAY)).toBe("2024-02-29");
    expect(parseDateInput("2025-02-29", TODAY)).toBeNull();
    expect(parseDateInput("2024-02-29", TODAY)).toBe("2024-02-29");
  });

  it("rejects day beyond the month", () => {
    expect(parseDateInput("31/04/2026", TODAY)).toBeNull();
    expect(parseDateInput("30/02/2024", TODAY)).toBeNull();
    expect(parseDateInput("2026-04-31", TODAY)).toBeNull();
    expect(parseDateInput("2026-04-30", TODAY)).toBe("2026-04-30");
  });

  it("rejects out-of-range months and days", () => {
    expect(parseDateInput("5/13/2026", TODAY)).toBeNull();
    expect(parseDateInput("0/3/2026", TODAY)).toBeNull();
    expect(parseDateInput("5/0/2026", TODAY)).toBeNull();
    expect(parseDateInput("2026-13-01", TODAY)).toBeNull();
    expect(parseDateInput("2026-00-10", TODAY)).toBeNull();
    expect(parseDateInput("2026-06-00", TODAY)).toBeNull();
  });

  it("rejects truncated and non-numeric input", () => {
    expect(parseDateInput("5/", TODAY)).toBeNull();
    expect(parseDateInput("5/3/", TODAY)).toBeNull();
    expect(parseDateInput("/5/3", TODAY)).toBeNull();
    expect(parseDateInput("abc", TODAY)).toBeNull();
    expect(parseDateInput("5/3/26x", TODAY)).toBeNull();
    expect(parseDateInput("", TODAY)).toBeNull();
    expect(parseDateInput("   ", TODAY)).toBeNull();
  });

  it("rejects ISO lookalikes with invalid parts", () => {
    expect(parseDateInput("2026/13/05", TODAY)).toBeNull();
    expect(parseDateInput("2026", TODAY)).toBeNull();
  });

  it("reads day-first DD-MM-YYYY, not ISO", () => {
    expect(parseDateInput("26-06-2026", TODAY)).toBe("2026-06-26");
  });

  it("trims surrounding whitespace", () => {
    expect(parseDateInput(" 5/3/2026 ", TODAY)).toBe("2026-03-05");
  });

  it("rejects more than three components", () => {
    expect(parseDateInput("5/3/2026/9", TODAY)).toBeNull();
  });
});

describe("parseMoney round-trips every number-format preference", () => {
  afterEach(() => setFmtPrefs(DEFAULT_FMT_PREFS));
  const values = [0, 1, 5, 99, 100, 123, 99999, 123456, 100000, 131451, 123456789, 100000000, -1, -5, -12, -131451, -123456789];
  const locales: FmtPrefs["numberLocale"][] = ["pt-BR", "en-US"];
  const currencies: FmtPrefs["currency"][] = ["BRL", "USD"];
  const placements: FmtPrefs["currencyPlacement"][] = ["before", "after", "hidden"];

  for (const numberLocale of locales) {
    it(`parseMoney(formatAmount(x)) === x under ${numberLocale}`, () => {
      setFmtPrefs({ numberLocale });
      for (const x of values) expect(parseMoney(formatAmount(x))).toBe(x);
    });
    for (const currency of currencies) {
      for (const currencyPlacement of placements) {
        it(`parseMoney(formatMoney(x)) === x under ${numberLocale}/${currency}/${currencyPlacement}`, () => {
          const prefs: FmtPrefs = { ...DEFAULT_FMT_PREFS, numberLocale, currency, currencyPlacement };
          setFmtPrefs(prefs);
          for (const x of values) expect(parseMoney(formatMoneyWith(prefs, x))).toBe(x);
        });
      }
    }
  }

  it("keeps typing habits under en-US", () => {
    setFmtPrefs({ numberLocale: "en-US" });
    expect(parseMoney("1234.5")).toBe(123450);
    expect(parseMoney("1,234")).toBe(123400);
    expect(parseMoney("-12")).toBe(-1200);
    expect(parseMoney("1234")).toBe(123400);
    expect(parseMoney("1,234,567.89")).toBe(123456789);
  });
});

describe("parseDateInputWith — follows the active date format", () => {
  const TODAY = "2026-09-26";
  const FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY"] as const;
  const DATES = [
    "2026-06-05", "2026-05-06", "2026-11-16", "2026-01-01", "2026-12-31",
    "2026-01-31", "2026-02-28", "2026-04-30", "2024-02-29", "2000-02-29",
    "2026-03-09", "2026-09-03", "2026-10-12", "2026-12-10", "2026-07-13", "2026-13-07".replace("13", "08"),
  ];

  for (const dateFormat of FORMATS) {
    it(`round-trips formatDateWith for ${dateFormat}`, () => {
      for (const iso of DATES) {
        expect(parseDateInputWith({ dateFormat }, formatDateWith({ dateFormat }, iso), TODAY)).toBe(iso);
      }
    });
    it(`round-trips unpadded single-digit parts for ${dateFormat}`, () => {
      const text = dateFormat === "MM/DD/YYYY" ? "6/5/2026" : "5/6/2026";
      expect(parseDateInputWith({ dateFormat }, text, TODAY)).toBe("2026-06-05");
    });
  }

  it("MM/DD/YYYY reads month first, other separators too", () => {
    const f = { dateFormat: "MM/DD/YYYY" } as const;
    expect(parseDateInputWith(f, "06/05/2026", TODAY)).toBe("2026-06-05");
    expect(parseDateInputWith(f, "11/16/2026", TODAY)).toBe("2026-11-16");
    expect(parseDateInputWith(f, "6-5-2026", TODAY)).toBe("2026-06-05");
    expect(parseDateInputWith(f, "6.5.2026", TODAY)).toBe("2026-06-05");
  });

  it("MM/DD/YYYY typing shortcuts", () => {
    const f = { dateFormat: "MM/DD/YYYY" } as const;
    expect(parseDateInputWith(f, "5", TODAY)).toBe("2026-09-05"); // day only
    expect(parseDateInputWith(f, "3/5", TODAY)).toBe("2026-03-05"); // month/day
    expect(parseDateInputWith(f, "3/5/26", TODAY)).toBe("2026-03-05");
    expect(parseDateInputWith(f, "12/31/99", TODAY)).toBe("2099-12-31");
    expect(parseDateInputWith(f, "2026-3-5", TODAY)).toBe("2026-03-05"); // ISO passthrough
  });

  it("MM/DD/YYYY rejects invalid input", () => {
    const f = { dateFormat: "MM/DD/YYYY" } as const;
    expect(parseDateInputWith(f, "16/11/2026", TODAY)).toBeNull(); // month 16
    expect(parseDateInputWith(f, "2/30/2024", TODAY)).toBeNull();
    expect(parseDateInputWith(f, "2/29/2025", TODAY)).toBeNull();
    expect(parseDateInputWith(f, "0/5/2026", TODAY)).toBeNull();
    expect(parseDateInputWith(f, "5/", TODAY)).toBeNull();
    expect(parseDateInputWith(f, "abc", TODAY)).toBeNull();
    expect(parseDateInputWith(f, "", TODAY)).toBeNull();
    expect(parseDateInputWith(f, "1/2/3/4", TODAY)).toBeNull();
  });

  it("DD/MM/YYYY behaves as before", () => {
    const f = { dateFormat: "DD/MM/YYYY" } as const;
    expect(parseDateInputWith(f, "5/3", TODAY)).toBe("2026-03-05");
    expect(parseDateInputWith(f, "5/13/2026", TODAY)).toBeNull();
  });
});

describe("parseDateInput (live preference wrapper)", () => {
  it("reads the Settings date format", () => {
    const prev = getFmtPrefs().dateFormat;
    try {
      setFmtPrefs({ dateFormat: "MM/DD/YYYY" });
      expect(parseDateInput(formatDate("2026-06-05"), "2026-09-26")).toBe("2026-06-05");
      expect(parseDateInput("11/16/2026", "2026-09-26")).toBe("2026-11-16");
    } finally {
      setFmtPrefs({ dateFormat: prev });
    }
  });
});
