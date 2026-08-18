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
  /**
   * "Are you sure?", resolving to what they chose.
   *
   * Here for the same reason `error` is: `Modal.confirm(…)` called statically
   * renders outside `ConfigProvider`, so it arrives unthemed and, in dark mode,
   * close to unreadable. `App.useApp()` gives the hooked version, and
   * `PlantOpsThemeProvider` mounts the `App` it needs.
   *
   * A promise rather than an `onOk` callback because the thing a caller does
   * next is almost always `await` — deactivate, then reload — and threading
   * that through a callback turns one linear function into two.
   */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

export interface ConfirmOptions {
  title: string;
  /** What the action does, and what it does *not* do. Worth writing. */
  content?: React.ReactNode;
  okText?: string;
  cancelText?: string;
  /** Renders the confirm button in the danger tone. */
  danger?: boolean;
}

export function useNotices(): Notices {
  const { message, modal, notification } = App.useApp();

  return React.useMemo<Notices>(
    () => ({
      error: (error, options) => {
        const described = describeError(error);
        notification.error({
          message: options?.title ?? described.copy.title,
          description: (
            <>
              <div>{described.copy.description}</div>
              {/*
                The field complaints, spelled out.

                A `VALIDATION_FAILED` toast says "check the highlighted fields",
                which is only true if the screen managed to attach each detail to
                an input. It often cannot: an endpoint that takes a bulk body
                addresses its complaints to `nodes[0].route` while the form
                editing that single node calls the field `route`, and anything a
                screen fails to place is dropped. Without this list the operator
                is told to correct fields that are not marked, with no way to
                learn which value was wrong — the toast becomes a dead end.

                Listing them here costs nothing when the screen *did* place them:
                the field is highlighted and the toast repeats why.
              */}
              {described.details.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingInlineStart: 20 }}>
                  {described.details.map((detail) => (
                    <li key={`${detail.field}:${detail.message}`}>
                      <strong>{detail.field}</strong> — {detail.message}
                    </li>
                  ))}
                </ul>
              )}
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

      confirm: (options) =>
        new Promise<boolean>((resolve) => {
          modal.confirm({
            title: options.title,
            content: options.content,
            okText: options.okText ?? 'Confirm',
            cancelText: options.cancelText ?? 'Cancel',
            okButtonProps: options.danger === true ? { danger: true } : undefined,
            onOk: () => resolve(true),
            // Fires for the cancel button, the close icon and the mask click
            // alike, so every way out of the dialog resolves rather than
            // leaving the caller's `await` pending forever.
            onCancel: () => resolve(false),
          });
        }),
    }),
    [message, modal, notification],
  );
}
