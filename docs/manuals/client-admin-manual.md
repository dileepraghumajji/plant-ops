# Client Administrator Manual

**Who this is for:** the person at your company who decides who may do what in
the PlantOps applications — usually an IT administrator, an HR or admin manager,
or a plant security head. No technical background needed.

**What you control:** your company's structure, your roles, your people, and
their access. Nobody outside your company can see or change any of it.

---

## 1. The idea, in one minute

Giving someone access is always the same sentence:

> **This person** gets **this role** at **this place**.

- **Person** — someone who signs in. (Or a *program*, if one of your systems
  connects to PlantOps. Same sentence.)
- **Role** — a bundle of abilities you define: "Gate Supervisor", "Store Keeper".
- **Place** — somewhere in your company's structure: the whole group, one plant,
  one department, one gate.

That last word is what makes this different from most systems. Ramesh is not
simply "a supervisor". He is a supervisor **at the Pune plant** — and the system
knows the difference.

**Places pass access downwards.** Grant a role at "Pune Plant" and it
automatically covers every department and gate under Pune, including ones you add
next year. Grant it at "North Gate" and it stops there. You never have to list
places one by one.

**Nothing else is inherited.** Someone allowed to *approve* a gate pass is not
automatically allowed to *create* one. If you want both, put both in the role.

---

## 2. Signing in

| Field | What to type |
|---|---|
| **Client** | your company's short handle, given to you when your account was created (e.g. `acme`) |
| **Email** | your work email |
| **Password** | your password |

**Five wrong passwords locks the account.** It does not unlock itself — another
administrator at your company has to clear it.

> **Do this today: create a second administrator.** If you are the only one and
> you get locked out, nobody at your company can fix it; you have to go back to
> your PlantOps supplier. Two minutes now, saved hours later.

**Your menu is not everyone's menu.** The system shows each person only the
screens their access justifies. A colleague seeing fewer items than you is
working correctly.

---

## 3. Your first hour — set-up in the right order

Do these four in order. Each one uses the one before it.

```
1. Org Structure ──► 2. Roles ──► 3. Users ──► 4. Access Assignment
   (the places)       (the jobs)    (the people)   (the grants)
```

---

## 4. Step 1 — Org Structure (the places)

**Administration → Org Structure**

Draw your company the way it actually is. Four levels are available:

| Level | Use it for |
|---|---|
| **Group** | The company or a business group — usually the single top item |
| **Plant** | A factory or site |
| **Department** | Stores, Production, Security, Maintenance… |
| **Gate** | A physical gate or entry point |

Example:

```
Acme Group
├── Pune Plant
│   ├── Stores
│   ├── Production
│   └── North Gate
└── Chennai Plant
    ├── Stores
    └── Main Gate
```

**How detailed should this be?** As detailed as the *smallest area you will ever
want to restrict someone to*. If a guard will ever be limited to one gate, that
gate must exist here. If you never distinguish departments, do not create them.
You can add more later at any time.

**Renaming** is safe — access follows the item, not the name.

**Moving** an item takes its children with it, and everyone's access adjusts
automatically. Do it deliberately: someone who had access at a plant will now
cover wherever you moved it to.

**Deleting** is refused while anyone still has access there. That is on purpose —
the message tells you so, and you remove the grants first (Step 4). It stops
access from silently disappearing.

---

## 5. Step 2 — Roles (the jobs)

**Administration → Roles**

A role is a named bundle of abilities. Create one per *job*, not per person.

**Creating a role**

1. **Create role**, give it a name people will recognise — "Gate Supervisor",
   not "Role 3".
2. Tick the abilities it should carry. They are grouped by application, and you
   only see applications your company has been given. Search works if the list is
   long.
3. Save.

**Good practice**

- Fewer roles, better named. Ten clear roles beat forty near-duplicates.
- Give a role the abilities the *job* needs, not the abilities the *most senior
  person doing it* needs. The place dimension handles seniority — the same "Gate
  Supervisor" role, granted at a plant instead of a gate, is the senior version.
- Editing a role changes access for **everyone** who holds it, everywhere. Check
  who that is first (Step 6, "Users by Role") before removing an ability.

**Deleting** a role warns you about who is affected. Read the warning.

---

## 6. Step 3 — Users (the people)

**Administration → Users → All Users**

**Adding one person:** email, full name, phone (optional), and an initial status.
The email is how they sign in, together with your company handle.

**Adding many people at once:** **Administration → Users → Bulk Upload**

- Upload a spreadsheet (CSV) or a JSON file — up to **500 people at a time**.
- The columns are `email`, `full_name`, `phone`, `status`. Only the first two are
  required. Column *names* matter; column *order* does not; capitalisation and
  stray spaces are forgiven. A template is downloadable on the screen.
- You get a **line-by-line report**:

  | Result | Meaning |
  |---|---|
  | **created** | Added. Definitely saved |
  | **skipped** | This person already exists — nothing was changed |
  | **errored** | The line could not be read, with the reason (e.g. "not a valid email") |

- **Good lines are saved even when others fail.** You do not have to fix the file
  and start again.
- **Re-uploading the same file is safe and expected.** Add three new joiners to
  last month's roster and upload it again: the three are created, the rest come
  back as *skipped*. "397 skipped" is a success message, not an error.

### Account states

| State | Can they sign in? | Use it when |
|---|---|---|
| **Active** | Yes | Normal |
| **Locked** | No | They failed five sign-ins, or you locked them temporarily. Cleared by **Unlock** |
| **Disabled** | No | They left the company. Their sessions everywhere are ended immediately |

Filter the user list by state; the **Locked** filter is your "who is stuck"
screen. Someone who has forgotten their password and locked themselves out is
fixed by **Unlock**.

Opening a person shows their profile and, importantly, **every access they hold**
— which roles, at which places. This is the screen to open before answering "why
can she do that?"

**Users by Role** (**Administration → Users → Users by Role**) answers the
question from the other end: pick a role, see everyone who holds it and where.
Grants that have passed their expiry date are listed and clearly marked rather
than hidden, so a lapsed grant is visible instead of mysterious.

---

## 7. Step 4 — Access Assignment (the grants)

**Administration → Access Assignment**

This is the screen that actually gives people access. Everything before it was
vocabulary.

**To grant access**

1. **Assign access**.
2. Pick the **person** (or a machine identity, if you have any).
3. Pick the **role**.
4. Pick the **place** — from your org tree, so you can see exactly what you are
   covering.
5. Optionally set an **expiry date**. Use it for contractors, auditors, visiting
   engineers and temporary cover. Expired access stops working on its own, which
   is far safer than a reminder in your calendar.
6. Confirm.

The same screen lists existing grants, filterable by person, role or place. That
pairing is deliberate: the most common correction after a grant is *another grant
at the wrong place*, and the list is where you spot it.

**To take access away:** find the grant in the list and remove it. The person
keeps the account, and loses that access.

**A person can hold several grants** — "Store Keeper at Pune Stores" and "Gate
Supervisor at North Gate" at once. Their access is the sum.

**Changes take effect within seconds.** Occasionally a little longer, up to a few
minutes at the outside. If someone still sees the old menu, ask them to reload
before you assume something is broken.

### Worked examples

| Situation | Person | Role | Place | Expiry |
|---|---|---|---|---|
| Guard on the north gate | Gita | Security Guard | Pune Plant / North Gate | — |
| Supervisor covering all Pune gates | Ramesh | Gate Supervisor | Pune Plant | — |
| Group-wide safety auditor | Priya | Auditor | Acme Group | — |
| Contractor for a shutdown | Vikram | Store Keeper | Pune Plant / Stores | 30 Sep |
| Someone covering another plant for a month | Ramesh | Gate Supervisor | Chennai Plant | 31 Oct |

Note the last one: a second grant, not an edit to the first. That is the normal
way to give temporary extra reach, and it disappears by itself.

---

## 8. Machine identities (service accounts)

**Administration → Service Accounts**

If one of your own systems needs to talk to PlantOps — an ERP pulling gate-pass
data, a dashboard, a nightly job — it gets a **service account**: a key and a
secret instead of an email and a password. Your IT team or your supplier will
tell you when one is needed.

Three things to know:

- **The secret is shown once**, at creation. Copy it into your password manager
  immediately; it cannot be retrieved afterwards, only replaced.
- **Rotating** issues a new secret and stops the old one working — coordinate
  with whoever runs that integration, or it stops at that moment.
- **Revoking** shuts it down. Anything it is doing right now stops within about
  five minutes.

Service accounts get access exactly like people do: give them a role at a place,
on the Access Assignment screen. Give them the narrowest place that works.

---

## 9. The audit trail

**Administration → Audit**

Every meaningful action at your company is recorded permanently: sign-ins,
failed sign-ins, access granted and removed, roles changed, accounts locked,
people added. Nobody can edit or delete an entry — not you, not your supplier.

Filter by who, what, when. Typical uses:

| You want to know | Filter on |
|---|---|
| Who gave this person access, and when | the access-granted action |
| Whether someone is trying to break in | failed sign-ins, last 24 hours |
| What changed last week | a date range |
| Why an account is locked | the lock action, then the person |

**Export** downloads the filtered list as a spreadsheet, for an auditor or your
own records. If your filter matches more than 10,000 entries it is refused with
the count — narrow the dates and export in parts. (A half-finished export that
looks complete is worse than no export.) Note that **exports are themselves
recorded**.

---

## 10. When something looks wrong

| What you see | What is happening | Fix |
|---|---|---|
| "This account is locked" | Five failed sign-ins | Another admin unlocks it: Users → find them → **Unlock** |
| A colleague cannot see a screen | They have no role granting it, or their grant is at a place that does not cover them, or it expired | Open their profile — every grant they hold is listed there |
| Someone sees no menu at all | They have no access at all yet | Assign access (§7) |
| "You do not have access to this" | You followed a link past a screen you cannot use. The system refused, correctly | Nothing to fix, unless you *should* have that access |
| A place cannot be deleted | Someone still has access there | Remove those grants first; the list is on the Access Assignment screen |
| A change did not take effect | It propagates within seconds, occasionally a few minutes | Reload. If it persists, contact your supplier |
| A bulk upload says "397 skipped" | Those people already existed | Nothing. That is the normal result of re-uploading a roster |
| Nobody can sign in at all | Either your company has been suspended, or the service is down | Contact your PlantOps supplier |

---

## 11. Habits worth keeping

**When someone joins**

- [ ] Create the person (or include them in the next roster upload)
- [ ] Assign access: role + place — the *narrowest* place that lets them do the job
- [ ] Set an expiry if they are temporary

**When someone leaves — same day**

- [ ] Set them to **Disabled** (this ends every session everywhere immediately)
- [ ] Remove their grants if you keep the account for records

**When someone changes job**

- [ ] Remove the grants for the old job — do not just add the new ones
- [ ] Add the new grants

**Every quarter**

- [ ] Walk through Users by Role for each role and confirm each person still
      needs it
- [ ] Check the Locked filter for accounts that were never cleared
- [ ] Confirm you still have at least two administrators

**Two rules that prevent most problems**

1. **Grant at the smallest place that works.** It is easy to widen later, painful
   to discover it was too wide all along.
2. **Use expiry dates for anything temporary.** Access that ends by itself is
   access you never have to remember to remove.
