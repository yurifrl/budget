/**
 * Credential store: one JSON file, keyed by API base URL.
 *
 *   $XDG_CONFIG_HOME/budget/credentials.json   (default ~/.config/budget/...)
 *
 * File mode 0600, directory 0700. Writes are atomic (temp file + rename) so a
 * crash can never leave a half-written file — and, because refresh tokens
 * rotate, a rotated token is always persisted BEFORE it is used.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

export interface StoredCredentials {
  client_id: string;
  access_token: string;
  /** Epoch milliseconds at which the access token expires. */
  expires_at: number;
  refresh_token: string;
  scope?: string;
}

interface CredentialFile {
  version: 1;
  servers: Record<string, StoredCredentials>;
}

/** Config directory from an env-like object (the entrypoint passes process.env). */
export function resolveConfigDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.startsWith('/')) return join(xdg, 'budget');
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  return join(home, '.config', 'budget');
}

/** Canonical key for an API URL: no trailing slash. */
export function normalizeApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export class CredentialStore {
  readonly file: string;
  constructor(private readonly dir: string) {
    this.file = join(dir, 'credentials.json');
  }

  private readAll(): CredentialFile {
    if (!existsSync(this.file)) return { version: 1, servers: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<CredentialFile>;
      if (parsed && typeof parsed === 'object' && parsed.servers && typeof parsed.servers === 'object') {
        return { version: 1, servers: parsed.servers };
      }
    } catch {
      // corrupt file: treated as empty; the next save replaces it
    }
    return { version: 1, servers: {} };
  }

  private writeAll(data: CredentialFile): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `.credentials.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  get(apiUrl: string): StoredCredentials | undefined {
    return this.readAll().servers[normalizeApiUrl(apiUrl)];
  }

  save(apiUrl: string, creds: StoredCredentials): void {
    const data = this.readAll();
    data.servers[normalizeApiUrl(apiUrl)] = creds;
    this.writeAll(data);
  }

  delete(apiUrl: string): void {
    const data = this.readAll();
    delete data.servers[normalizeApiUrl(apiUrl)];
    this.writeAll(data);
  }

  /**
   * Cross-process mutex (O_EXCL lock file) so two CLI invocations never refresh
   * the same rotating token concurrently — the loser would present a spent
   * refresh token, which revokes the whole grant.
   */
  async withLock<T>(fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = join(this.dir, 'credentials.lock');
    const start = Date.now();
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx', 0o600));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true }); // stale
        } catch {
          // vanished: retry
        }
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the credentials lock');
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }
}
