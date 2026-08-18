'use client';

/**
 * Lock, unlock, disable, reactivate — and the password reset (Doc 09 §3.3,
 * Doc 03 §7–8, Doc 06 §8).
 *
 * Every one of these does more than change a field, which is why each is a
 * confirmed decision with its own words (`lib/users.ts` holds them, so the list
 * and the profile say the same thing). Disabling in particular revokes every
 * session the person holds and empties their grants — they are signed out
 * wherever they are signed in — and an administrator who thought they were
 * "pausing" someone deserves to be told that before it happens rather than
 * after.
 *
 * ## The reset is the tokenized flow, not a password field
 *
 * `POST /auth/password/reset-request` sends a single-use, time-boxed token and
 * answers `202` **whatever the address was** (Doc 03 §7): the endpoint refuses
 * to reveal whether an account exists, which is the right behaviour on a public
 * route and slightly awkward here, where the administrator is looking at the
 * account. So the confirmation says what was sent rather than what was found —
 * claiming delivery this screen cannot observe would be the one dishonest
 * sentence on it.
 *
 * The tenant slug comes from the signed-in administrator's own session, because
 * the request needs one and RLS guarantees the two are the same tenant: a user
 * this screen can read is a user of the caller's client.
 */

import type { UserDetailDTO } from '@plantops/contracts';
import { useAuth, useIam, useNotices } from '@plantops/web-kit';
import { Button, Space, Tooltip } from 'antd';
import { useCallback, useState, type ReactElement } from 'react';

import { CLIENT_PERMISSIONS as P } from '../../lib/iam-permissions';
import { statusActions, type StatusAction } from '../../lib/users';
import { usePermission } from '../../lib/use-permission';

export interface StatusActionsProps {
  user: UserDetailDTO;
  /** Re-reads the profile after a transition. */
  onChanged: () => void;
}

export function StatusActions({ user, onChanged }: StatusActionsProps): ReactElement {
  const iam = useIam();
  const auth = useAuth();
  const notices = useNotices();
  const canUpdate = usePermission(P.USER_UPDATE);

  const [busy, setBusy] = useState<string | null>(null);

  const apply = useCallback(
    async (action: StatusAction): Promise<void> => {
      const confirmed = await notices.confirm({
        title: action.title,
        content: action.consequences,
        okText: action.label,
        danger: action.danger,
      });
      if (!confirmed) return;

      setBusy(action.to);
      try {
        await iam.users.update(user.id, { status: action.to });
        notices.success(`${user.full_name} is now ${action.to}.`);
        // A transition revokes sessions and invalidates grants (Doc 03 §8,
        // Doc 04 §7), and neither is instantaneous everywhere.
        notices.accessChanged();
        onChanged();
      } catch (error) {
        notices.error(error);
      } finally {
        setBusy(null);
      }
    },
    [iam, notices, onChanged, user.id, user.full_name],
  );

  const sendReset = useCallback(async (): Promise<void> => {
    const slug = auth.subject?.clientSlug ?? null;
    if (slug === null) {
      notices.error(
        new Error('Your session does not carry a tenant slug; sign in again.'),
      );
      return;
    }

    const confirmed = await notices.confirm({
      title: `Send a password reset to ${user.email}?`,
      content:
        'They receive a single-use link that expires. Their current password ' +
        'keeps working until they use it, and nothing about the account changes ' +
        'in the meantime.',
      okText: 'Send reset',
    });
    if (!confirmed) return;

    setBusy('reset');
    try {
      await iam.auth.requestPasswordReset({ email: user.email, client_slug: slug });
      // `202` regardless of what was found — the endpoint does not disclose
      // whether an account exists (Doc 03 §7) — so this says what was sent.
      notices.success(`A reset was requested for ${user.email}.`);
    } catch (error) {
      notices.error(error);
    } finally {
      setBusy(null);
    }
  }, [auth.subject, iam, notices, user.email]);

  const actions = statusActions(user.status);

  return (
    <Space wrap>
      {actions.map((action) => (
        <Tooltip
          key={action.to + action.label}
          title={canUpdate ? action.consequences : `You do not hold ${P.USER_UPDATE}.`}
        >
          <Button
            danger={action.danger}
            disabled={!canUpdate}
            loading={busy === action.to}
            onClick={() => void apply(action)}
          >
            {action.label}
          </Button>
        </Tooltip>
      ))}

      <Tooltip title="Sends a single-use, expiring link. No password is ever typed here on their behalf.">
        <Button loading={busy === 'reset'} onClick={() => void sendReset()}>
          Send password reset
        </Button>
      </Tooltip>
    </Space>
  );
}
