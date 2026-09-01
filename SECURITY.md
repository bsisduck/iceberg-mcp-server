# Security policy

## Supported versions

The current `0.1.x` line receives security fixes. Older development snapshots are not supported.

## Report a vulnerability

Do not include vulnerability details, credentials, catalog metadata, or exploit code in a public
issue.

Use the repository host's private vulnerability-reporting feature when it is available. If the host
does not provide one, open a public issue containing only a request for private maintainer contact.
Wait for a private channel before sending technical details.

Include the affected version or commit, impact, reproduction conditions, and a minimal proof of
concept. Remove real credentials and private catalog data. State whether the issue affects stdio,
HTTP transport, Javadoc retrieval, source access, catalog access, or packaging.

The maintainer and reporter should agree on a disclosure date after they understand the impact and
have a fix or mitigation. Do not test against systems or catalogs you do not own or have permission
to assess.

## Deployment reports

This policy covers defects in this repository. Misconfigured proxies, overly privileged catalog
accounts, vendor-specific catalog behavior, and compromised client machines need to be handled by
their operators. The deployment boundaries are documented in [docs/security.md](docs/security.md)
and [docs/deployment.md](docs/deployment.md).
