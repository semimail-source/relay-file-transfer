# Security Policy

Please do not publish unpatched security vulnerabilities in a public issue.
Use GitHub's **Security → Report a vulnerability** flow so the report can be
reviewed privately.

Never include live room links, pickup codes, administrator tokens, TURN
credentials, Redis credentials, or copied environment files in a report.

Relay is designed so that file contents and file names are end-to-end encrypted
in the browser. The signaling service still observes operational metadata such
as connection timing, approximate message sizes, and network addresses visible
to normal web infrastructure.
