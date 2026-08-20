# PlantOps Manuals

Four manuals, one system. Each is written for a different person, and each is
complete on its own — you should never have to read another one to finish a task
in yours.

| If you are… | Read | You will be able to |
|---|---|---|
| **The founder / owner** — you want to understand what you have, in plain English | [Founder's Guide](founder-guide.md) | Explain the product to a customer, an investor or a new hire; know what is built, what is not, and what to ask your developers |
| **A platform administrator** — you run PlantOps and onboard customers | [Platform Admin Manual](platform-admin-manual.md) | Register applications, onboard a new customer, enable modules, create their first administrator, read the global audit trail |
| **A client administrator** — you are a customer's IT/admin person at a plant | [Client Admin Manual](client-admin-manual.md) | Build your org structure, create roles, add users, give people access to exactly the right places, and prove later who granted what |
| **A developer** — you maintain the IAM or build a module on top of it | [Developer Manual](developer-manual.md) | Run the stack locally, understand the architecture, extend it safely, and plug a new application into it without writing authorization code |

## The 30-second version

PlantOps IAM is the **security office** for a family of factory applications
(gate passes, visitors, meeting rooms, vehicles, patrols). It answers one
question, over and over, for every screen and every button in every one of those
applications:

> **Is this person allowed to do this particular thing, at this particular place?**

Three words matter — **WHO**, **WHAT** and **WHERE** — and the "WHERE" is the
part most systems get wrong. A security guard does not simply have "patrol
permission". They have permission to run a patrol round **at Gate 3 of Plant B**,
and nowhere else.

Everything else in these manuals is detail hanging off that one sentence.

## Handing these to a customer

[`html/`](html/) holds the same four manuals as standalone web pages — one file
each, no server, nothing to install. Open `html/index.html` in a browser, or
attach the folder to the onboarding email; the **Client Administrator Manual** is
the one a new organization's admin needs. Every page prints cleanly (or saves as
a PDF) from the Print button.

Regenerate them after editing any manual:

```sh
npm run manuals:html
```

The generator is [tools/build-manuals.mjs](../../tools/build-manuals.mjs) — no
dependencies, no build step.

## Related documents

These manuals are the *how-to*. The specification suite in [`docs/`](../) is the
*why* and the *contract* — [00](../00-system-overview.md) through
[12](../12-consuming-the-iam.md), plus [local-testing.md](../local-testing.md) for
running everything on a developer machine. Where a manual and the spec disagree,
the spec is right and the manual needs fixing.

Two of those documents postdate the four manuals and cover ground none of them
did: [11 — Deployment Models](../11-deployment-models.md) (how the product is
delivered — hosted by us, a dedicated instance, or installed on a customer's own
servers) and [12 — Consuming the IAM](../12-consuming-the-iam.md) (using it from
a product built outside this repository). The Founder's Guide and the Developer
Manual carry the plain-English summary of each; the specs carry the detail.

Decisions with their reasoning live in [`docs/adr/`](../adr/) — including the two
that are still open and deliberately so.
