import { describe, expect, test } from 'bun:test';
import {
  addMonthsIso,
  installmentLabel,
  installmentStem,
  paidInstallmentKey,
  parseInstallmentSuffix,
  projectUpcomingInstallments,
  readInstallmentMeta,
  type InstallmentSource,
} from './installments';

/** A Pluggy card row as stored in connection_transactions.raw_payload. */
const raw = (
  number: number,
  total: number,
  opts: { purchaseDate?: string | null; status?: 'POSTED' | 'PENDING'; billId?: string | null } = {},
) => ({
  status: opts.status ?? 'POSTED',
  creditCardMetadata: {
    installmentNumber: number,
    totalInstallments: total,
    purchaseDate: opts.purchaseDate === undefined ? '2026-08-10T00:00:00.000Z' : opts.purchaseDate,
    billId: opts.billId === undefined ? ((opts.status ?? 'POSTED') === 'POSTED' ? 'bill-1' : null) : opts.billId,
    totalAmount: null,
  },
});

let seq = 0;
const row = (over: Partial<InstallmentSource> & Pick<InstallmentSource, 'description' | 'date' | 'raw'>): InstallmentSource => ({
  id: `t${++seq}`,
  accountId: 'card',
  amount: -150_000,
  categoryId: 'cat-gym',
  deleted: false,
  ...over,
});

describe('readInstallmentMeta', () => {
  test('reads number, total, purchase date and posted state', () => {
    expect(readInstallmentMeta(raw(2, 12))).toEqual({ number: 2, total: 12, purchaseDate: '2026-08-10', posted: true });
    expect(readInstallmentMeta(raw(1, 4, { status: 'PENDING' }))).toMatchObject({ posted: false });
  });

  test('accepts the single-l spelling and falls back to billId without a status', () => {
    expect(
      readInstallmentMeta({ creditCardMetadata: { instalmentNumber: 3, totalInstalments: 6, billId: 'b' } }),
    ).toEqual({ number: 3, total: 6, purchaseDate: null, posted: true });
    expect(readInstallmentMeta({ creditCardMetadata: { installmentNumber: 3, totalInstallments: 6, billId: null } })).toMatchObject({
      posted: false,
    });
  });

  test('a non-installment row has no metadata', () => {
    expect(readInstallmentMeta(null)).toBeNull();
    expect(readInstallmentMeta({ status: 'POSTED' })).toBeNull();
    expect(readInstallmentMeta({ creditCardMetadata: { installmentNumber: 1, totalInstallments: 1 } })).toBeNull();
    expect(readInstallmentMeta({ creditCardMetadata: { installmentNumber: 5, totalInstallments: 4 } })).toBeNull();
    expect(readInstallmentMeta({ creditCardMetadata: { billId: 'b' } })).toBeNull();
  });
});

describe('description suffix', () => {
  test.each([
    ['ACADEMIA ACQUA 02/12', 'ACADEMIA ACQUA', 2, 12],
    ['MERCADOLIVRE*MERCA01/02', 'MERCADOLIVRE*MERCA', 1, 2],
    ['PET LOVE*Clube NE804/12', 'PET LOVE*Clube NE8', 4, 12],
    ['PortovalleAcabame 04/04', 'PortovalleAcabame', 4, 4],
    ['CCT CLINICA CIR 01/04 ', 'CCT CLINICA CIR', 1, 4],
  ])('%s', (description, stem, number, total) => {
    expect(parseInstallmentSuffix(description)).toEqual({ stem, number, total });
    expect(installmentStem(description, number, total)).toBe(stem);
  });

  test('no suffix, or one that is not an installment', () => {
    expect(parseInstallmentSuffix('UBER TRIP')).toBeNull();
    expect(parseInstallmentSuffix('LOJA 05/04')).toBeNull();
    expect(parseInstallmentSuffix('03/12')).toBeNull();
  });

  test('installmentStem keeps a description whose suffix is another n/N', () => {
    expect(installmentStem('ACADEMIA ACQUA 02/12', 3, 12)).toBe('ACADEMIA ACQUA 02/12');
    expect(installmentStem('ACADEMIA ACQUA 2/12', 2, 12)).toBe('ACADEMIA ACQUA');
  });

  test('label pads like the bank', () => {
    expect(installmentLabel('ACADEMIA ACQUA', 3, 12)).toBe('ACADEMIA ACQUA 03/12');
  });
});

describe('addMonthsIso', () => {
  test('adds calendar months and clamps the day', () => {
    expect(addMonthsIso('2026-11-05', 1)).toBe('2026-12-05');
    expect(addMonthsIso('2026-11-05', 2)).toBe('2027-01-05');
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsIso('2026-01-31', 2)).toBe('2026-03-31');
  });
});

describe('projectUpcomingInstallments', () => {
  test('2/12 seen: 3..12 upcoming, monthly from the latest row, same amount and category', () => {
    const out = projectUpcomingInstallments([
      row({ id: 'a1', description: 'ACADEMIA ACQUA 01/12', date: '2026-10-05', raw: raw(1, 12) }),
      row({ id: 'a2', description: 'ACADEMIA ACQUA 02/12', date: '2026-11-05', raw: raw(2, 12) }),
    ]);
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual({
      id: 'installment:a2:3',
      sourceId: 'a2',
      accountId: 'card',
      date: '2026-12-05',
      amount: -150_000,
      categoryId: 'cat-gym',
      stem: 'ACADEMIA ACQUA',
      number: 3,
      total: 12,
      label: 'ACADEMIA ACQUA 03/12',
    });
    expect(out.at(-1)).toMatchObject({ number: 12, date: '2027-09-05', label: 'ACADEMIA ACQUA 12/12' });
  });

  test('12/12 seen: complete, nothing upcoming', () => {
    expect(
      projectUpcomingInstallments([row({ description: 'ACADEMIA ACQUA 12/12', date: '2027-09-05', raw: raw(12, 12) })]),
    ).toEqual([]);
  });

  test('pending 1/4 of 4: three upcoming', () => {
    const out = projectUpcomingInstallments([
      row({ id: 'c1', description: 'CCT CLINICA CIR 01/04', date: '2026-12-05', raw: raw(1, 4, { status: 'PENDING' }) }),
    ]);
    expect(out.map((p) => [p.number, p.date])).toEqual([
      [2, '2027-01-05'],
      [3, '2027-02-05'],
      [4, '2027-03-05'],
    ]);
  });

  test('a later real installment replaces its placeholder (no stale projection)', () => {
    const first = [row({ id: 'm1', description: 'MERCADOLIVRE*MERCA01/02', date: '2026-10-20', raw: raw(1, 2) })];
    expect(projectUpcomingInstallments(first).map((p) => p.label)).toEqual(['MERCADOLIVRE*MERCA 02/02']);
    const second = [...first, row({ id: 'm2', description: 'MERCADOLIVRE*MERCA02/02', date: '2026-11-20', raw: raw(2, 2) })];
    expect(projectUpcomingInstallments(second)).toEqual([]);
  });

  test('anticipation: 4/4 posted plus its phantom pending copy projects nothing', () => {
    expect(
      projectUpcomingInstallments([
        row({ id: 'p3', description: 'PortovalleAcabame 03/04', date: '2026-08-06', amount: -13_339_130, raw: raw(3, 4) }),
        row({ id: 'p4', description: 'PortovalleAcabame 04/04', date: '2026-09-06', amount: -13_339_130, raw: raw(4, 4) }),
        row({
          id: 'p4x',
          description: 'PortovalleAcabame 04/04',
          date: '2026-11-05',
          amount: -13_339_130,
          raw: raw(4, 4, { status: 'PENDING' }),
        }),
      ]),
    ).toEqual([]);
  });

  test('same-number tie anchors on the posted row, not the later pending copy', () => {
    const out = projectUpcomingInstallments([
      row({ id: 'posted', description: 'LOJA X 02/03', date: '2026-09-06', raw: raw(2, 3) }),
      row({ id: 'pending', description: 'LOJA X 02/03', date: '2026-11-05', raw: raw(2, 3, { status: 'PENDING' }) }),
    ]);
    expect(out).toEqual([expect.objectContaining({ id: 'installment:posted:3', date: '2026-10-06' })]);
  });

  test('purchases are told apart by account, purchase date, stem and total', () => {
    const out = projectUpcomingInstallments([
      row({ description: 'LOJA 01/03', date: '2026-11-01', raw: raw(1, 3, { purchaseDate: '2026-10-01' }) }),
      row({ description: 'LOJA 01/03', date: '2026-11-02', raw: raw(1, 3, { purchaseDate: '2026-10-15' }) }),
      row({ description: 'LOJA 01/02', date: '2026-11-03', raw: raw(1, 2, { purchaseDate: '2026-10-01' }) }),
      row({ accountId: 'card2', description: 'LOJA 01/03', date: '2026-11-04', raw: raw(1, 3, { purchaseDate: '2026-10-01' }) }),
      row({ description: 'OUTRA 01/03', date: '2026-11-05', raw: raw(1, 3, { purchaseDate: '2026-10-01' }) }),
    ]);
    expect(out).toHaveLength(2 + 2 + 1 + 2 + 2);
  });

  test('rows of one purchase group despite spacing differences in the stem', () => {
    const out = projectUpcomingInstallments([
      row({ description: 'PET LOVE*Clube NE803/12', date: '2026-10-01', raw: raw(3, 12) }),
      row({ description: 'PET LOVE*Clube  NE8 04/12', date: '2026-11-01', raw: raw(4, 12) }),
    ]);
    expect(out[0]).toMatchObject({ number: 5, date: '2026-12-01' });
    expect(out).toHaveLength(8);
  });

  test('deleted rows count as seen but never anchor a purchase alone', () => {
    expect(
      projectUpcomingInstallments([row({ description: 'LOJA 01/03', date: '2026-11-01', raw: raw(1, 3), deleted: true })]),
    ).toEqual([]);
    const out = projectUpcomingInstallments([
      row({ description: 'LOJA 01/03', date: '2026-10-01', raw: raw(1, 3) }),
      row({ id: 'gone', description: 'LOJA 02/03', date: '2026-11-01', raw: raw(2, 3), deleted: true }),
    ]);
    expect(out).toEqual([expect.objectContaining({ number: 3, date: '2026-12-01' })]);
  });

  test('rows without installment metadata are ignored', () => {
    expect(projectUpcomingInstallments([row({ description: 'ACADEMIA ACQUA 02/12', date: '2026-11-05', raw: null })])).toEqual([]);
  });
});

describe('paidInstallmentKey', () => {
  test('same purchase and installment match whatever the spacing and case', () => {
    expect(paidInstallmentKey('card', '2026-05-01', 'PortovalleAcabame', 4, 4)).toBe(
      paidInstallmentKey('card', '2026-05-01', ' portovalleacabame ', 4, 4),
    );
    expect(paidInstallmentKey('card', '2026-05-01', 'PortovalleAcabame', 4, 4)).not.toBe(
      paidInstallmentKey('card', '2026-05-01', 'PortovalleAcabame', 3, 4),
    );
  });
});
