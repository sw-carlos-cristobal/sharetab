# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in ShareTab, please report it responsibly by emailing:

**sw.carlos.cristobal@gmail.com**

Please include:

- A description of the vulnerability
- Steps to reproduce it
- The potential impact
- Any suggested fixes (optional)

We will acknowledge your report within 48 hours and aim to release a fix within 14 days depending on severity.

Please do not open a public GitHub issue for security vulnerabilities.

## Supported Versions

This project is self-hosted and users are responsible for keeping their instance up to date. ShareTab no longer publishes numbered releases (the last was v0.8.0); each push to `main` is published as a new build. Security fixes ship in the next build and reach the `:stable` image when that build is promoted, so run the current `:stable` (or `:latest`) image, or rebuild from the current `main`. See [Upgrading](README.md#upgrading).

## Scope

Vulnerabilities of interest include but are not limited to:

- Authentication bypass or session hijacking
- Unauthorized access to another user's data (groups, expenses, receipts)
- SQL injection or ORM query manipulation
- Path traversal in file upload/serving endpoints
- XSS or CSRF vulnerabilities
- Insecure direct object references

## Out of Scope

- Vulnerabilities that require physical access to the host machine
- Issues in third-party dependencies (report those upstream)
- Self-inflicted issues from misconfigured deployments (e.g., exposing the admin panel to the public internet without auth)
