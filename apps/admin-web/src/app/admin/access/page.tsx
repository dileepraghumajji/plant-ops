'use client';

/**
 * Access assignment — the key screen (Doc 09 §3.4, Doc 06 §9, Doc 01 §4.5).
 *
 * Everywhere else in the client console defines vocabulary: the org tree is
 * *where*, roles are *what*, users are *who*. Here the three become a sentence,
 * and the sentence is the only thing in the system that grants anything.
 *
 * ## One screen, granting and reviewing
 *
 * Doc 09 §3.4 asks for the assign action and the filterable list together, and
 * they belong together for a reason beyond convenience: the commonest correction
 * after a grant is *another grant at a different node*, and the list is where an
 * operator sees that the first one landed at the wrong place. Splitting them
 * would put the evidence one navigation away from the mistake.
 *
 * ## The pickers are loaded once, and shared
 *
 * The wizard's subject, role and scope pickers and the table's filters offer the
 * same three lists. Fetching them twice would let the two disagree — a role
 * created in another tab appearing in one and not the other — so this page owns
 * the read and hands it down.
 */

import type {
  Paginated,
  RoleBindingDTO,
  RoleDTO,
  ScopeNodeDTO,
  ServiceAccountDTO,
  UserDTO,
} from '@plantops/contracts';
import { PageHeader } from '@plantops/ui';
import { useAsync, useIam } from '@plantops/web-kit';
import { Space } from 'antd';
import { useCallback, useMemo, useState, type ReactElement } from 'react';

import { AssignAccessWizard } from '../../../components/bindings/assign-access-wizard';
import { BindingsTable } from '../../../components/bindings/bindings-table';
import { ScreenFailure } from '../../../components/screen-failure';
import {
  NO_FILTERS,
  subjectOptions,
  toBindingsQuery,
  type BindingFilters,
} from '../../../lib/bindings';
import { CLIENT_PERMISSIONS as P } from '../../../lib/iam-permissions';
import { collectPages } from '../../../lib/paging';
import { usePermission } from '../../../lib/use-permission';

export default function AccessPage(): ReactElement {
  const iam = useIam();
  const canReadServiceAccounts = usePermission(P.SVC_READ);

  const [filters, setFilters] = useState<BindingFilters>(NO_FILTERS);
  const [query, setQuery] = useState({ page: 1, limit: 25 });
  /** Bumped by a grant or an unbind, so the list re-reads. */
  const [version, setVersion] = useState(0);

  const onChanged = useCallback(() => setVersion((n) => n + 1), []);

  const options = useAsync(async () => {
    const [users, roles, scopes, serviceAccounts] = await Promise.all([
      collectPages<UserDTO>((page) => iam.users.list(page)),
      collectPages<RoleDTO>((page) => iam.roles.list(page)),
      iam.scopes.tree(),
      canReadServiceAccounts
        ? collectPages<ServiceAccountDTO>((page) => iam.serviceAccounts.list(page))
        : Promise.resolve<ServiceAccountDTO[]>([]),
    ]);
    return { users, roles, tree: scopes.tree, serviceAccounts };
  }, [iam, canReadServiceAccounts]);

  const bindings = useAsync<Paginated<RoleBindingDTO>>(
    () => iam.roleBindings.list({ ...query, ...toBindingsQuery(filters) }),
    [
      iam,
      query.page,
      query.limit,
      filters.subject,
      filters.roleId,
      filters.scopeNodeId,
      version,
    ],
  );

  const subjects = useMemo(
    () => subjectOptions(options.data?.users ?? [], options.data?.serviceAccounts ?? []),
    [options.data],
  );
  const roles = useMemo<RoleDTO[]>(() => options.data?.roles ?? [], [options.data]);
  const tree = useMemo<ScopeNodeDTO[]>(() => options.data?.tree ?? [], [options.data]);

  // A narrowed list is a different list, and page four of the old one is
  // meaningless in it.
  const changeFilters = useCallback((next: BindingFilters): void => {
    setFilters(next);
    setQuery((current) => ({ ...current, page: 1 }));
  }, []);

  if (options.error !== null) {
    return <ScreenFailure error={options.error} onRetry={options.reload} />;
  }

  return (
    <>
      <PageHeader
        title="Access assignment"
        description="Who × what × where. A grant names a person or machine, a role, and the node of the org tree it applies at — and it reaches that node and everything beneath it."
      />

      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <AssignAccessWizard
          subjects={subjects}
          roles={roles}
          tree={tree}
          loading={options.loading}
          onGranted={onChanged}
        />

        <BindingsTable
          bindings={bindings}
          filters={filters}
          onFiltersChange={changeFilters}
          onQueryChange={setQuery}
          subjects={subjects}
          roles={roles}
          tree={tree}
          onChanged={onChanged}
        />
      </Space>
    </>
  );
}
