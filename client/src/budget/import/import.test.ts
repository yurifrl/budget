import { describe, it, expect } from "bun:test";
import * as XLSX from "xlsx";
import {
  detectNubankLayout,
  parseCsv,
  parseImportDate,
  parseImportAmount,
  parseImportCsv,
  parseMappedCsv,
  parseItauExtratoTxt,
  parseItauExtratoXls,
  parseItauFaturaXls,
  parseNubankCsv,
  parseStatementFile,
} from "./index";
import type { CsvMapping } from "./index";

/** Wrap text for the binary-aware dispatcher (XLS parsers never see it). */
const stmt = (text: string) => ({ bytes: new Uint8Array(), text });

describe("parseCsv", () => {
  it("splits plain rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps commas and newlines inside quotes and unescapes doubled quotes", () => {
    expect(parseCsv('a,"b,1",c\n"x""y","multi\nline",z')).toEqual([
      ["a", "b,1", "c"],
      ['x"y', "multi\nline", "z"],
    ]);
  });

  it("drops empty lines and handles CRLF", () => {
    expect(parseCsv("a,b\r\n\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseImportDate", () => {
  it("parses pt-BR DD/MM/YYYY", () => {
    expect(parseImportDate("25/12/2025")).toBe("2025-12-25");
  });

  it("parses ISO YYYY-MM-DD", () => {
    expect(parseImportDate("2025-01-07")).toBe("2025-01-07");
  });

  it("treats second component > 12 as month (MM/DD fallback)", () => {
    expect(parseImportDate("01/20/2025")).toBe("2025-01-20");
  });

  it("defaults ambiguous two-digit-day order to DD/MM (app locale)", () => {
    expect(parseImportDate("05/06/2025")).toBe("2025-06-05");
  });

  it("maps two-digit years to the near century", () => {
    expect(parseImportDate("7/3/26")).toBe("2026-03-07");
    expect(parseImportDate("7/3/69")).toBe("1969-03-07");
  });

  it("rejects garbage and impossible dates", () => {
    expect(parseImportDate("abc")).toBeNull();
    expect(parseImportDate("31/02/2025")).toBeNull();
    expect(parseImportDate("")).toBeNull();
  });
});

describe("parseImportAmount", () => {
  it("parses pt-BR and plain-decimal money", () => {
    expect(parseImportAmount("R$ 1.314,51")).toBe(131451);
    expect(parseImportAmount("1234.56")).toBe(123456);
    expect(parseImportAmount("0,50")).toBe(50);
  });

  it("negates minus sign and parentheses", () => {
    expect(parseImportAmount("-50,00")).toBe(-5000);
    expect(parseImportAmount("(50.00)")).toBe(-5000);
  });

  it("returns null for non-numeric text", () => {
    expect(parseImportAmount("abc")).toBeNull();
    expect(parseImportAmount("")).toBeNull();
  });
});

describe("parseImportCsv", () => {
  const HEADER = "Date,Payee,Category,Memo,Outflow,Inflow\n";

  it("maps YNAB-style header CSV", () => {
    const result = parseImportCsv(
      `${HEADER}25/12/2025,Café,Food,Xmas coffee,"12,34",\n26/12/2025,Salary,,December pay,,1500.00\n`,
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { date: "2025-12-25", payee: "Café", memo: "Xmas coffee", outflowCents: 1234, inflowCents: 0 },
      { date: "2025-12-26", payee: "Salary", memo: "December pay", outflowCents: 0, inflowCents: 150000 },
    ]);
  });

  it("maps a signed amount column (pt-BR header)", () => {
    const result = parseImportCsv(
      "Data;Beneficiário;Observação;Valor\n" +
        "01/07/2026;Padaria;compra;-25,90\n" +
        "02/07/2026;PIX recebido;;35,00\n",
      );
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { date: "2026-07-01", payee: "Padaria", memo: "compra", outflowCents: 2590, inflowCents: 0 },
      { date: "2026-07-02", payee: "PIX recebido", memo: "", outflowCents: 0, inflowCents: 3500 },
    ]);
  });

  it("falls back to YNAB positional order without a header", () => {
    const result = parseImportCsv("2026-01-05,Market,,groceries,40.00,\n");
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { date: "2026-01-05", payee: "Market", memo: "groceries", outflowCents: 4000, inflowCents: 0 },
    ]);
  });

  it("reports bad lines and counts skips", () => {
    const result = parseImportCsv(
      `${HEADER}not-a-date,X,,,\n25/12/2025,Good,,,3.50\n25/12/2025,Zero,,"0,00",\n\n`,
    );
    expect(result.rows).toEqual([
      { date: "2025-12-25", payee: "Good", memo: "", outflowCents: 350, inflowCents: 0 },
    ]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("line 2");
    expect(result.skipped).toBe(0);
  });

  it("rejects a header-only or unrecognized file", () => {
    expect(parseImportCsv(HEADER).rows).toEqual([]);
    expect(parseImportCsv("a,b,c\n1,2,3").errors[0]).toContain("unrecognized CSV layout");
  });

  it("maps a credit-card amount column with chargePositive (Itaú fatura)", () => {
    const result = parseImportCsv("data,lançamento,valor\n2025-06-27,IFD*55668457 GABRIEL A,113.98\n2025-06-28,REFUND,-50.00\n", {
      chargePositive: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { date: "2025-06-27", payee: "IFD*55668457 GABRIEL A", memo: "", outflowCents: 11398, inflowCents: 0 },
      { date: "2025-06-28", payee: "REFUND", memo: "", outflowCents: 0, inflowCents: 5000 },
    ]);
  });
});

describe("parseItauExtratoXls", () => {
  /**
   * Builds a real BIFF8 workbook shaped exactly like Itaú's 2026 conta
   * extrato export: header rows, a "lançamentos" section label, a column
   * header row ("data | lançamento | ag./origem | valor (R$) | saldos"),
   * "SALDO ANTERIOR"/"SALDO TOTAL DISPONÍVEL DIA" balance rows with the
   * balance in column 4, and transaction rows whose amounts are NUMERIC
   * cells displayed in en-US ("5,200.00") by SheetJS.
   */
  const extratoXls = (): Uint8Array => {
    const sheet = [
      ["Logotipo Itaú", "", "", "", ""],
      ["Lançamentos", "", "", "", ""],
      ["", "", "", "", ""],
      ["data", "lançamento", "ag./origem", "valor (R$)", "saldos (R$)"],
      ["lançamentos", "", "", "", ""],
      ["09/10/2026", "SALDO ANTERIOR", "", "", 262.68],
      ["13/10/2026", "PIX TRANSF YURI FR13/10", "", 5200, ""],
      ["13/10/2026", "DA CLARO S.A. 57662", "", -304.81, ""],
      ["14/10/2026", "PIX QRS Liv Up Come14/10", "", -249.3, ""],
      ["30/10/2026", "DA  SEMAE M CRUZ 3236410", "", -56.56, ""],
    ];
    const ws = XLSX.utils.aoa_to_sheet(sheet);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Planilha1");
    const bytes = XLSX.write(wb, { bookType: "xls", type: "array" }) as ArrayBuffer;
    return new Uint8Array(bytes);
  };

  it("reads numeric amount cells exactly (no locale round-trip)", () => {
    const result = parseItauExtratoXls(extratoXls());
    expect(result.rows).toEqual([
      { date: "2026-10-13", payee: "PIX TRANSF YURI FR13/10", memo: "", outflowCents: 0, inflowCents: 520000 },
      { date: "2026-10-13", payee: "DA CLARO S.A. 57662", memo: "", outflowCents: 30481, inflowCents: 0 },
      { date: "2026-10-14", payee: "PIX QRS Liv Up Come14/10", memo: "", outflowCents: 24930, inflowCents: 0 },
      { date: "2026-10-30", payee: "DA  SEMAE M CRUZ 3236410", memo: "", outflowCents: 5656, inflowCents: 0 },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("skips balance/header rows without adding noise errors", () => {
    const result = parseItauExtratoXls(extratoXls());
    expect(result.errors).toEqual([]);
    expect(result.rows.every((r) => r.payee !== "SALDO ANTERIOR")).toBe(true);
    expect(result.rows.every((r) => r.payee !== "lançamentos")).toBe(true);
  });

  it("rejects a non-XLS binary file as unreadable", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const result = parseItauExtratoXls(bytes);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual(["unreadable XLS file"]);
  });
});

describe("parseItauFaturaXls", () => {
  /**
   * Builds a real XLSX workbook shaped exactly like Itaú's 2026 conta
   * fatura export: an indented summary block (Nome/Agência/Conta, the
   * "Fatura Fechada - Mês/Ano" title, the card "… - final 3537" with total
   * and vencimento as Excel serials), the "Lançamentos" section with
   * column headers, transaction rows with serial dates in column 1,
   * merchants in column 2, a "Parcela n de m" installment in column 3,
   * raw numeric amounts in column 4, a currency-annotation cell, a
   * payment row, a one-cent refund, titularidade/card per row, and the
   * Subtotal/"Importante saber" tail.
   */
  const faturaXlsx = (): Uint8Array => {
    const serial = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) + 25569;
    const sheet: (string | number)[][] = [
      [" ", "", "", "", "", "", "", "", "", ""],
      ["", "Nome", "Yuri Freire Lima", "", "", "", "", "", "", ""],
      ["", "Agência", "9395", "", "", "", "", "", "", ""],
      ["", "Conta", "10946-6", "", "", "", "", "", "", ""],
      ["", "Fatura Fechada - Novembro/2026", "", "", "", "", "", "", "", ""],
      ["", "Cartão", "", "", "", "", "Valor", "", "Vencimento", ""],
      ["", "Personnalite Mult Black Pts Mastercard - final 3537", "", "", "", "", 17123.34, "", serial("2026-11-05"), ""],
      ["", "", "", "", "", "", "", "", "", ""],
      ["", "Lançamentos", "", "", "", "", "", "", "", ""],
      ["", "Data", "Lançamento", "Parcelamento", "Valor", "", "Titularidade", "Nome", "Tipo do cartão", "Número do cartão"],
      ["", serial("2026-10-06"), "Pagamento Efetuado", "", -38624.11, "", "Titular", "Yuri Freire Lima", "Físico", "****4385"],
      ["", serial("2026-10-21"), "Mercadolivre*lojadome", "", 287.63, "", "Titular", "Yuri Freire Lima", "Virtual recorrente", "****6636"],
      ["", serial("2026-10-16"), "Academia Acqua", "Parcela 2 de 12", 249.99, "", "Adicional", "Gabriele A N Cardos", "Wallet", "****5685"],
      ["", serial("2026-10-18"), "Blizzard Us1064036277", "", 306.9, "USD 57,58 \n(cotação R$ 5,33)", "Titular", "Yuri Freire Lima", "Físico", "****7277"],
      ["", serial("2026-10-20"), "Mercadolivre*mercadol", "", -0.01, "", "Adicional", "Gabriele N Cardoso", "Virtual recorrente", "****0933"],
      ["", "", "", "", "", "", "", "", "", ""],
      ["", "", "", "Subtotal  ", "", "", "", "", "", ""],
      ["", "Importante saber", "", "", "", "", "", "", "", ""],
      ["", "As compras recentes levam até 48 horas para aparecer na fatura.", "", "", "", "", "", "", "", ""],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), "Fatura 11-26");
    return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
  };

  it("parses the 2026 XLSX layout: serial dates, numeric amounts, per-row card memo", () => {
    const result = parseItauFaturaXls(faturaXlsx());
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { date: "2026-10-06", payee: "Pagamento Efetuado", memo: "titular *4385", outflowCents: 0, inflowCents: 3862411 },
      { date: "2026-10-21", payee: "Mercadolivre*lojadome", memo: "titular *6636", outflowCents: 28763, inflowCents: 0 },
      { date: "2026-10-16", payee: "Academia Acqua", memo: "adicional *5685 · 2/12", outflowCents: 24999, inflowCents: 0 },
      { date: "2026-10-18", payee: "Blizzard Us1064036277", memo: "titular *7277", outflowCents: 30690, inflowCents: 0 },
      { date: "2026-10-20", payee: "Mercadolivre*mercadol", memo: "adicional *0933", outflowCents: 0, inflowCents: 1 },
    ]);
  });

  it("rejects a workbook with no fatura transactions", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([[" ", ""], ["", "Nome", "Yuri Freire Lima"], ["", "Fatura Aberta - Dezembro/2026"]]),
      "Fatura 12-26",
    );
    const bytes = new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
    const result = parseItauFaturaXls(bytes);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual(["no fatura transactions found in sheet — not an Itaú fatura XLS"]);
  });

  it("rejects a non-XLS binary file as unreadable", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const result = parseItauFaturaXls(bytes);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual(["unreadable XLS file"]);
  });
});

describe("parseItauExtratoTxt", () => {
  it("parses the semicolon extrato format (real Itaú sample shape)", () => {
    const result = parseItauExtratoTxt(
      "17/03/2025;PIX TRANSF ID_A15/03;-2327,00\n" +
        "19/03/2025;REND PAGO APLIC AUT MAIS;0,42\n" +
        "21/03/2025;INT /SERVICE_A CITY 202;-53,70\n",
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { date: "2025-03-17", payee: "PIX TRANSF ID_A15/03", memo: "", outflowCents: 232700, inflowCents: 0 },
      { date: "2025-03-19", payee: "REND PAGO APLIC AUT MAIS", memo: "", outflowCents: 0, inflowCents: 42 },
      { date: "2025-03-21", payee: "INT /SERVICE_A CITY 202", memo: "", outflowCents: 5370, inflowCents: 0 },
    ]);
  });

  it("reports bad lines without stopping", () => {
    const result = parseItauExtratoTxt("garbage line\n17/03/2025;PIX;-1,00\n");
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("line 1");
  });
});

describe("parseStatementFile", () => {
  const TXT = "17/03/2025;PIX;-1,00\n";

  it("dispatches by extension", () => {
    expect(parseStatementFile("extrato.txt", stmt(TXT)).rows).toEqual(parseItauExtratoTxt(TXT).rows);
    expect(parseStatementFile("extrato.csv", stmt(TXT)).rows).toEqual([]);
    expect(parseStatementFile("extrato.csv", stmt(TXT)).errors.length).toBeGreaterThan(0);
  });

  it("treats fatura csv as charge-positive", () => {
    const plain = parseStatementFile("extrato.csv", stmt("date,amount\n2025-06-27,10.00\n"));
    const fatura = parseStatementFile("fatura.csv", stmt("date,amount\n2025-06-27,10.00\n"));
    expect(plain.rows[0]).toMatchObject({ outflowCents: 0, inflowCents: 1000 });
    expect(fatura.rows[0]).toMatchObject({ outflowCents: 1000, inflowCents: 0 });
  });

  it("rejects OFX content with the unsupported-format error", () => {
    const ofxMin = "<STMTTRN>\n<DTPOSTED>20250317\n<TRNAMT>-1,00\n<MEMO>PIX\n</STMTTRN>";
    for (const name of ["extrato.ofx", "download.qfx", "EXTRATO.OFX"]) {
      const result = parseStatementFile(name, stmt(ofxMin));
      expect(result.rows).toEqual([]);
      expect(result.errors).toEqual(["OFX/QFX format is no longer supported — export the statement as XLS or TXT from Itaú instead"]);
    }
  });

  it("rejects legacy binary OFC content with a specific error", () => {
    // Real Itaú "1.0" OFC export: line-based legacy format, no SGML tags.
    const ofcBinary = "0\r\n1\r\n13\r\n341\r\n\r\n9395\r\n\r\n10946-6\r\n\r\n\r\n0\r\n855\r\n927\r\n11\r\n100\r\n";
    const result = parseStatementFile("extrato241020261029 - 1.0.ofc", { bytes: new Uint8Array(16), text: ofcBinary });
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual(["legacy binary OFC format is not supported — export the statement as XLS or TXT from Itaú instead"]);
  });

  it("rejects OFX content even when the file is mislabeled as CSV", () => {
    const ofxMin = "<STMTTRN>\n<DTPOSTED>20250317\n<TRNAMT>-1,00\n<MEMO>PIX\n</STMTTRN>";
    const result = parseStatementFile("extrato.csv", stmt(ofxMin));
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual(["OFX/QFX format is no longer supported — export the statement as XLS or TXT from Itaú instead"]);
  });
});

describe("parseMappedCsv", () => {
  it("reads positionally from user-confirmed columns", () => {
    const mapping: CsvMapping = {
      delimiter: ";",
      headerRow: 1,
      columns: { date: 0, payee: 2, memo: -1, outflow: 1, inflow: -1, amount: -1, category: -1 },
      chargePositive: false,
    };
    const result = parseMappedCsv(
      "config\nData;Valor;Descri\u00e7\u00e3o\n05/01/2026;40,00;Market\n",
      mapping,
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { date: "2026-01-05", payee: "Market", memo: "", outflowCents: 4000, inflowCents: 0 },
    ]);
  });

  it("chargePositive inverts a signed amount column", () => {
    const mapping: CsvMapping = {
      delimiter: ",",
      headerRow: 0,
      columns: { date: 0, payee: 1, memo: -1, outflow: -1, inflow: -1, amount: 2, category: -1 },
      chargePositive: true,
    };
    const result = parseMappedCsv("date,payee,amount\n2025-06-27,Nubank,10.00\n", mapping);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { date: "2025-06-27", payee: "Nubank", memo: "", outflowCents: 1000, inflowCents: 0 },
    ]);
  });
});

describe("parseNubankCsv", () => {
  it("detects conta and fatura layouts", () => {
    expect(detectNubankLayout("Data,Valor,Identificador,Descri\u00e7\u00e3o\n")).toBe("conta");
    expect(detectNubankLayout("date,amount,id,title\n")).toBe("fatura");
    expect(detectNubankLayout("Data,Valor,Descri\u00e7\u00e3o\n")).toBe(null);
  });

  it("parses conta rows with signed amounts and deterministic import ids", () => {
    const result = parseNubankCsv(
      "Data,Valor,Identificador,Descri\u00e7\u00e3o\n" +
        "2025-06-27,-50.00,abc123,Padaria\n" +
        "2025-06-28,10.00,def456,Pix recebido\n",
      "conta",
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        date: "2025-06-27",
        payee: "Padaria",
        memo: "",
        outflowCents: 5000,
        inflowCents: 0,
        importId: "nubank:abc123:2025-06-27:-50000",
      },
      {
        date: "2025-06-28",
        payee: "Pix recebido",
        memo: "",
        outflowCents: 0,
        inflowCents: 1000,
        importId: "nubank:def456:2025-06-28:10000",
      },
    ]);
  });

  it("parses fatura rows with positive amounts as charges", () => {
    const result = parseNubankCsv("date,amount,id,title\n2025-06-27,10.00,xyz,Netflix\n", "fatura");
    expect(result.rows).toEqual([
      {
        date: "2025-06-27",
        payee: "Netflix",
        memo: "",
        outflowCents: 1000,
        inflowCents: 0,
        importId: "nubank:xyz:2025-06-27:-10000",
      },
    ]);
  });
});
