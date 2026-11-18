/** HTML-escape for text and double-quoted attribute contexts. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ConsentView {
  clientName: string;
  redirectUri: string;
  scopes: string[];
  email: string;
  action: string;
  /** Hidden form fields to round-trip (all values escaped on render). */
  fields: Record<string, string>;
}

export function renderConsent(v: ConsentView): string {
  let host: string;
  try {
    const u = new URL(v.redirectUri);
    // Custom (non-web) schemes: show the scheme explicitly so the user knows it opens a desktop app.
    host = u.protocol === 'https:' || u.protocol === 'http:' ? u.host : `${u.protocol}//${u.host}`;
  } catch {
    host = '(invalid)';
  }
  const hidden = Object.entries(v.fields)
    .map(([k, val]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(val)}">`)
    .join('\n');
  const scopes = v.scopes
    .map((s) => `<li>${s === 'write' ? 'Make changes to your budget data' : 'View your budget data'}</li>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize access - Budget</title>
<style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111}
.box{border:1px solid #ddd;border-radius:12px;padding:1.5rem}code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px;word-break:break-all}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #888;cursor:pointer;margin-right:.5rem}
button.ok{background:#111;color:#fff;border-color:#111}</style></head>
<body><div class="box">
<h1>Authorize <strong>${escapeHtml(v.clientName)}</strong>?</h1>
<p>Signed in as <strong>${escapeHtml(v.email)}</strong>.</p>
<p>This application will be sent back to <code>${escapeHtml(host)}</code> and will be able to:</p>
<ul>${scopes}</ul>
<form method="post" action="${escapeHtml(v.action)}">
${hidden}
<button class="ok" type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form></div></body></html>`;
}

export function renderError(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head>
<body style="font:16px system-ui,sans-serif;max-width:28rem;margin:4rem auto"><h1>Cannot authorize</h1><p>${escapeHtml(message)}</p></body></html>`;
}
