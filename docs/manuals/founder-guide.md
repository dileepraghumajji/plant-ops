# The Founder's Guide to PlantOps IAM

**Who this is for:** you — the person who owns this product. No engineering
background is assumed. Where a technical word is unavoidable it is explained the
first time and repeated in the [glossary](#12-glossary) at the end.

**What you will get out of it:** the ability to explain PlantOps to a customer, a
partner or a new employee; a clear picture of what exists today and what does
not; and a short list of decisions that are yours to make, not your developers'.

---

## 1. What you have actually built

You have built the **security office** that every future PlantOps application
will share.

Think of a factory's physical security office. It issues ID cards, decides which
doors each card opens, keeps a register of who was given what and when, and can
cancel a card in seconds if someone leaves. It does not itself run the canteen or
the loading bay — it just decides who may.

PlantOps IAM is that office, in software. The applications that will sit on top
of it — Gate Pass, Visitor Management, Meeting Rooms, Vehicle Requisition,
Security Patrol — are the canteen and the loading bay. None of them has to invent
its own idea of "users", "roles" or "who may approve this". They ask the security
office.

**IAM** stands for *Identity and Access Management*. Identity = who you are.
Access = what you may do. That is the whole product.

### Why build this first, before any of the actual applications?

Because it is the part every application needs and the part that is expensive to
retrofit. If you build Gate Pass first, it grows its own private notion of users
and permissions. Then Visitor Management grows another one. By the third
application you have three user lists that disagree with each other, a customer
who has to be added three times, and no way to answer "who could approve this?"
after an incident.

Building it first means the fifth application costs a fraction of the first, and
that every application is auditable by construction rather than by promise.

---

## 2. The one idea that shapes everything

Every access decision in the system answers three questions at once:

```
Access  =  WHO  ×  WHAT  ×  WHERE
```

- **WHO** — a person, or a machine (another program calling in).
- **WHAT** — a single, precise ability, like "approve a gate pass".
- **WHERE** — a place in the customer's own structure: a group, a plant, a
  department, a gate.

Most access systems only do WHO × WHAT. They can say "Ramesh is a Supervisor".
They cannot say "Ramesh is a Supervisor **at Plant B only**" without someone
writing custom code for it — and in a business made of physical sites, that
"only" is the whole point.

### Why the WHERE dimension is your moat

Your customers are manufacturers with multiple plants, each with departments and
gates. Their real question is never "who is a supervisor?" It is:

> Who can approve a material gate pass **at the Pune plant's north gate**?

Because WHERE is built into the foundation rather than bolted on, every
application you build on top gets it for free. Gate Pass does not need to think
about plants. It asks the security office "may this person approve at this gate?"
and gets a yes or no.

### The inheritance rule

Places form a tree:

```
Acme Group
├── Pune Plant
│   ├── Stores Department
│   └── North Gate
└── Chennai Plant
    └── Main Gate
```

Access granted at a place **automatically applies to everything beneath it**.
Give the Plant Head their role at "Pune Plant" and they cover Stores, North Gate,
and anything added under Pune later — without anyone updating a list. Give the
guard their role at "North Gate" and it stops there.

This inheritance runs in exactly one direction (downwards, through places) and
**nowhere else**. Being allowed to *approve* a gate pass never implies being
allowed to *create* one. That asymmetry is deliberate: it is what stops
permissions quietly widening over time.

---

## 3. The building blocks, in plain English

Nine words cover the whole system. Every screen your admins will ever see is one
of these.

| Word | Plain English | Real example |
|---|---|---|
| **Application** | One of your products | Gate Pass, Visitor Management |
| **Permission** | One precise ability inside an application | "approve a gate pass" |
| **Client** (or *tenant*) | One customer company | Acme Industries |
| **Scope node** | One place in that customer's structure — the WHERE | "Pune Plant / North Gate" |
| **Role** | A named bundle of permissions, made by the customer | "Gate Supervisor" = 6 permissions |
| **User** | A person who signs in | ramesh@acme.com |
| **Service account** | A *program* that signs in — no human, no password; a key and a secret | Acme's SAP system pulling gate-pass data nightly |
| **Binding** | The actual grant: this person + this role + this place | "Ramesh + Gate Supervisor + Pune Plant" |
| **Audit record** | An unchangeable line in the register saying what happened | "Priya gave Ramesh the Gate Supervisor role at Pune Plant, 14 Aug, 10:42" |

The **binding** is the only thing in the entire system that actually grants
anything. Everything else is vocabulary that makes bindings expressive. When
anyone asks "how do I give someone access?", the answer is always: create a
binding.

---

## 4. How a customer actually gets onboarded

Here is Acme Industries, from signed contract to a guard using their phone at a
gate. This is a real sequence, not an illustration — it maps one-to-one onto
screens that exist today.

**Day 1 — your side (5 minutes).** Your platform administrator creates the client
"Acme Industries", ticks which applications Acme has paid for (say Gate Pass and
Visitor), and creates Acme's first administrator account. That is your entire
involvement. No code is written, nothing is deployed, no engineer is called.

**Day 2 — Acme's side, unaided.** Acme's admin signs in and:

1. Draws their **org structure** — Acme Group → Pune Plant → Stores, North Gate →
   Chennai Plant → Main Gate. This is the WHERE, and they build it themselves,
   because only they know their plants.
2. Creates **roles** that match how they actually work: "Gate Supervisor",
   "Store Keeper", "Security Guard". For each one they tick the abilities it
   should carry, drawn from the applications you enabled for them.
3. Adds their **people** — one at a time, or by uploading a spreadsheet of up to
   500 rows.
4. **Assigns access**: Ramesh + Gate Supervisor + Pune Plant. Gita + Security
   Guard + North Gate. This is the one screen that matters, and it reads like a
   sentence.

**Day 3 — it just works.** Gita signs in to the Gate Pass app on her phone. She
sees only the menus her permissions justify, and only data from North Gate. She
was never configured inside Gate Pass — Gate Pass asked the security office.

**Later — someone leaves.** Acme's admin disables the account. Every session
everywhere is killed within seconds, on every device and in every application.
The register records who did it and when.

### The commercial consequence

Onboarding a customer costs you **five minutes of admin time and zero engineering
time**. Adding a new application to the catalogue is an upload, not a release.
That is the difference between a business that scales with headcount and one that
does not.

---

## 5. What makes this different from "just adding a login screen"

Five properties are built in. Each is the sort of thing that is nearly impossible
to add later, which is why they are here now.

**1. Everything is data, not code.** Applications, menus, permissions, customers
— all created by filling in a form or uploading a file. A new customer, a new
menu item, a new permission: none of them requires a developer, a release, or
downtime. Test the claim by asking "what would it take to add a new menu to Gate
Pass?" The answer is: an admin edits it, and it appears for exactly the people
whose permissions justify it, immediately.

**2. Menus are computed, not configured.** Nobody maintains a list of "what the
Supervisor sees". The system works it out from what the person may actually do.
An empty menu means missing permissions, never a missing menu file — and a menu
that nobody mapped a permission to is hidden by default rather than shown to
everyone. That default is the safe direction, deliberately.

**3. Customers cannot see each other, enforced by the database itself.** Every
customer's data is fenced off at the deepest layer — not by careful programming
in every query, but by a rule the database enforces underneath all of them. Even
if a developer wrote a buggy query tomorrow, the database returns nothing from
another customer. This is the single most valuable property you have when a large
manufacturer's security team audits you.

**4. Everything is written down, permanently.** Every grant, every login, every
failed login, every lock, every change goes into a register that cannot be edited
or deleted — not by an admin, not by you, not by a developer. After an incident
("who could have approved that gate pass on the 3rd?"), the answer is a query,
not an investigation.

**5. Access can be cut instantly.** Sessions can be killed individually or all at
once. This matters most for the shared tablet at a gate that six guards use
across three shifts.

---

## 6. The two kinds of administrator

There are exactly two administrative worlds, and the boundary between them is
enforced by the same permission system as everything else — there is no secret
back door, not even for you.

| | **Platform admin** (you and your team) | **Client admin** (each customer's own admin) |
|---|---|---|
| Manages | The catalogue of applications; the list of customers; which customer may use which application | Their own plants, roles, people and access grants |
| Cannot | Reach inside a customer's roles or grants in the normal course of work | See any other customer at all, or change the catalogue |
| Sees in the register | Everything, across all customers | Only their own company's entries |
| Typical week | Onboard a customer; upload a new version of an application's catalogue | Add joiners, remove leavers, adjust access |

Both use the **same** web console; it simply shows a different menu depending on
who signed in. That is the menu system dogfooding itself — the strongest evidence
that it works.

---

## 7. What exists today, honestly

The system was built in 39 planned sessions. **Sessions 1–37 are complete and
merged**: the entire back end, and every screen in both consoles.

**Working today:**

- Sign-in, sign-out, sessions, forced logout, account lock/unlock/disable
- Machine identities (service accounts) with keys, secret rotation and revocation
- The full application catalogue, including upload-a-file registration with a
  preview of exactly what will change before you commit
- Customer creation, module enablement, first-administrator creation
- Org structure, roles and permission picking, users, spreadsheet upload,
  access assignment
- The register (audit trail), searchable and exportable to a spreadsheet
- The permission engine, with caching, so answering "may they?" stays fast at
  scale
- The web console for both administrator tiers

**Not yet done — worth knowing before a customer sees it:**

| Gap | What it means in practice | Whose call |
|---|---|---|
| **Session 38 — hardening & security test battery** | The security properties are implemented and unit-tested, but the deliberate end-to-end attack battery has not been run | Engineering; do this before the first paying customer |
| **Session 39 — deployment, CI, environments** | It runs on a developer's machine. There is no production deployment, no automated build pipeline, no staging environment | Engineering; this is the gap between "built" and "live" |
| **Password-reset emails** | The reset flow works, but nothing sends the email — no mail provider is connected. Outside production the code writes the reset link to the log so developers can test it; in production it refuses and logs an error rather than failing silently | **Yours** — pick a mail provider (SMTP, Amazon SES, or the WhatsApp route the design already reserves) |
| **Single sign-on, Microsoft/Google login, two-factor** | Deliberately out of v1. The data model already has room for them, so they are additions rather than rewrites | Yours — most likely the first thing a large manufacturer asks for |
| **Creating a human platform admin** | Still a two-step process through the API rather than one button. It affects only your own team, once per environment | Engineering; small |

Nothing on that list is a design flaw. The first two are the planned last two
steps; the rest are choices that were consciously deferred.

---

## 8. The decisions that are yours, not your developers'

1. **A mail provider**, so password resets reach people. Nothing else blocks a
   customer trial.
2. **How long the register is kept.** The default is forever, which is the safe
   answer for access-control events and the one a manufacturer's compliance team
   will want to hear. If a customer demands something shorter, that becomes a
   contractual term.
3. **Whether tamper-evidence is needed.** The register cannot be edited today. A
   stronger version exists in the design — each entry sealed against the previous
   one, so any interference is detectable — and is worth switching on if you sell
   into a regulated customer. Ask for it by name: *audit hash chain*.
4. **Single sign-on**, and when. Large manufacturers will ask. It is a feature,
   not a fix, and it is cheaper to quote once you know whether they use Microsoft
   Entra or Google Workspace.
5. **How many platform administrators your team has.** Answer: more than one, in
   every environment — see the risk below.

---

## 9. Risks worth having on your radar

**Locking yourself out.** Five wrong passwords locks an account, and only
*another administrator in the same company* can unlock it. If a customer has
exactly one admin and locks it, they need you; if your platform tenant has
exactly one admin and locks it, you need a developer with database access.
**Always create two administrators.** A one-line policy that prevents a support
incident.

**Signing keys.** The system signs the digital passes it issues with a private
key. There is a documented rotation procedure that never interrupts anyone
mid-session, and tooling to run it. Someone should own doing it on a schedule.

**The bootstrap secret.** One master secret in configuration creates the very
first identity in an environment. It is the crown jewel of a fresh install and
belongs in a password manager or a secrets vault, never in a chat message.

**Speed of revocation, precisely.** When you take someone's access away the
change is immediate for humans in almost every case; the outer bound on stale
access is a few minutes, by design (the trade that keeps the system fast at
scale). For machine identities the bound is five minutes. Worth being able to say
accurately in a security review.

---

## 10. Does it scale, and what does it cost to run?

The moving parts are a standard PostgreSQL database and a Redis cache — both
boring, both cheap, both available as managed services for tens of dollars a
month at your stage. The database is hosted on Supabase, used purely as managed
PostgreSQL (not its login system — you issue your own passes, which is what makes
the WHERE dimension possible).

The expensive question in a system like this is "may they?", asked on every
request of every application. It is answered from cache, and the cached answer is
deliberately kept small — a person with access at "Pune Plant" stores one entry,
not one per gate beneath it. Redis is optional in development (the system falls
back to the database and simply runs slower), which also means a cache outage
degrades performance rather than causing an outage.

---

## 11. Questions to ask your developers

Use these to check the system is still what this guide describes. Each has a
short right answer.

| Ask | You should hear |
|---|---|
| "Can we onboard a customer without a deploy?" | Yes — it is data, not code |
| "If a query has a bug, can it leak another customer's data?" | No — the database refuses, independently of the code |
| "Can an administrator delete an audit entry?" | No — no update or delete path exists, by database permission |
| "How fast is access actually revoked?" | Seconds for people; a few minutes in the worst case; five minutes for machine identities |
| "What happens if Redis goes down?" | Slower, not broken |
| "Can Gate Pass read the IAM database directly?" | No — the build fails if anyone tries; it must call the API |
| "How much authorization code will Gate Pass have to write?" | None — it uses the shared guard |

---

## 12. Glossary

**Access token** — the short-lived digital pass (15 minutes) a signed-in person
carries with every request. Short-lived on purpose: a stolen one expires fast.

**Audit trail** — the permanent register of everything security-relevant.

**Binding** — the grant itself: person + role + place. The only thing that gives
anyone anything.

**Client / tenant** — one customer company inside your system.

**JWT** — the technical name for the access token; a small signed document
proving who the bearer is. It deliberately contains identity only, never the
permission list, so removing someone's access takes effect immediately rather
than when their pass expires.

**Manifest** — a single file describing everything an application can do (its
permissions and its menus). Registering an application means uploading its
manifest; upgrading it means uploading a newer one, after previewing the change.

**Multi-tenant** — one running system serving many customer companies, each
sealed off from the others.

**Permission** — one precise ability, e.g. `gatepass.dc.approve`.

**RLS (Row-Level Security)** — the database's own fence between customers. The
reason a coding mistake cannot leak data across customers.

**Role** — a named bundle of permissions, defined by each customer for themselves.

**Scope node** — one place in a customer's structure: group, plant, department or
gate. The WHERE.

**Service account** — a machine identity: another program that signs in with a
key and secret instead of a person with a password.

**Session** — one sign-in on one device. Individually killable.

---

## Where to go next

- To do the work yourself on your side: [Platform Admin Manual](platform-admin-manual.md)
- To see what a customer experiences: [Client Admin Manual](client-admin-manual.md)
- To follow a technical conversation with your team: [Developer Manual](developer-manual.md), sections 1–3
