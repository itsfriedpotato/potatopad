# Contributing to PotatoPad

Thanks for wanting to build on PotatoPad — an open, direct-to-Uniswap-V3 launchpad. Web3 devs and contributors are welcome. This guide gets you from fork to merged PR.

> PotatoPad is unaudited, demo-grade software. Contributions should keep it honest: no hidden owner powers, no rug vectors, no misleading claims. Read the [README](./README.md) before you start.

## How contributions work

This repo uses a **fork + pull request** flow. Nobody has write access except the maintainer, so every change lands through a reviewed PR:

1. **Fork** this repo to your account.
2. **Branch** off `main`: `git checkout -b fix/short-description`.
3. **Make your change** and keep it focused — one concern per PR.
4. **Run the checks locally** (see below) — a PR that doesn't build or breaks tests won't be merged.
5. **Open a PR** against `itsfriedpotato/potatopad:main` and fill in the PR template.
6. A maintainer (**@itsfriedpotato**) reviews it. Only their approval can merge it — that's enforced by branch protection + `CODEOWNERS`, so review may take a bit. Be patient.

## Running the checks locally

**Contracts** (`contracts/`):

```bash
cd contracts
npm install
npx hardhat compile
npx hardhat test        # all tests must stay green
```

**Frontend** (`web/`):

```bash
cd web
npm install
npx tsc --noEmit        # must type-check clean
npm run build           # must build
```

See the [README](./README.md) for running the full stack locally against a seeded chain.

## What makes a PR easy to accept

- **Focused.** One bug fix or one feature per PR. Big unrelated refactors are hard to review.
- **Tested.** New contract behavior needs Hardhat tests. Security-relevant changes especially.
- **No secrets.** Never commit private keys, RPC URLs with keys, or `.env*` files (they're gitignored — keep it that way).
- **Honest.** No owner backdoors, upgradeable-proxy rug vectors, or hidden fees. The whole point is that the code is what it says it is.
- **Keeps attribution.** Per the [LICENSE](./LICENSE), any user-facing deployment keeps the "Made by proofofpotato.com" footer credit.

## Reporting bugs & ideas

Open a GitHub **Issue**. For a security-sensitive finding, say so in the issue title and keep exploit details minimal until it's triaged.

## Code style

Match the surrounding code — the repo already leans on TypeScript strictness (frontend) and Solidity 0.8.24 conventions (contracts). No new heavy dependencies without a good reason.
