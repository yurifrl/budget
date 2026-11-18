/**
 * The one zod export. `shared/` owns the zod dependency; client/ and api/
 * import zod only through `@shared/zod` so every runtime has exactly one zod
 * instance (shared/node_modules/zod). A lint rule bans direct `zod` imports
 * outside shared/.
 */
export * from 'zod';
export { z } from 'zod';
