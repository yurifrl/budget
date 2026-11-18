import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from './api';

/** Hash route: `#/runs/<id>` → `/runs/<id>`. */
export function useHashPath(): string {
  const [path, setPath] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setPath(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return path;
}

/** Fetch + poll. `deps` re-fetches; `intervalMs` auto-refreshes without clearing the data. */
export function usePolled<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError('network', String(e)));
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), intervalMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, reload]);

  return { data, error, reload };
}
