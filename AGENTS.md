# AGENTS.md — AI Agent Guidance for `nostr-community-bot`

This repository is **`nostr-community-bot`**, a standalone open-source TypeScript library for building Nostr bots (NIP-17/NIP-59 E2EE DMs, Armada Concord V2 communities, and NIP-29 groups).

## Working Discipline & Core Rules

1. **Test-Driven Development (TDD) Mandatory**:
   - Always follow the Red-Green-Refactor cycle.
   - Write failing unit tests in `src/__tests__/` BEFORE implementing new functions or command handlers.
   - Verify all tests pass with `npm test` (Vitest) before finalizing any task.

2. **Zero Vulnerabilities Policy**:
   - Never ignore security scanner warnings or `npm audit` vulnerabilities.
   - Verify `npm audit` reports 0 vulnerabilities before marking dependency tasks complete.

3. **Privacy & Key Hygiene**:
   - NEVER log secret keys (`nsec`, private key bytes) or unencrypted Wireguard/identity secrets to console or log files.
   - Secrets must remain in `.env` (git-ignored) or passed via typed config interfaces.

4. **TypeScript & Code Style**:
   - Avoid `any`. Define explicit interfaces in `src/types.ts`.
   - Run `npm run lint` and `npm run build` (`tsc`) to verify type correctness.

## Build & Test Reference Commands

```bash
npm test            # Run Vitest test suite
npm run test:watch  # Run Vitest in TDD watch mode
npm run lint        # Check ESLint rules
npm run build       # Compile TypeScript output to dist/
```

## Repository Structure

| Path | Description |
| :--- | :--- |
| `src/types.ts` | Core interfaces (`CommandContext`, `CommandHandler`, `NostrBotConfig`) |
| `src/bot.ts` | Main `NostrCommunityBot` engine class |
| `src/event-utils.ts` | Nostr event helpers & command parser |
| `src/__tests__/` | Vitest TDD test suite |
| `dist/` | Compiled JavaScript & type declaration output (`npm run build`) |
