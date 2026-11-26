import { describe, expect, test } from 'bun:test';

import { isPickableCategory, pickableCategories } from './pickable';

const groups = [
  { id: 'g1' },
  { id: 'g2', isCreditCardPayments: true },
  { id: 'g3', internal: true },
];

describe('pickable categories', () => {
  const cats = [
    { id: 'a', groupId: 'g1' },
    { id: 'b', groupId: 'g2' },
    { id: 'c', groupId: 'g3' },
    { id: 'd', groupId: 'g1', internal: true },
    { id: 'e', groupId: 'g1' },
  ];

  test('credit card payment categories and internal ones are not offered', () => {
    expect(pickableCategories(cats, groups).map((c) => c.id)).toEqual(['a', 'e']);
  });

  test('a category of an unknown group is offered', () => {
    expect(isPickableCategory({ groupId: 'nope' }, groups)).toBe(true);
  });
});
