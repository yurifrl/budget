import { describe, expect, test } from 'bun:test';

import { snakeImportRow } from './mapping';
import { externalAccountFromWire, upstreamFromWire, type ConnectionUpstreamWire } from './connections';

describe('upstream accounts: milliunits on the wire, cents in the app', () => {
  test('balance and every credit figure are converted; other fields pass through', () => {
    const app = externalAccountFromWire({
      externalId: 'x1',
      name: 'Card',
      type: 'CREDIT',
      currencyCode: 'BRL',
      balance: -100_250,
      institution: 'Bank',
      linkedAccountId: 'acc-1',
      credit: {
        limit: 84_260_000,
        available: 43_822_180,
        used: 40_437_820,
        minimumPayment: 2_673_380,
        dueDate: '2026-11-05',
        latestBill: { total: 17_123_340, dueDate: '2026-11-05', minimumPayment: null },
      },
    });
    expect(app).toEqual({
      externalId: 'x1',
      name: 'Card',
      type: 'CREDIT',
      currencyCode: 'BRL',
      balanceCents: -10_025,
      institution: 'Bank',
      linkedAccountId: 'acc-1',
      credit: {
        limitCents: 8_426_000,
        availableCents: 4_382_218,
        usedCents: 4_043_782,
        minimumPaymentCents: 267_338,
        dueDate: '2026-11-05',
        latestBill: { totalCents: 1_712_334, dueDate: '2026-11-05', minimumPaymentCents: null },
      },
    });
  });

  test('null balance stays null; BANK accounts carry no credit key; a failed connection keeps accounts null', () => {
    const rows: ConnectionUpstreamWire[] = [
      {
        connection: { id: 'c1' } as ConnectionUpstreamWire['connection'],
        accounts: [{ externalId: 'a', name: 'A', type: 'BANK', currencyCode: null, balance: null, institution: null, linkedAccountId: null }],
      },
      { connection: { id: 'c2' } as ConnectionUpstreamWire['connection'], accounts: null },
    ];
    const out = upstreamFromWire(rows);
    expect(out[0]!.accounts![0]).toEqual({
      externalId: 'a',
      name: 'A',
      type: 'BANK',
      currencyCode: null,
      balanceCents: null,
      institution: null,
      linkedAccountId: null,
    });
    expect(out[1]!.accounts).toBeNull();
  });
});

describe('statement import rows go out in milliunits', () => {
  test('snakeImportRow converts the parsed cents', () => {
    expect(
      snakeImportRow({ date: '2026-01-02', payee: 'Shop', memo: '', outflowCents: 1234, inflowCents: 0 } as never),
    ).toEqual({ date: '2026-01-02', payee: 'Shop', category_id: null, memo: '', outflow: 12340, inflow: 0 });
  });
});
