/**
 * Browser stand-in for OAuth end-to-end runs against a server with auth ON.
 *
 *   bun scripts/e2e-consent.ts <authorize-url>
 *
 * Mints a session cookie (issueSession, signed with SESSION_SECRET) for
 * E2E_EMAIL, loads the consent page, POSTs the approval with its CSRF token
 * and Origin, then follows the redirect to the client's loopback callback.
 * Env: SESSION_SECRET, E2E_EMAIL, optional E2E_DECISION (approve|deny).
 */
import { issueSession } from '../src/user/auth';

/** Approve (or deny) the consent for `url`; resolves to the client callback's HTTP status. */
export async function approve(url: string, log: (s: string) => void = console.error): Promise<number> {
  const secret = process.env.SESSION_SECRET;
  const email = process.env.E2E_EMAIL;
  if (!secret || !email) throw new Error('SESSION_SECRET and E2E_EMAIL are required');
  const cookie = `budget_session=${await issueSession(secret, email, 600)}`;
  const origin = new URL(url).origin;

  const page = await fetch(url, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  if (page.status !== 200) throw new Error(`consent page: HTTP ${page.status}`);
  const html = await page.text();
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(m[0])?.[1];
    const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? '';
    if (name)
      fields[name] = value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
  }
  if (!fields.csrf) throw new Error('consent page has no csrf field');
  fields.decision = process.env.E2E_DECISION ?? 'approve';

  const post = await fetch(`${origin}/oauth/authorize`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  const location = post.headers.get('location');
  log(
    `consent POST -> HTTP ${post.status}; redirect to ${location?.replace(/code=[^&]+/, 'code=<redacted>')}`,
  );
  if (post.status !== 303 || !location)
    throw new Error(`approval failed: HTTP ${post.status} ${(await post.text()).slice(0, 200)}`);
  const cb = await fetch(location, { redirect: 'manual' });
  log(`callback -> HTTP ${cb.status}`);
  return cb.status;
}

if (import.meta.main) {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: SESSION_SECRET=… E2E_EMAIL=… bun scripts/e2e-consent.ts <authorize-url>');
    process.exit(2);
  }
  await approve(url);
}
