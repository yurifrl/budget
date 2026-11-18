import { defineOperation, EXPOSE_ALL } from '../operation-contract';
import { z } from '../zod';

export const helloGet = defineOperation({
  name: 'hello_get',
  description: 'Say hello. Phase 0 spike contract proving shared/ is consumed by client and api.',
  input: z.object({ name: z.string().min(1).optional() }),
  method: 'GET',
  path: '/hello',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const helloOutput = z.object({ message: z.string() });
export type HelloOutput = z.infer<typeof helloOutput>;
