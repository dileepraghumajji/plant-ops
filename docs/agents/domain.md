# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a **single-context** repo: one glossary at the root, one ADR directory, shared by every app and lib in the Nx workspace.

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-permission-guard-connection-strategy.md
│   └── 0002-scope-node-kind.md
├── apps/
│   ├── admin-web/
│   ├── iam-api/
│   └── iam-api-e2e/
└── libs/
    ├── auth-kit/
    ├── config/
    ├── contracts/
    ├── db/
    ├── iam-client/
    ├── ui/
    └── web-kit/
```

Note that `apps/*` and `libs/*` are Nx projects, not separate bounded contexts. They share one vocabulary. There is no `CONTEXT-MAP.md` and no per-project `CONTEXT.md`; don't go looking for them.

If the domain later splits such that (say) Gatepass and Visitor need glossaries that genuinely disagree with IAM's, that's the signal to convert this repo to multi-context: add a root `CONTEXT-MAP.md` pointing at per-context `CONTEXT.md` files, keep `docs/adr/` for system-wide decisions, and add context-scoped ADR directories alongside each `CONTEXT.md`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0002 (scope node kind), but worth reopening because…_
