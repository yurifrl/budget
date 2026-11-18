import { helloGet, helloOutput, type HelloOutput } from '@shared/contracts/hello';
import { inputLocations } from '@shared/operation-contract';
import type { z } from '@shared/zod';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3100';

type HelloInput = z.input<typeof helloGet.input>;

/** Build the request URL for hello_get from the shared contract (path + query keys). */
export function helloUrl(base: string, input: HelloInput = {}): string {
  const url = new URL(helloGet.path, base);
  for (const key of inputLocations(helloGet).query) {
    const value = input[key as keyof HelloInput];
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function fetchHello(
  input: HelloInput = {},
  { base = API_URL, fetchImpl = fetch }: { base?: string; fetchImpl?: typeof fetch } = {},
): Promise<HelloOutput> {
  const res = await fetchImpl(helloUrl(base, helloGet.input.parse(input)), { method: helloGet.method });
  if (!res.ok) throw new Error(`${helloGet.name} failed: HTTP ${res.status}`);
  return helloOutput.parse(await res.json());
}

export const helloContractName = helloGet.name;
