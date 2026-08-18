'use client';

/**
 * Feedback: what the console says after something succeeded, failed, or will
 * take a moment to take effect.
 *
 * Goes through antd's `App.useApp()` hooks rather than the static
 * `message.error(…)` functions, because the static ones render outside the
 * React tree and therefore outside `ConfigProvider` — they come out unthemed,
 * and in dark mode nearly unreadable. `PlantOpsThemeProvider` mounts the `App`
 * these hooks need.
 *
 * ## Why an error toast is a *notification* and a success is a *message*
 *
 * A success is an acknowledgement: it needs a second of the user's attention
 * and then should get out of the way. A failure needs to be read, may carry a
 * request id worth copying, and must not vanish while the user is still working
 * out what happened — so it stays until dismissed.
 */

import { App } from 'antd';
import * as React from 'react';

import { describeError, type DescribedError } from './errors';

export interface Notices {
  /**
   * Reports a failure and hands back what it was, so a caller that also wants
   * to render it inline does not describe it twice.
   */
  error: (error: unknown, options?: { title?: string }) => DescribedError;
  success: (text: string) => void;
  info: (text: string) => void;
  /**
   * The Doc 09 §4 notice: "after a role/binding change, surface that access
   * updates may take a few seconds (cache invalidation, Doc 04 §7)".
   *
   * Every screen that grants, revokes, or changes what a role carries owes the
   * admin this sentence. Without it, the admin checks immediately, sees the old
   * access, and concludes the change did not save — the single most predictable
   * misreading of a correctly-working cache.
   */
  accessChanged: (text?: string) => void;
}

export function useNotices(): Notices {
  const { message, notification } = App.useApp();

  return React.useMemo<Notices>(
    () => ({
      error: (error, options) => {
        const described = describeError(error);
        notification.error({
          message: options?.title ?? described.copy.title,
          description: (
            <>
              <div>{described.copy.description}</div>
              {described.requestId !== null && (
                <div style={{ marginBlockStart: 8, fontSize: 12, opacity: 0.75 }}>
                  Request {described.requestId}
                </div>
              )}
            </>
          ),
          duration: 0,
        });
        return described;
      },

      success: (text) => {
        void message.success(text);
      },

      info: (text) => {
        void message.info(text);
      },

      accessChanged: (text) => {
        void message.info(
          text ??
            'Saved. Access changes can take a few seconds to reach every screen.',
          4,
        );
      },
    }),
    [message, notification],
  );
}
