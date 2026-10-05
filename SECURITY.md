# Security Policy

## Supported versions

Gilbert is under active development. Security fixes are applied to `main`, which
is what the container images publish from; older tags are not guaranteed to
receive backported fixes.

| Version         | Supported          |
| --------------- | ------------------ |
| `main` (latest) | :white_check_mark: |
| Older releases  | :x:                |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** A public issue is
visible to everyone, including whoever would use it, before there is a fix.

Report it privately through GitHub: **Security → Report a vulnerability** on this
repository, which opens a private advisory only the maintainers can see. Please
include, as precisely as you can:

- what the problem is, and how to reproduce it;
- the version or commit it affects — the running build shows it in
  **Settings › About**;
- whether you believe the fault is in Gilbert, in how it talks to Stalwart over
  JMAP, or in a dependency.

## What happens next

- **Acknowledgement**, with a first read on severity.
- **Assessment.** Gilbert holds no data of its own — everything durable lives in
  Stalwart — so some reports turn out to be the server's rather than the client's.
  Those are routed to the
  [Stalwart Mail Server](https://github.com/stalwartlabs/mail-server) project,
  and you will be told which way the report went.
- **Fix and disclosure.** The fix lands on `main` and the advisory is published
  once it is available, crediting you unless you would rather stay anonymous.

## Scope

Examples rather than a list:

- authentication and session handling in Gilbert's server;
- the trust boundary around credentials the browser never holds;
- HTML sanitisation, and the image proxy (SSRF);
- the content-security policy, and the container's read-only posture
  (`IMMUTABLE=1`);
- dependency vulnerabilities that are actually reachable in Gilbert's usage.

Out of scope: anything that needs an already-administrative Stalwart account in
order to do what that account may already do, and reports about Stalwart itself
— which belong upstream, as above.
