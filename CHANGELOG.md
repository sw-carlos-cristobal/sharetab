# Changelog

## [v0.5.10] - 2026-04-13

### Features
- add OpenAI Codex OAuth support (#73) (481aad7)

**Full Changelog**: https://github.com/sw-carlos-cristobal/sharetab/compare/v0.4.3...v0.5.10

## [v0.4.3] - 2026-04-06

### Other Changes
- docs: expand startup config summary with provider and auth readiness details

**Full Changelog**: https://github.com/sw-carlos-cristobal/sharetab/compare/v0.4.2...v0.4.3


## [v0.4.2] - 2026-04-06

### Bug Fixes
- add claude wrapper and persistent meridian auth (2a0aacc)

### Other Changes
- docs: add LOG_LEVEL and rate limit env vars to Unraid template (72a7a32)

**Full Changelog**: https://github.com/sw-carlos-cristobal/sharetab/compare/v0.4.1...v0.4.2


## [v0.4.1] - 2026-04-06

### Bug Fixes
- wrap expense+assignments+activity in single transaction for atomicity (#47) (c6e7213)
- invalidate AI provider cache on extraction failure and retry (#46) (8e5fc3a)

### Other Changes
- test: cleanup e2e tests, add guest remapping regression, and retry dedup test (#50, #53, #54, #55, #56, #59) (35c0e4e)
- test: make registry fallback test deterministic and add cache transition tests (#48, #52, #57) (99bd537)
- docs: update AI provider docs, add OPENAI_MODEL/MERIDIAN_PORT, and v0.4.0 changelog (#60, #61, #62, #63, #64, #65, #66) (390e47e)

**Full Changelog**: https://github.com/sw-carlos-cristobal/sharetab/compare/v0.4.0...v0.4.1


## [v0.4.0] - 2026-04-05

### Features
- add OCR receipt scanning fallback via Tesseract.js — no API key needed (24febc7)
- comprehensive OCR parser improvements and 50 unit tests (a0ad840)
- OCR image preprocessing and distorted receipt tests (26596c2)
- add receipt ownership (uploadedById) to fix cross-user access (9943c71)
- add mock AI provider and SMTP server for CI testing (7e02ec5)

### Bug Fixes
- separator-aware date disambiguation and undefined for unparseable dates (#45, #49) (37c75ed)
- invalidate AI provider cache on extraction failure and retry (#46) (8e5fc3a)
- wrap expense+assignments+activity in single transaction for atomicity (#47) (c6e7213)
- normalize receipt dates to ISO YYYY-MM-DD format (#33) (7e8815b)
- validate assignment indices before blank-name filtering in createSplit (9b1afe6)
- batch receipt item assignments with deleteMany+createMany in transaction (#30) (7a45f82)
- make OpenAI model configurable via OPENAI_MODEL env var (#27) (f900245)
- make Meridian port configurable, validate health in isAvailable (#26) (f3c0b35)
- retryProcessing now actually reprocesses the receipt (#28) (239d0a0)
- validate payer, assignees, and item IDs in receipt-to-expense (#17) (ee8b904)
- filter blank names and remap indices in guest.createSplit (#38) (ee5a937)
- block receipt-to-expense creation on archived groups (#39) (097b071)
- scope OCR O→0 normalization to price context only (#32) (2e2e26e)
- validate OPENAI_API_KEY before constructing provider (#24) (0c1f65f)
- data integrity — dedup items, preserve on failure, fix tax split, reject negative prices (7f0354d)

### Security
- fix 6 vulnerabilities in upload, AI, and guest flows (35613f7)
- address CI audit and secret-handling review feedback (eed32fd)

### Tests
- add guest API security tests and OCR regression tests (#43, #20) (584c7e0)
- add 10 photorealistic receipt OCR tests (dbb8bc0)
- add 22 real-world receipt images for OCR testing (384af46)
- add fallback test for isAvailable() returning false (#35) (093de26)

### Other Changes
- refactor: extract normalizeDate to its own module for testability (1526138)
- perf: cache AI provider with 60s TTL to avoid repeated isAvailable() calls (#31) (ff6258f)

**Full Changelog**: https://github.com/sw-carlos-cristobal/sharetab/compare/v0.3.0...v0.4.0

## [v0.3.0] - 2026-04-01

### Features
- add server logs viewer to admin dashboard (1f9f84f)

**Full Changelog**: https://github.com/sw-carlos-cristobal/sharetab/compare/v0.2.0...v0.3.0


## [v0.2.0] - 2026-04-01

### Features
- add release workflow with semver and changelog (b9fb31d)
- print config summary on container startup (6ecfa16)
- add ADMIN_EMAIL to Unraid template (ae4ec66)
- add admin dashboard with system health, user/group management, and storage stats (0bdb57d)
- add receipt rescan with user correction prompt (478a293)
- add group archiving with toggle filter and full test coverage (9964b37)
- embed Meridian proxy for Claude Max receipt scanning; remove claude-sdk (9021488)
- add Meridian proxy support for fast Claude Max receipt scanning (0570af3)
- allow editing and deleting placeholder members (c21ccd9)
- add From/To fields to settle-up dialog (2341b59)
- add zoom and pan to receipt image viewer (ae1df47)
- mount Claude credentials file for auto-refreshing claude-sdk token (777a34c)
- add "Forgot password?" link on login page (f00ab38)
- add password change flow on settings page (0771ef9)
- allow logged-in users to access guest split flow (3219d5f)
- add dev-start.sh for local development without Docker (6748ed8)
- add dev-stop.sh to stop local postgres cluster (a656f93)
- emerald theme with dark mode, per-person dashboard debts, group search, and sticky sidebar (22eff3f)
- add guest bill splitting, shareable links, magic link auth, and humorous loading messages (e6fb149)
- add expense edit page (56c00f9)
- add structured JSON logging for Docker container logs (047ef96)
- add receipt image preview and editable items (7339b3a)
- add pending receipts and placeholder members (350725f)
- add claude-sdk provider using Agent SDK for Max/Pro subscriptions (e5986a3)
- fix Claude OAuth with anthropic-beta header + add test receipt (86e8271)
- add Claude OAuth token support for AI provider (8b018fa)
- bundle PostgreSQL inside Docker container (all-in-one) (c43e486)
- add Unraid template, image serving, and Docker hardening (Phase 6) (52d8178)
- add PWA support, mobile nav, auth middleware, and seed data (Phase 5) (6f60a51)
- add settlement UI and AI receipt scanning (Phases 3+4) (94d8d65)
- implement Phase 1 (foundation) and Phase 2 (groups & expenses UI) (361c2ed)

### Bug Fixes
- stabilize admin and receipt-ui e2e tests (e84df7b)
- admin e2e test CI compatibility (19e5cfc)
- resolve build type error in getReceiptItems return type (811d2a7)
- address code quality and logic issues from codebase review (3dedee9)
- address security vulnerabilities, bugs, and code quality issues (58ecc5e)
- resolve remaining CI test failures (18a6e60)
- resolve CI test failures from group pagination (4827f24)
- expense list icon consistency, group pagination, and e2e test cleanup (071ca29)
- improve not-found UX, percentage split pre-fill, and back button navigation (c581d88)
- resolve infinite re-renders, nativeButton warnings, and settle dialog pre-population (5af854e)
- sidebar shows 'User' instead of name after profile update (e479339)
- resolve CRLF line endings in entrypoint; enforce LF for shell scripts (c4b8867)
- make credentials writable so SDK can auto-refresh expired tokens (132bb5e)
- resolve relative UPLOAD_DIR paths; fix settle dialog test selector (3728fdf)
- update 6 failing e2e tests to match current UI (6908e24)
- restore credentials symlink for meridian; add pending receipt delete button (43d9327)
- show user name in sidebar; optimize claude-sdk scan turns (5c28a68)
- redistribute expense shares when a placeholder member is removed (e2d95c7)
- pre-populate name field on settings page from session (4592996)
- restore o+x on /root dirs and chmod 644 credentials on every start (acd2e57)
- symlink claude credentials into nextjs home dir (9ddabf0)
- also chmod /root and /root/.claude dirs for nextjs traversal (be8faa1)
- chmod credentials file so nextjs user can read it (29c4803)
- bundle claude-agent-sdk in standalone and set HOME for nextjs user (28d999a)
- suppress Turbopack NFT tracing warning for resolve() calls (45e5891)
- install claude CLI in Docker image for claude-sdk AI provider (980d20a)
- mount Claude credentials as rw so SDK can refresh expired tokens (304710f)
- make auth rate limit configurable to prevent CI test failures (c9fceef)
- chown uploads dir on startup to fix receipt upload permission error (8340fc4)
- use 127.0.0.1 in HEALTHCHECK to avoid IPv6 resolution failure (d14843b)
- remove stale PostgreSQL PID file on container restart (e874f52)
- update Unraid community template with missing env vars and correct repo URLs (bb64048)
- tag image as sharetab:latest and fix postgres permissions on bind-mounts (d2fb05a)
- make Docker build work on Unraid with Prisma 7 (cb3175c)
- run prisma generate on startup to ensure client is up to date (e564d7c)
- remove --skip-generate flag, not valid in Prisma v7 db push (52859d4)
- support running dev scripts as root via postgres OS user delegation (83df5c4)
- move cleanup trap, add pg_isready timeout, fix executable bits (84b15e3)
- enable implicit TLS for SMTP port 465 in email provider (bbe1148)
- resolve sidebar Dashboard link test on expense edit page (5430300)
- resolve last 3 test failures from design/responsive changes (2298c66)
- remove fixed max-width that caused content clipping with sidebar (a643d44)
- mobile scroll and desktop content clipping (cfa869d)
- responsive layout improvements for all viewport sizes (75e78cf)
- use h-dvh for sidebar height and add responsive layout regression tests (8355035)
- make card grids responsive to actual available content width (f7dad41)
- prevent main content overflow on narrow browser windows (7b823fe)
- prevent sidebar bottom section from being cut off on short viewports (be427ba)
- hardcode Inter font stack in CSS theme instead of referencing CSS variables (9bbca79)
- resolve Base UI warnings, infinite re-render in expense form, and flaky e2e tests (f77aa1b)
- sidebar and mobile menu navigation on pages with forms (22e8887)
- back button navigation on expense pages (f7315f9)
- increase timeout for AI receipt tests — all 5 pass (73f0c21)
- upgrade OAuth model to claude-haiku-4-5 (494c1ed)

### Other Changes
- ci: add ADMIN_EMAIL to test workflow for admin page tests (4931adb)
- docs: add screenshots and visual demo to README (fca6012)
- docs: update CLAUDE.md and README.md with current state (4d6e339)
- docs: update .env.example with all available env vars (5d54f1b)
- test: add integration tests for balance calculation and AI provider registry (25236a2)
- test: add Vitest unit tests for core utility modules (efc17d6)
- refactor: distribute regression tests into feature files; update .env.example (03b47c1)
- test: add regression tests for exploratory testing fixes (4a3819b)
- test: add e2e test for profile name update reflecting in sidebar (051f09e)
- docs: update README and CLAUDE.md with recent features (4588a02)
- refactor: centralize upload dir resolution into getUploadDir() (803599f)
- ci: split test and docker build into independent workflows (ac760a0)
- ci: cancel in-progress runs when new code is pushed (76c1b66)
- test: add password change/forgot password tests + CI test pipeline (b86dcfd)
- ci: add GitHub Actions workflow to build and push Docker image to GHCR (457c3c7)
- docs: add AUTH_TRUST_HOST and email magic link vars to README (f77d487)
- docs: add local dev setup implementation plan (f8af25d)
- docs: add local dev setup design spec (e1cfe34)
- test: add e2e tests for magic link auth flow (8d4e316)
- test: add e2e tests for guest bill split feature (d82c1ee)
- docs: document responsive layout architecture and testing practices (3edf700)
- test: add live viewport resize regression tests (4b5bdfe)
- refactor: switch card grids to container queries and auto-fit (a535873)
- test: add e2e tests for groups search and filter (9c563b7)
- test: add e2e tests for placeholders, pending receipts, and item editing (708b179)
- test: complete all Playwright e2e tests (120 tests, 16 suites) (250c6ef)
- test: add comprehensive API and edge case e2e tests (223c127)
- test: add Playwright e2e tests covering functional test cases (d43f1f0)

**Full Changelog**: https://github.com/sw-carlos-cristobal/sharetab/compare/92b5f884079ffdf8ecf776d36364cce52e434216...v0.2.0


All notable changes to ShareTab will be documented in this file.

This project uses [Semantic Versioning](https://semver.org/) and [Conventional Commits](https://www.conventionalcommits.org/).

Releases are created via the [Release workflow](../../actions/workflows/release.yml).
