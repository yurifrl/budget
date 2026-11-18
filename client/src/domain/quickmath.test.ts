import { describe, it, expect } from "bun:test";
import {
  evalQuickMath,
  EMPTY_NUMPAD_STATE,
  applyNumpadKey,
  resolve,
  numpadOperandText,
  type NumpadState,
  type NumpadKey,
} from "./quickmath";

/** Fold a key sequence into one state — the pad is just repeated presses. */
function pressAll(initial: NumpadState, ...keys: NumpadKey[]): NumpadState {
  let st = initial;
  for (const key of keys) st = applyNumpadKey(st, key);
  return st;
}

describe("evalQuickMath", () => {
  it("evaluates left-to-right on integer cents", () => {
    expect(evalQuickMath("10+10×2", 0)).toBe(4000); // (10+10)×2 = 40, not 30
    expect(evalQuickMath("10×2+10", 0)).toBe(3000);
    expect(evalQuickMath("100÷4÷5", 0)).toBe(500); // 100/4/5 = 5
  });

  it("evaluates decimal money without float drift", () => {
    expect(evalQuickMath("0,10+0,10", 0)).toBe(20);
    expect(evalQuickMath("100,5+0,5", 0)).toBe(10100);
    expect(evalQuickMath("1.314,51+1", 0)).toBe(131551);
  });

  it("a plain number replaces the current value", () => {
    expect(evalQuickMath("50", 12345)).toBe(5000);
    expect(evalQuickMath("0", 12345)).toBe(0);
    expect(evalQuickMath("1.314,51", 0)).toBe(131451);
  });

  it("a leading +/− hugging digits signs the number — a lone signed number sets", () => {
    expect(evalQuickMath("+50", 2000)).toBe(5000); // set R$50, not 20+50
    expect(evalQuickMath("−100", 5000)).toBe(-10000); // set −R$100
    // The untouched pre-filled draft of a negative cell re-commits unchanged.
    expect(evalQuickMath("-1.617,00", -161700)).toBe(-161700);
    expect(evalQuickMath("−1.617,00", -161700)).toBe(-161700); // typographic minus
    // ×/÷ cannot sign a number — they stay relative to the current value.
    expect(evalQuickMath("×2", 5000)).toBe(10000);
    expect(evalQuickMath("÷2", 5000)).toBe(2500);
    expect(evalQuickMath("×1,5", 5000)).toBe(7500);
  });

  it("a signed first operand opens the equation", () => {
    expect(evalQuickMath("-1.617,00-500", -161700)).toBe(-211700); // (−1.617) − 500
    expect(evalQuickMath("−1.617,00−500", -161700)).toBe(-211700); // typographic glyphs
    expect(evalQuickMath("-1.617,00 - 500", -161700)).toBe(-211700); // spaces
  });

  it("a leading operator separated from its digits stays relative", () => {
    expect(evalQuickMath("- 50", 5000)).toBe(0); // 5000 − 5000
    expect(evalQuickMath("+ 50", 2000)).toBe(7000); // 2000 + 5000
  });

  it("supports subtraction into negative amounts", () => {
    expect(evalQuickMath("50−70", 0)).toBe(-2000);
    expect(evalQuickMath("50-20", 0)).toBe(3000); // ASCII hyphen alias
  });

  it("accepts keyboard aliases for the glyphs", () => {
    expect(evalQuickMath("50*2", 0)).toBe(10000);
    expect(evalQuickMath("50/2", 0)).toBe(2500);
  });

  it("tolerates spaces around operators", () => {
    expect(evalQuickMath("50 + 20", 0)).toBe(7000);
    expect(evalQuickMath(" ×2 ", 5000)).toBe(10000);
  });

  it("rounds division to the nearest cent", () => {
    expect(evalQuickMath("100÷3", 0)).toBe(3333);
    expect(evalQuickMath("100÷3+0,01", 0)).toBe(3334); // left-to-right with rounding
  });

  it("rounds multiplication producing fractional cents", () => {
    expect(evalQuickMath("5,01×0,5", 0)).toBe(251); // 250.5 → 251
    expect(evalQuickMath("5,01×0,4", 0)).toBe(200); // 200.4 → 200
  });

  it("rejects invalid input with null", () => {
    expect(evalQuickMath("", 5000)).toBeNull();
    expect(evalQuickMath("   ", 5000)).toBeNull();
    expect(evalQuickMath("abc", 5000)).toBeNull();
    expect(evalQuickMath("50+", 5000)).toBeNull();
    expect(evalQuickMath("+", 5000)).toBeNull();
    expect(evalQuickMath("50×", 5000)).toBeNull();
    expect(evalQuickMath("50++20", 5000)).toBeNull();
    expect(evalQuickMath("50 20", 5000)).toBeNull();
    expect(evalQuickMath("50,20", 5000)).toBe(5020); // valid decimal, kept
  });

  it("rejects division by zero", () => {
    expect(evalQuickMath("÷0", 5000)).toBeNull();
    expect(evalQuickMath("10/0", 5000)).toBeNull();
  });

  it("rejects results beyond the safe integer range", () => {
    expect(evalQuickMath("99999999×99999999", 0)).toBeNull();
  });
});

describe("numpad state machine", () => {
  it("empty state resolves to null", () => {
    expect(resolve(EMPTY_NUMPAD_STATE)).toBeNull();
  });

  it("digits form a cents-first operand ('063' is R$ 0,63)", () => {
    const st = pressAll(EMPTY_NUMPAD_STATE, "0", "6", "3");
    expect(st).toEqual({ base: null, op: "=", operand: "063" });
    expect(resolve(st)).toBe(63);
  });

  it("a fresh entry without base replaces the row value", () => {
    const st = pressAll(EMPTY_NUMPAD_STATE, "1", "2");
    expect(resolve(st)).toBe(12);
  });

  it("'=' after digits resolves as a fresh entry", () => {
    const st = pressAll(EMPTY_NUMPAD_STATE, "4", "0", "0", "=", "0", "1");
    // 400 = → base 400; then digits start a new fresh entry
    expect(st.base).toBe(400);
    expect(st.op).toBe("=");
    expect(st.operand).toBe("01");
    expect(resolve(st)).toBe(1);
  });

  it("'+' resolves the pending fresh entry and sets the operator", () => {
    const st = pressAll(EMPTY_NUMPAD_STATE, "3", "9", "9", "3", "8", "+");
    expect(st.base).toBe(39938);
    expect(st.op).toBe("+");
    expect(st.operand).toBe("");
  });

  it("YNAB mobile flow: 399,38 + 0,63 = 400,01 exact (no float drift)", () => {
    const st = pressAll(EMPTY_NUMPAD_STATE, "3", "9", "9", "3", "8", "+", "0", "6", "3");
    expect(st.base).toBe(39938);
    expect(st.operand).toBe("063");
    expect(resolve(st)).toBe(40001);
  });

  it("'+' then '−' resolves the pending addition and chains", () => {
    const st = pressAll(EMPTY_NUMPAD_STATE, "3", "9", "9", "3", "8", "+", "0", "6", "3", "−", "1");
    expect(st.base).toBe(40001); // 39938 + 63 resolved when − pressed
    expect(st.op).toBe("−");
    expect(st.operand).toBe("1");
    expect(resolve(st)).toBe(40000);
  });

  it("'=' after an operator resolves the pending operation", () => {
    const st = pressAll(EMPTY_NUMPAD_STATE, "5", "0", "+", "2", "0", "=");
    expect(st.base).toBe(70);
    expect(st.op).toBe("=");
    expect(st.operand).toBe("");
    expect(resolve(st)).toBe(70);
  });

  it("'+' with no digits typed just keeps the base", () => {
    const st = pressAll(EMPTY_NUMPAD_STATE, "5", "0", "+", "+");
    expect(st.base).toBe(50);
    expect(st.op).toBe("+");
    expect(st.operand).toBe("");
  });

  it("operator with no base keeps base null and resolve stays null", () => {
    const st = pressAll(EMPTY_NUMPAD_STATE, "+", "5", "0");
    expect(st).toEqual({ base: null, op: "=", operand: "50" });
    expect(resolve(st)).toBe(50); // fresh entry
  });

  it("⌫ deletes digits and, past an empty operand, reverts to the base", () => {
    const mid = pressAll(EMPTY_NUMPAD_STATE, "3", "9", "9", "3", "8", "+", "0", "6", "3");
    const deleted = pressAll(mid, "del", "del", "del"); // operand "063" → ""
    expect(deleted).toEqual({ base: 39938, op: "+", operand: "" });
    expect(resolve(deleted)).toBe(39938); // operand gone → base stands
    // one more ⌫ cancels the pending op, reverting to the base fresh entry
    const reverted = applyNumpadKey(deleted, "del");
    expect(reverted).toEqual({ base: 39938, op: "=", operand: "" });
  });

  it("⌫ deletes one digit at a time on a fresh entry", () => {
    const based = pressAll(EMPTY_NUMPAD_STATE, "5", "0");
    expect(applyNumpadKey(based, "del")).toEqual({ base: null, op: "=", operand: "5" });
  });

  it("⌫ with nothing to delete is a no-op", () => {
    expect(applyNumpadKey(EMPTY_NUMPAD_STATE, "del")).toEqual(EMPTY_NUMPAD_STATE);
  });

  it("rejects an operand beyond the safe integer range", () => {
    // The 16th nine would exceed MAX_SAFE_INTEGER (≈9.007e15) — rejected press.
    const nines = Array.from({ length: 16 }, () => "9" as const);
    const st = pressAll(EMPTY_NUMPAD_STATE, ...nines);
    expect(st.operand).toBe("999999999999999"); // 15 nines stand
    // A directly constructed out-of-range operand resolves to null.
    expect(resolve({ base: null, op: "=", operand: "99999999999999999" })).toBeNull();
  });

  it("rejects a result that overflows the safe integer range", () => {
    // 5e15 + 5e15 = 1e16 > MAX_SAFE_INTEGER (≈9.007e15); each operand is safe.
    const fiveQuadrillion = [..."5000000000000000"] as NumpadKey[];
    const st = pressAll(EMPTY_NUMPAD_STATE, ...fiveQuadrillion, "+", ...fiveQuadrillion);
    expect(st.base).toBe(5_000_000_000_000_000);
    expect(st.operand).toBe("5000000000000000");
    expect(resolve(st)).toBeNull();
  });

  it("numpadOperandText renders the digits as pt-BR money", () => {
    expect(numpadOperandText("")).toBe("R$\u00a00,00");
    expect(numpadOperandText("063")).toBe("R$\u00a00,63");
    expect(numpadOperandText("39938")).toBe("R$\u00a0399,38");
    expect(numpadOperandText("40001")).toBe("R$\u00a0400,01");
  });
});
