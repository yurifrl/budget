// Throwaway stub API for a UI-only smoke test: answers the session probe and
// returns empty lists, so the shell renders without the real API.
const ORIGIN = 'http://127.0.0.1:8094';
const cors = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
};
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { ...cors, 'content-type': 'application/json' } });
const budget = { id: 'b-1', name: 'Casa', archived_at: null };
Bun.serve({
  port: 8093,
  hostname: '127.0.0.1',
  fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const p = new URL(req.url).pathname;
    if (p === '/auth/me' || p === '/me')
      return json({ id: 'u-1', email: 'smoke@example.com', name: 'Smoke Test', role: 'user', avatar: { seed: 'smoke', image_version: null } });
    if (p === '/budgets') return json([budget]);
    if (p === '/budget-revision') return json({ revision: 1 });
    if (p === '/connections/sync-status') return json({ scheduler_degraded: false, connections: [] });
    if (p === '/connections/settings') return json({});
    if (p.startsWith('/connections')) return json([]);
    return json([]);
  },
});
console.log('stub api on 8093');
