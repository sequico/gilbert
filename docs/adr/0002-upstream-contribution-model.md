# ADR 0002 — Upstream is download-only

Status: Accepted (2026-09-07)

> **Owner decision (2026-09-07):** "upstream contribution is download-only —
> we contribute nothing back to upstream" — upstream is consumed, never
> contributed to.

## Context

Gilbert's mail client is based on
[Coffey-Labs/ihasmail](https://github.com/Coffey-Labs/ihasmail). An earlier
draft of this ADR designed an upstream-shaped contribution model — common
mail-core work prepared in a fork cut from `upstream/main` and offered back to
Coffey-Labs/ihasmail as pull requests. The owner decided the other way:
nothing flows back. Upstream releases keep flowing in; no work flows out.

## Decision

1. Upstream is **download-only**. `sync-upstream.yml` keeps mirroring upstream
   releases onto the `ihasmail` branch; the mail core merges them in, with
   Gilbert's identifiers applied by the rename layer (see `gilbert-branding`).
2. **No contributions back.** No upstream-shaped fork, no un-renaming
   patches, no PRs to Coffey-Labs/ihasmail. Common work that upstream might
   once have accepted simply lives here, renamed or not.
3. Attribution is unchanged: the mail core is a derivative work of ihasmail;
   `NOTICE` carries Coffey Labs' **attribution** — the copyright in this
   derivative is Sequi Company's — and upstream URLs stay linked.

## Consequences

- No fork maintenance, no extraction projects, no upstream review cycle.
- Divergence from upstream is accepted and can grow; sync conflicts are
  Gilbert's own to resolve at merge time.
- The upstream-shaped working area disappears from every workflow and skill.

## References

- `.github/workflows/sync-upstream.yml` — the download path (unchanged)
