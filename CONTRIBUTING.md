# Contributing to `nostr-community-bot`

Thank you for considering contributing to `nostr-community-bot`! We welcome contributions from developers across the Nostr and Bitcoin ecosystem.

---

## Code of Conduct

Please maintain a respectful, collaborative, and security-minded environment for all contributors.

---

## How to Contribute

### 1. Report Issues & Feature Requests
- Check existing issues before opening a new one.
- Provide step-by-step reproduction instructions for bugs.

### 2. Submitting Pull Requests (PRs)
1. Fork the repository and create a feature branch (`git checkout -b feature/my-feature`).
2. Follow the **TDD Workflow** described in [DEVELOPING.md](DEVELOPING.md).
3. Ensure all tests pass (`npm test`) and code passes linting (`npm run lint`).
4. Ensure `npm audit` reports **zero vulnerabilities**.
5. Submit your PR against the `main` branch with a descriptive summary.

---

## Coding Guidelines

- Written in TypeScript (ES2022 / NodeNext module target).
- Use strict formatting rules via `npm run format`.
- Include unit tests for all new commands, event parsers, or utility functions.
