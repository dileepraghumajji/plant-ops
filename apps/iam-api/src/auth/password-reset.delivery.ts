/**
 * How a reset token reaches the person who asked for it (Doc 03 §7).
 *
 * ## Why this is a port and not a mailer
 *
 * v1 has no mail transport, and inventing one here would be the wrong call
 * twice over: the channel is a deployment decision (SMTP, SES, the WhatsApp
 * path Doc 03 §10 reserves), and picking it inside the auth module would put a
 * network client in the request path of an endpoint that must answer 202
 * whatever happens. So the service depends on an interface, and the process
 * binds whatever it has.
 *
 * ## What the default binding does, and why it is loud
 *
 * {@link LoggingPasswordResetDelivery} writes the token to the log **outside
 * production**, so the flow is completable on a developer's machine and in the
 * integration suites without a mail server. In production it writes an error
 * naming the misconfiguration and **not** the token.
 *
 * That split is deliberate and it is the only place in this codebase where a
 * credential is written to a log at all. Doc 10 §8 forbids secrets in the audit
 * trail and log lines are the same class of sink, so the guard is the
 * environment rather than a comment asking people to be careful. The production
 * branch is not a fallback that degrades quietly either — a deployment that
 * reaches it has a password-reset feature that silently does nothing, and the
 * error is what makes that visible before a user reports it.
 */

import { Injectable, Logger } from '@nestjs/common';

export const PASSWORD_RESET_DELIVERY = Symbol('PASSWORD_RESET_DELIVERY');

/** Everything a channel needs to send the message, and nothing more. */
export interface PasswordResetMessage {
  /** The address that asked, already normalised to lowercase. */
  email: string;
  /** Which tenant the reset is for — the same slug login takes. */
  clientSlug: string;
  /** The raw token. This is the one moment it exists outside the requester. */
  token: string;
  expiresAt: Date;
}

export interface PasswordResetDelivery {
  /**
   * Sends the message, or throws.
   *
   * A throw never reaches the caller of `/auth/password/reset-request`: the
   * endpoint answers 202 regardless (Doc 06 §3), and a delivery failure that
   * changed the status code would turn the channel's health into an
   * enumeration signal.
   */
  deliver(message: PasswordResetMessage): Promise<void>;
}

@Injectable()
export class LoggingPasswordResetDelivery implements PasswordResetDelivery {
  private readonly logger = new Logger('PasswordResetDelivery');

  constructor(private readonly production: boolean) {}

  async deliver(message: PasswordResetMessage): Promise<void> {
    if (this.production) {
      this.logger.error(
        'A password reset was requested but no delivery channel is configured, ' +
          'so the token was discarded. Bind PASSWORD_RESET_DELIVERY to a real ' +
          `transport. (client=${message.clientSlug})`,
      );
      return;
    }

    this.logger.warn(
      `No delivery channel is configured; printing the reset token for ` +
        `${message.email} (client=${message.clientSlug}) because this is not a ` +
        `production environment. Expires ${message.expiresAt.toISOString()}.\n` +
        `    token: ${message.token}`,
    );
  }
}
