/**
 * The one loose object type the mock's own modules share.
 *
 * The mock writes its answers as plain objects and hands them between its
 * modules; each had declared `Record<string, unknown>` for itself, which is
 * the same type with three homes. One here, so the shape a rule helper takes
 * and the shape the server values have cannot drift.
 */
export type Obj = Record<string, unknown>;
