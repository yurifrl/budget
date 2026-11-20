/**
 * The signed-in user's own features. Api only: a client uses it to show or
 * hide; the API enforces each feature itself, so nothing here is a permission.
 */
import { z } from '../../zod';

import { defineOperation, type OperationExpose } from '../../operation-contract';
import { myFeaturesSchema } from './outputs';

const EXPOSE_API_ONLY: OperationExpose = { api: true, cli: false, mcp: false };

export const featuresMine = defineOperation({
  name: 'features_mine',
  description: 'The features of the signed-in user, each on or off (own override, else the everyone value, else the default).',
  input: z.object({}),
  output: myFeaturesSchema,
  method: 'GET',
  path: '/features',
  kind: 'read',
  expose: EXPOSE_API_ONLY,
});
