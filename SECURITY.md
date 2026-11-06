# Security policy

Nullbin is security software. Thank you for helping keep it safe.

## Reporting a vulnerability

**Email [hi@jacobzymet.com](mailto:hi@jacobzymet.com). Never open a public
issue, discussion or pull request for a security problem.**

Describe the issue, how to reproduce it, and its impact.

Do not include real paste links, keys or other people's data in a report.
Use test pastes you created.

What to expect:

- An acknowledgement within 7 days.
- An assessment and a plan (or questions) within 14 days.
- A fix and a coordinated disclosure date agreed with you. Credit in the
  advisory if you want it.

## Scope

In scope: anything that breaks the guarantees in
[THREAT_MODEL.md](THREAT_MODEL.md). For example, the server or storage
learning plaintext, keys, passwords or file names; undetected tampering or
truncation; a burn-after-reading paste delivered twice; reading or writing
outside the data directory; logging of IPs, IDs or tokens; CSP, SRI or
header bypasses; ways to run script from paste content; rate-limit or
`X-Forwarded-For` bypasses; non-reproducible release artifacts; and CI or
supply-chain weaknesses.

Out of scope, because they are documented limits: a malicious operator
serving modified JavaScript, metadata visible to the server (size, timing,
IPs), leaked links, interrupted burn downloads, and denial of service that
needs large distributed resources. Reports showing a cheaper way to do
these are still welcome.

## Supported versions

Only the latest release receives security fixes.
