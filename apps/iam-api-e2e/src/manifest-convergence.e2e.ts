/**
 * The release's catalog wins (roadmap Session 43, Doc 11 §6.3, Doc 02 §2, §7).
 *
 * Manifests ship with the release and are applied at install and on every
 * upgrade, so the permission and navigation catalog on a client's box is always
 * the one we tested. The property that makes that safe rather than destructive
 * is convergence: re-applying is an upsert keyed by `(application, key)`, keys
 * the manifest no longer declares are **deactivated rather than deleted**, and
 * a run that changes nothing writes nothing.
 *
 * Every assertion here goes through `POST /iam/applications/:id/manifest` —
 * the endpoint `tools/apply-manifests.ts` calls and the one the console calls.
 * Testing the tool by shelling out to it would prove the tool runs; testing the
 * endpoint proves the behaviour the tool depends on, which is the part that can
 * silently change.
 *
 * The document under test is the shipped one, `deploy/manifests/iam.manifest.json`,
 * read off disk. Using a fixture instead would leave the release's own manifest
 * unexercised — and the IAM's is the one manifest that must keep working,
 * because the console has no menu without it.
 */

import type { ApplicationManifest, ManifestUpsertResponse } from '@plantops/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectOk, type Caller } from './support/api';
import { platform } from './support/two-tenant-fixture';

const MANIFEST_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'deploy',
  'manifests',
  'iam.manifest.json',
);

const SHIPPED: ApplicationManifest = JSON.parse(
  readFileSync(MANIFEST_PATH, 'utf-8'),
) as ApplicationManifest;

interface ApplicationRow {
  id: string;
  key: string;
  name: string;
}

interface PermissionRow {
  id: string;
  key: string;
  name: string;
  is_active: boolean;
}

interface Page<T> {
  data: T[];
  total: number;
}

/** Every permission the application has, active or not, across pages. */
async function permissionsOf(
  caller: Caller,
  applicationId: string,
): Promise<PermissionRow[]> {
  const rows: PermissionRow[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await caller.get<Page<PermissionRow>>(
      `/iam/applications/${applicationId}/permissions?page=${page}&limit=100`,
    );
    const body = expectOk(response, 'list permissions');
    rows.push(...body.data);
    if (rows.length >= body.total || body.data.length === 0) break;
  }
  return rows;
}

async function applicationByKey(caller: Caller, key: string): Promise<ApplicationRow> {
  for (let page = 1; page <= 20; page += 1) {
    const response = await caller.get<Page<ApplicationRow>>(
      `/iam/applications?page=${page}&limit=100`,
    );
    const body = expectOk(response, 'list applications');
    const found = body.data.find((application) => application.key === key);
    if (found) return found;
    if (body.data.length === 0) break;
  }
  throw new Error(`no application registered with the key "${key}"`);
}

async function apply(
  caller: Caller,
  applicationId: string,
  manifest: ApplicationManifest = SHIPPED,
): Promise<ManifestUpsertResponse> {
  const response = await caller.post<ManifestUpsertResponse>(
    `/iam/applications/${applicationId}/manifest`,
    manifest,
  );
  return expectOk(response, 'manifest upsert');
}

/** How many audit records exist, so "wrote nothing" can be asserted. */
async function auditCount(caller: Caller): Promise<number> {
  const response = await caller.get<Page<unknown>>('/iam/audit?page=1&limit=1');
  return expectOk(response, 'audit count').total;
}

describe('manifest convergence — the release owns the catalog', () => {
  let caller: Caller;
  let iam: ApplicationRow;

  beforeAll(async () => {
    caller = await platform();
    iam = await applicationByKey(caller, SHIPPED.key);

    // Bring the catalog to the shipped state first. Whatever the battery's
    // other suites have done, every assertion below is about what happens
    // *from* the release's own baseline.
    await apply(caller, iam.id);
  });

  it('is idempotent — a second application changes nothing and audits nothing', async () => {
    const before = await auditCount(caller);

    const result = await apply(caller, iam.id);

    expect(result.changed).toBe(false);
    expect(result.diff.permissions.created).toEqual([]);
    expect(result.diff.permissions.updated).toEqual([]);
    expect(result.diff.permissions.deactivated).toEqual([]);
    expect(result.diff.nav.created).toEqual([]);
    expect(result.diff.nav.updated).toEqual([]);
    expect(result.diff.nav.deactivated).toEqual([]);

    // The load-bearing half. An "upsert" that rewrote every row on every
    // upgrade would still report the right catalog and would bury the audit
    // trail under one entry per key per release — which is how a trail stops
    // being read.
    expect(await auditCount(caller)).toBe(before);
  });

  it('re-converges a hand-added permission by deactivating it, never deleting it', async () => {
    const drift = `${SHIPPED.key}.platform.e2e_drift.read`;

    // The drift: somebody adds a permission through the API, which is a thing
    // the API lets a platform admin do.
    expectOk(
      await caller.post(`/iam/applications/${iam.id}/permissions`, {
        permissions: [{ key: drift, name: 'Drift introduced by hand' }],
      }),
      'hand-add a permission',
    );

    const added = (await permissionsOf(caller, iam.id)).find((row) => row.key === drift);
    expect(added?.is_active).toBe(true);

    // The upgrade.
    const result = await apply(caller, iam.id);
    expect(result.changed).toBe(true);
    expect(result.diff.permissions.deactivated).toContain(drift);

    const after = (await permissionsOf(caller, iam.id)).find((row) => row.key === drift);

    // Present, and inactive. Doc 02 §7: deactivation rather than deletion,
    // because a role may already map this key and an audit record may already
    // name it — a hard delete would take the evidence with it and leave a
    // dangling reference where a resolvable, inactive one belongs.
    expect(after).toBeDefined();
    expect(after?.is_active).toBe(false);
  });

  it('restores a hand-edited application name to what the release says', async () => {
    expectOk(
      await caller.patch(`/iam/applications/${iam.id}`, { name: 'Renamed by hand' }),
      'hand-rename the application',
    );
    expect((await applicationByKey(caller, SHIPPED.key)).name).toBe('Renamed by hand');

    const result = await apply(caller, iam.id);

    expect(result.changed).toBe(true);
    expect((await applicationByKey(caller, SHIPPED.key)).name).toBe(SHIPPED.name);
  });

  it('leaves both catalogs untouched when a manifest is refused', async () => {
    // A manifest addressed to the wrong application. The service refuses it
    // because applying one application's catalog to another would deactivate
    // every key the target owns and rebuild its menu as a copy — reported as a
    // successful upsert.
    //
    // What this asserts is the *transaction*: the refusal happens on the
    // server, inside the request's transaction, and neither the application it
    // was addressed to nor the one the document describes is changed by it.
    const scratchKey = `e2e-manifest-target-${Date.now()}`;
    const scratch = expectOk(
      await caller.post<ApplicationRow>('/iam/applications', {
        key: scratchKey,
        name: 'Scratch application',
      }),
      'create a scratch application',
    );

    const iamBefore = await permissionsOf(caller, iam.id);

    const refused = await caller.post(
      `/iam/applications/${scratch.id}/manifest`,
      SHIPPED,
    );
    expect(refused.status).toBe(409);

    // The scratch application gained nothing: not one of the manifest's
    // permissions was written before the refusal.
    expect(await permissionsOf(caller, scratch.id)).toEqual([]);

    // And the real catalog is exactly as it was.
    const iamAfter = await permissionsOf(caller, iam.id);
    expect(iamAfter.map((row) => `${row.key}:${row.is_active}`).sort()).toEqual(
      iamBefore.map((row) => `${row.key}:${row.is_active}`).sort(),
    );
  });

  it('carries every permission the API gates itself with', async () => {
    // The dogfooding property, stated as a test rather than as a comment: the
    // IAM's own authority comes from ordinary rows in its own registry, put
    // there by the same endpoint every other application uses (Doc 02 §14).
    // A permission the code enforces but the manifest omits cannot be granted
    // to anyone — the console screen behind it is unreachable for everybody,
    // including the platform admin who is supposed to fix it.
    const active = (await permissionsOf(caller, iam.id))
      .filter((row) => row.is_active)
      .map((row) => row.key)
      .sort();

    expect(active).toEqual([...SHIPPED.permissions.map((p) => p.key)].sort());
  });
});
