import { expect, test } from 'bun:test';

import { avatarImageUri } from './url';

test('builds a versioned avatar URL and tolerates trailing slashes', () => {
  expect(avatarImageUri('http://localhost:3000/', 'abc', 4)).toBe('http://localhost:3000/users/abc/avatar?v=4');
  expect(avatarImageUri('https://api.x.dev', 'a b', 1)).toBe('https://api.x.dev/users/a%20b/avatar?v=1');
});
