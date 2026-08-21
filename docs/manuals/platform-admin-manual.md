# Platform Administrator Manual

**Who this is for:** the person on *your* side of PlantOps — the one who onboards
customers and manages the catalogue of applications. You do not need to be a
developer. You do need to be careful, because a few of these actions affect every
customer at once; those are flagged as they come up.

**Your world in one sentence:** you decide *which applications exist* and *which
customer may use which*. You do not manage a customer's people or their access —
they do that themselves, and the system deliberately keeps you out of it.

If a word here is unfamiliar, the [Founder's Guide glossary](founder-guide.md#12-glossary)
defines it in one line.

---

## 1. Signing in

Go to the console (locally, `http://localhost:4200`) and fill in three fields:

| Field | What to type |
|---|---|
| **Client** | `platform` — this is your own tenant, and it works like any other |
| **Email** | your platform admin address |
| **Password** | your password |

After signing in you see a sidebar with a **Platform** section. If you don't, see
[§8 Troubleshooting](#8-when-something-looks-wrong).

**The menu is not fixed.** It is computed from what you are allowed to do. Two
platform admins with different permissions see different sidebars, and that is
correct rather than a bug.

**Five wrong passwords locks the account**, and it does not unlock itself.
Another admin in the `platform` tenant clears it. Which is why:

> **Rule 1: never have only one platform administrator.** Create a second one on
> day one of every environment.

---

## 2. What you are responsible for

| Screen | You use it to | How often |
|---|---|---|
| **Platform → Applications** | Register a PlantOps application and keep its catalogue of abilities and menus current | Whenever an application ships new features |
| **Platform → Clients** | Create a customer, switch their modules on or off, create their first administrator, suspend them | Whenever you sign or lose a customer |
| **Platform → Service Accounts** | Create machine identities that belong to *your* tenant | Rarely |
| **Platform → Audit** | Look up who did what, across every customer | On demand — incidents, compliance questions, curiosity |

Everything else — plants, roles, users, access — belongs to the customer.

---

## 3. Applications

An **application** is one PlantOps product: Gate Pass, Visitor Management, and so
on. The IAM console itself is registered as one (key `iam`), which is how it gets
its own menu.

Registering an application means telling the system two things:

- its **permissions** — the precise abilities it contains, like
  `gatepass.dc.approve`
- its **navigation** — the menu tree users will see, and which permission each
  menu item requires

### 3.1 The recommended way: upload a manifest

A **manifest** is a single file the development team ships with each application.
It lists all permissions and the whole menu tree. Uploading it is how you both
register a new application and update an existing one — the same file, applied to
development, staging and production, gives an identical catalogue in all three.

**Platform → Applications → Upload manifest**

1. Paste the file, or drag it in.
2. The screen reads the application key from inside the file and tells you
   **which application it is about to change**. Read that line. It is the one
   question a wrong answer to is expensive.
   - If the key matches no application yet, the screen offers to create the row
     first, then continues.
3. You get a **preview** — exactly what would be added, changed or deactivated.
   Nothing has been written yet.
4. Read the preview, then confirm.

The preview is produced by the real endpoint in rehearsal mode, so what you see
is what will happen. If someone else changed the catalogue between your preview
and your confirmation, the screen tells you the two differed rather than letting
the promise quietly become false.

**What a manifest looks like** (the shape, not the content — the development team
gives you the real one):

```json
{
  "key": "gatepass",
  "name": "Gate Pass",
  "permissions": [
    { "key": "gatepass.dc.create",  "name": "Create DC" },
    { "key": "gatepass.dc.approve", "name": "Approve DC" }
  ],
  "nav": [
    { "kind": "module", "key": "gatepass", "label": "Gate Pass", "children": [
      { "kind": "menu", "key": "dc.create", "label": "New DC",
        "route": "/gatepass/new", "requires": ["gatepass.dc.create"] }
    ]}
  ]
}
```

**Re-uploading is safe and normal.** Matching entries are updated rather than
duplicated; new ones are added. Entries that have disappeared from the file are
*deactivated*, not deleted — nobody's history is destroyed by an upload.

### 3.2 The other way: edit in place

Open an application from **Platform → Applications** and you get three tabs. Use
these for a change too small to justify regenerating a file.

| Tab | What it holds | Note |
|---|---|---|
| **Permissions** | Every ability the application defines | Adding one makes it available to customers immediately; nobody holds it until a customer puts it in a role |
| **Navigation** | The module → menu → sub-menu tree, with routes, icons and ordering | This is the menu users will see |
| **Menu permissions** | Which permission unlocks which menu item | The gate between the two tabs above |

**The rule that catches everyone once:** a menu item with **no** permission
mapped to it is **hidden from everybody**. It is not public. If a customer
reports "the menu is missing", the first thing to check is this tab.

(There is an explicit "public" flag for the rare menu that should be visible to
anyone who has the application at all — an app landing page, typically. Use it
sparingly and deliberately.)

### 3.3 Activating and deactivating an application

Deactivating hides an application everywhere, for every customer, while
preserving all the data behind it. **This affects every customer at once** —
treat it as a maintenance action, not a per-customer switch. To turn an
application off for *one* customer, use the toggle on that customer instead
(§4.2).

---

## 4. Clients (your customers)

### 4.1 Creating one

**Platform → Clients → Create client.** Two fields:

- **Name** — how it reads to humans: "Acme Industries"
- **Slug** — the short handle their people type on the login screen: `acme`

Choose the slug carefully; their staff will type it every day. Lowercase, no
spaces.

### 4.2 Enabling applications for them

Open the client → **Applications** tab → tick what they have bought.

This is the commercial switch. A customer can only build roles from applications
you have enabled. Turning one off later hides the application and makes its
permissions inert — **existing configuration is preserved** and comes back
exactly as it was if you re-enable it. This makes it a safe lever for a trial
that lapses or an invoice that is late.

> A customer with no applications enabled has an empty console and cannot do
> anything, including administer themselves. Enable at least the `iam`
> application for every customer — that is what gives their admin the
> Administration menu.

### 4.3 Creating their first administrator

Open the client → **Admins** → create the first admin with an email, a name, and
a password.

One action does four things: creates the person, creates the root of their org
tree, creates their admin role, and grants it to them. From that moment the
customer is self-sufficient and you can step back.

Hand the credentials over through whatever secure channel you use, and tell them
three things:

1. Their **client slug** — they need it at every sign-in.
2. **Change the password immediately.**
3. **Create a second administrator today** — five wrong passwords locks an
   account, and only another admin of *their* company can unlock it. If they lock
   their only admin, the fix has to come from you.

### 4.4 Suspending a client

The client detail screen suspends and reactivates. A suspended client's people
cannot sign in at all. Nothing is deleted; reactivating restores them exactly.

---

## 5. Service accounts

A **service account** is a program that signs in — a customer's ERP pulling
gate-pass data, a nightly job, another PlantOps service. It has a key and a
secret rather than an email and a password.

**Platform → Service Accounts** manages the accounts belonging to your own
`platform` tenant. (Each customer manages their own, in their own console. The
screen looks identical because it is the same screen — which tenant's accounts
you see is decided by who you signed in as, never by the URL.)

Three things to know:

**The secret is shown exactly once**, at creation and after each rotation. It is
stored only as an unreadable fingerprint, so nobody — not you, not a developer,
not the database — can recover it later. Copy it into your secrets manager before
closing the dialog. If it is lost, rotate and re-deploy.

**Rotating** issues a new secret and invalidates the old one. Plan for a moment
of downtime for whatever uses it, or coordinate with whoever runs that
integration.

**Revoking** stops the account from getting new passes immediately. A pass it
already holds keeps working until it expires — at most five minutes. That bound
is deliberate, and is the honest answer to "how fast does revocation take?" in a
security review.

---

## 6. The audit trail

**Platform → Audit** shows every recorded action across every customer, plus the
platform-level actions that belong to no customer.

You can filter by who did it, what they did, what it was done to, which customer,
and a date range. Filters combine, each narrowing further.

Common questions and how to answer them:

| Question | Filter |
|---|---|
| "Who granted Ramesh that access?" | action = `role_binding.created`, then read the entries |
| "Is someone being attacked?" | action = `auth.login.failed`, narrow to the last day |
| "What did we change for Acme last month?" | client = Acme, date range = last month |
| "Who has been reading the audit trail?" | action = `audit.exported` |

**Export** downloads the current filter as a spreadsheet. Two rules:

- If the filter matches more than **10,000** records the export is refused, and
  tells you the count. This is on purpose: a truncated compliance export looks
  identical to a complete one. Narrow the date range and export in parts.
- **The export is itself recorded.** Reading the trail leaves a mark in the
  trail. Say so plainly if a customer asks — it is a feature, and auditors like
  it.

Nothing in this trail can be edited or deleted, by anyone, including you. There
is no such button and no such endpoint, and the database would refuse one.

---

## 7. Setting up a brand-new environment

This is the one part of your job that is not yet fully in the UI. It happens once
per environment (development, staging, production), and a developer usually does
it with you. The full commands are in
[docs/local-testing.md](../local-testing.md) §4; here is what is happening and
why, so you can supervise it.

1. **The database is created and seeded.** This produces exactly one identity: a
   platform *service account* whose secret comes from the environment's bootstrap
   secret. No human can sign in yet — there is nobody to sign in as.
2. **The IAM's own catalogue is registered** (`npm run manifest:apply`).
   Without this the console has no menu at all, because the console renders the
   menu the server computes, and the menu is data like everything else.
3. **A human platform admin is created**, in two steps: create the user in the
   `platform` tenant, then bind them to the "Platform Admin" role. Two steps
   because no endpoint yet creates a human platform admin directly — the
   customer-admin endpoint always grants the *client* admin role. It is a known
   rough edge, and it affects only your own team, once per environment.
4. **A second platform admin is created.** See Rule 1.

After that everything else is done through the screens in this manual.

---

## 8. When something looks wrong

| What you see | What it means | What to do |
|---|---|---|
| **Empty sidebar / "No screens granted"** | Either the IAM's own catalogue was never registered in this environment, or your tenant does not have the `iam` application enabled | Step 2 of §7, then check the client's Applications tab |
| **"This account is locked"** | Five failed sign-ins. It does not lift on its own | Another admin of the same tenant sets the user back to Active |
| **"You do not have access to this"** on a page you reached by link | Correct behaviour — you deep-linked past a menu you cannot see, and the server refused. Hidden menus are a convenience; the server is the enforcement | Nothing. If you *should* have access, you are missing a permission |
| **A customer says a menu is missing** | Most often: no permission is mapped to that menu item (§3.2), or the application is not enabled for them (§4.2), or nobody has granted them a role carrying the permission | Check in that order |
| **An access change hasn't taken effect** | Changes propagate within seconds, with an outer bound of a few minutes | Wait, then re-check. If it persists past a few minutes, escalate — that is a real fault |
| **The whole console is unreachable** | Infrastructure | A developer checks the API's `/health` and `/ready` endpoints; `/ready` names which dependency is down |

---

## 9. Routines worth keeping

**Every time you onboard a customer**

- [ ] Client created, with a slug their people can type
- [ ] Applications enabled, including `iam`
- [ ] First administrator created, credentials delivered securely
- [ ] Told them: change the password, and create a second admin today

**Every time an application ships a release**

- [ ] Manifest received from the development team
- [ ] Preview read before confirming — new, changed *and* deactivated entries
- [ ] Spot-check one new menu item appears for someone who should have it, and
      does not for someone who should not

**Monthly**

- [ ] Skim failed-login entries for anything odd
- [ ] Confirm every tenant, including `platform`, still has at least two
      administrators
- [ ] Confirm no service-account secret is sitting in a chat message or a
      spreadsheet

---

## 10. Things you cannot do (and why that is right)

- **You cannot see inside a customer's roles or grants in the ordinary course of
  work.** Their world is theirs. This is what lets you tell a security team that
  your staff cannot read their access configuration.
- **You cannot edit or delete audit records.** Nobody can.
- **You cannot recover a service-account secret.** Only rotate it.
- **You cannot bypass permissions.** The console calls the same authorized API as
  everyone else; there is no admin back door, deliberately.

---

## 11. When the customer runs it themselves

Everything above assumes the arrangement that exists today: one system, run by
you, with every customer inside it. Two other arrangements are planned, and they
change your job rather than the software. The detail is in [Deployment
Models](../11-deployment-models.md); what matters to you is this.

**A dedicated instance** — a private copy on your infrastructure, for one
customer — changes nothing about your role. You hold the only platform account.
The customer's administrator has their own tier and never sees the Platform
menu, exactly as now.

**An installation on the customer's own servers** is the one that changes things,
and it is worth understanding *why* rather than just what.

On their hardware, the customer holds the database, the master setup secret and
the machine itself. **You cannot technically withhold anything from them**, and a
design that pretended otherwise would give you false confidence. So the approach
is not to lock the Platform console away — it is to make it unnecessary:

- **Applications are registered by the release, not by you.** The catalogue of
  abilities and menus ships inside the installed software and is re-applied on
  every upgrade. Nobody uploads a manifest by hand, and if anyone edits the
  catalogue directly the next upgrade quietly puts it back. This also means the
  system on their site is always the one that was tested.
- **The customer already exists.** There is exactly one, created at installation.
  The system refuses to create a second, because the whole installation is tied
  to that one customer and a second would be unreachable.
- **Their modules come from the licence**, not from a toggle you flip.
- **Their integrations do not need your tier.** An ERP or a gate device
  authenticates through a *client* service account, which their own administrator
  creates on their own screen (§5 covers the equivalent on your side).

What they do get is a **read-only view** — they can see which applications are
installed, which modules are enabled, and their own audit trail — plus one
recovery path. If they lock out their only administrator on a site with no
internet access and cannot reach you, there is a command their IT runs on the
server itself to restore access. It is deliberately a server-side command rather
than a permission sitting in a role, and it records itself in the audit trail
distinctly from ordinary work.

**The practical consequence for you:** for a self-hosted customer you are not the
platform administrator any more — the release is. Your involvement moves from
running screens to shipping versions, and to reading the diagnostic bundle they
send you when something goes wrong, because you can no longer look for yourself.

None of this is built yet (Phase 8 of the roadmap). It is here so that the first
time a customer asks "will we get the Platform console?", the answer is ready and
it is honest.

---

Next: what your customer sees, in the [Client Admin Manual](client-admin-manual.md).
