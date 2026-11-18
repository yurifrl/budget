import type { z } from '@shared/zod';
import { contracts } from '@shared/contracts/jobs';
import type { InputSchema, OperationContract } from '@shared/operation-contract';

import { contractRequest } from '@shared/contract-request';

import type { JobRun, JobsHealth, RunDetail } from './types';

let apiUrl = (import.meta.env.VITE_API_URL ?? 'http://localhost:3100').replace(/\/+$/, '');

/** Runtime override: /config.json { "apiUrl": "https://api.example" } wins over the build-time VITE_API_URL. */
export async function loadConfig(): Promise<void> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok) return;
    const cfg = (await res.json()) as { apiUrl?: string };
    if (cfg.apiUrl) apiUrl = cfg.apiUrl.replace(/\/+$/, '');
  } catch {
    // no override
  }
}

export const getApiUrl = () => apiUrl;
/** The API's Google sign-in entry (sets the session cookie, then redirects to the app). */
export const loginUrl = () => `${apiUrl}/auth/google`;

export class ApiError extends Error {
  constructor(
    readonly status: number | 'network',
    message: string,
  ) {
    super(message);
  }
}

function contract(name: string): OperationContract {
  const found = contracts.find((c) => c.name === name);
  if (!found) throw new Error(`unknown contract ${name}`);
  return found;
}

async function call<T>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  const c = contract(name);
  const req = contractRequest(c as OperationContract<InputSchema>, input as z.input<InputSchema>);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.params ?? {})) if (v !== undefined) qs.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${req.url}${qs.size ? `?${qs}` : ''}`, {
      method: req.method ?? 'GET',
      credentials: 'include',
      headers: req.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });
  } catch (e) {
    throw new ApiError('network', e instanceof Error ? e.message : 'network error');
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep default
    }
    throw new ApiError(res.status, message);
  }
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}

export interface RunFilters {
  instance_id?: string;
  tenant_id?: string;
  job_type?: string;
  status?: string;
  limit: number;
  offset: number;
}

export const listRuns = (f: RunFilters) => call<{ runs: JobRun[]; total: number }>('jobs_list_runs', { ...f });
export const getRun = (id: string) => call<RunDetail>('jobs_get_run', { id });
export const retryRun = (id: string) => call<{ run: JobRun; created: boolean }>('jobs_retry_run', { id });
export const cancelRun = (id: string) => call<JobRun>('jobs_cancel_run', { id });
export const getHealth = () => call<JobsHealth>('jobs_health');
