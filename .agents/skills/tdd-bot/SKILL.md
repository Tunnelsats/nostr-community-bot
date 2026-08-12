---
name: tdd-bot
description: Skill for running Test-Driven Development loops and verifying Nostr community bot feature additions.
---

# TDD Bot Development Skill

When adding new commands, event parsers, or relay handlers to `nostr-community-bot`:

1. **Step 1: Write Test First (Red)**
   - Add test cases in `src/__tests__/`.
   - Run `npm test` and verify the test fails for the right reason.

2. **Step 2: Implement Feature (Green)**
   - Write the minimum implementation code in `src/`.
   - Run `npm test` and ensure all tests pass.

3. **Step 3: Refactor & Audit (Clean)**
   - Clean up types in `src/types.ts`.
   - Run `npm run lint` and `npm run build`.
   - Verify `npm audit` has zero vulnerabilities.
