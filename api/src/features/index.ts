/**
 * Features barrel: the only import surface for other api features.
 *
 * `isEnabled(db, feature, userId)` is how a handler or a Temporal activity
 * enforces a feature (never a workflow file: see ./evaluate.ts). The feature
 * list itself lives in @shared/features.
 */
export { isEnabled, evaluateFeatures } from './evaluate';
export { featuresRoutes, operations } from './routes';
