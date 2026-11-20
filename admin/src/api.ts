import type { z } from '@shared/zod';
import { contracts as featureContracts, type AdminFeature } from '@shared/contracts/features';
import { contracts as jobContracts } from '@shared/contracts/jobs';
import {
  contracts as userContracts,
  type AdminUser,
  type AdminUserWithTempPassword,
  type meSchema,
} from '@shared/contracts/user';
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
    /** The API's machine-readable error code (`{ error, code }` body), when present. */
    readonly code?: string,
  ) {
    super(message);
  }
}

function contract(name: string): OperationContract {
  const found = [...jobContracts, ...userContracts, ...featureContracts].find((c) => c.name === name);
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
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body.error) message = body.error;
      code = body.code;
    } catch {
      // keep default
    }
    throw new ApiError(res.status, message, code);
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

export type { AdminUser, AdminUserWithTempPassword };
export type Me = z.infer<typeof meSchema>;

export const getMe = () => call<Me>('user_me_get');
export const listUsers = () => call<AdminUser[]>('user_admin_users_list');
export const createUser = (input: { email: string; name?: string; role?: 'admin' | 'user' }) =>
  call<AdminUserWithTempPassword>('user_admin_users_create', input);
export const updateUser = (input: { id: string; name?: string | null; role?: 'admin' | 'user'; status?: 'active' | 'disabled' }) =>
  call<AdminUser>('user_admin_users_update', input);
export const resetUserPassword = (id: string) => call<AdminUserWithTempPassword>('user_admin_users_reset_password', { id });
export const deleteUser = (id: string) => call<null>('user_admin_users_delete', { id });

export type { AdminFeature };

export const listFeatures = () => call<AdminFeature[]>('features_admin_list');
export const setFeatureEveryone = (key: string, value: boolean) => call<AdminFeature>('features_admin_set_everyone', { key, value });
export const clearFeatureEveryone = (key: string) => call<AdminFeature>('features_admin_clear_everyone', { key });
export const setFeatureUser = (key: string, userId: string, value: boolean) =>
  call<AdminFeature>('features_admin_set_user', { key, user_id: userId, value });
export const clearFeatureUser = (key: string, userId: string) => call<AdminFeature>('features_admin_clear_user', { key, user_id: userId });
