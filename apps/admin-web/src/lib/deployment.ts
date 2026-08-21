'use client';

/**
 * What kind of deployment this console is talking to (Doc 11 §6.5).
 *
 * One unauthenticated GET, read by the login screen, answered by
 * `GET /iam/deployment`.
 *
 * ## Why it is fetched rather than built in
 *
 * Session 40 made this console origin-agnostic: one build, no hostname, no
 * per-deployment value inlined — which is what lets a single image serve a
 * managed platform and a plant server in the same week. The cost of that is
 * exactly this: anything the console needs to know about *its* deployment has
 * to be asked for at run time, and asked for before anyone has signed in.
 *
 * ## It decides a form field and nothing else
 *
 * A single-tenant deployment refuses a login that names a different
 * organisation, and does so whether or not this fetch ever succeeded. So the
 * failure path here is a form with one more field on it, not a hole in
 * anything: `saas` is the assumption when the answer does not arrive, because
 * asking for a slug the user does not need is a nuisance and *not* asking for
 * one they do need is a login they cannot complete.
 */

import { useEffect, useState } from 'react';

import { IAM_API_URL } from './api-config';

export type DeploymentMode = 'saas' | 'single_tenant';

export interface Deployment {
  mode: DeploymentMode;
  /** The pinned organisation's slug, or `null` on the multi-tenant platform. */
  clientSlug: string | null;
  /** The pinned organisation's display name, or `null`. */
  clientName: string | null;
}

/** The assumption before an answer arrives, and after one fails to. */
const MULTI_TENANT: Deployment = {
  mode: 'saas',
  clientSlug: null,
  clientName: null,
};

interface DeploymentResponse {
  mode: DeploymentMode;
  client_slug: string | null;
  client_name: string | null;
}

/**
 * `{ deployment, loading }`.
 *
 * `loading` matters to the caller: rendering the multi-tenant form for a moment
 * and then swapping the field out from under someone who has started typing is
 * worse than waiting, and the request is one round trip to the origin that just
 * served the page.
 */
export function useDeployment(): { deployment: Deployment; loading: boolean } {
  const [deployment, setDeployment] = useState<Deployment>(MULTI_TENANT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Aborted on unmount so a slow answer cannot set state on a gone component
    // — the login page unmounts the moment a session exists.
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${IAM_API_URL}/iam/deployment`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return;

        const body = (await response.json()) as DeploymentResponse;
        // Guarded rather than trusted: this runs before any session exists, and
        // a proxy misconfiguration that serves the console's own 404 page here
        // would otherwise put `undefined` into the form's tenant field.
        if (body.mode !== 'saas' && body.mode !== 'single_tenant') return;

        setDeployment({
          mode: body.mode,
          clientSlug: body.client_slug ?? null,
          clientName: body.client_name ?? null,
        });
      } catch {
        // Including the abort. Staying on the multi-tenant assumption is the
        // safe direction — see the header.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, []);

  return { deployment, loading };
}
