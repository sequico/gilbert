/**
 * Whether this build stubs the phone for the mock (ADR 0023).
 *
 * The mock has no bridge, so the media path can never be proven and the handset
 * would never be offered — which makes the surface impossible to look at in
 * `dev:mock`. With `VITE_PHONE_MOCK=1` (set by that script alone) the phone
 * pretends the bridge is there and the line is registered, so the UI can be
 * seen and driven with no Janus at all. A production build never carries the
 * flag, so nothing here reaches a real deployment.
 */
export const PHONE_MOCK = import.meta.env.VITE_PHONE_MOCK === "1";
