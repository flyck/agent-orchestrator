/**
 * Bitbucket Cloud HTTP client. We only need validate(username, appPassword)
 * for now — the orchestrator stores the credential pair and labels the
 * integration as configured. Repo / PR fetching can land later when the
 * Review page grows a Bitbucket source.
 *
 * Auth: HTTP Basic — username + app password. App passwords are created at
 * https://bitbucket.org/account/settings/app-passwords/ and are scoped per
 * app. Atlassian API tokens (the email + token model used elsewhere in the
 * Atlassian suite) also work via Basic auth, with the email in the username
 * field.
 */

const BB_BASE = "https://api.bitbucket.org";

export class BitbucketError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`bitbucket ${path} → ${status}: ${body.slice(0, 240)}`);
    this.name = "BitbucketError";
  }
}

function basicHeader(username: string, appPassword: string): string {
  return `Basic ${Buffer.from(`${username}:${appPassword}`).toString("base64")}`;
}

async function bbJson<T>(
  path: string,
  username: string,
  appPassword: string,
): Promise<T> {
  const res = await fetch(`${BB_BASE}${path}`, {
    headers: {
      authorization: basicHeader(username, appPassword),
      accept: "application/json",
      "user-agent": "agent-orchestrator",
    },
  });
  if (!res.ok) throw new BitbucketError(res.status, path, await res.text());
  return res.json() as Promise<T>;
}

export interface BitbucketUser {
  /** Atlassian account id — stable across username changes. */
  account_id: string;
  /** Display name; absent on some workspace-token responses. */
  display_name?: string;
  /** Username (slug); absent on token-only auth. */
  username?: string;
  /** Email field is gated behind the "email" scope on the credential. */
  email?: string;
}

export async function validate(
  username: string,
  appPassword: string,
): Promise<BitbucketUser> {
  return bbJson<BitbucketUser>("/2.0/user", username, appPassword);
}
