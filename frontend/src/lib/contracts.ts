/**
 * Frontend re-export of the shared zod contracts.
 *
 * Imports from `backend/src/shared/contracts.ts` via a relative path so the
 * frontend bundle stays aware of any breaking changes to the wire types.
 * Vite + tsc traverse this happily; no special build setup required.
 */

export * from '../../../backend/src/shared/contracts';
