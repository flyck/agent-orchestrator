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

async function bbFetch(
  path: string,
  username: string,
  appPassword: string,
): Promise<Response> {
  return fetch(`${BB_BASE}${path}`, {
    headers: {
      authorization: basicHeader(username, appPassword),
      accept: "application/json",
      "user-agent": "agent-orchestrator",
    },
  });
}

async function bbJson<T>(
  path: string,
  username: string,
  appPassword: string,
): Promise<T> {
  const res = await bbFetch(path, username, appPassword);
  if (!res.ok) throw new BitbucketError(res.status, path, await res.text());
  return res.json() as Promise<T>;
}

export interface BitbucketUser {
  /** Atlassian account id — stable across username changes. */
  account_id?: string;
  /** Display name; absent on some workspace-token responses. */
  display_name?: string;
  /** Username (slug); absent on token-only auth. */
  username?: string;
  /** Email field is gated behind the "email" scope on the credential. */
  email?: string;
}

interface WorkspaceResponse {
  slug?: string;
  name?: string;
  uuid?: string;
}

/**
 * Validate the credential pair against Bitbucket. As of CHANGE-2770
 * (sunset 2026-04-14) all "cross-workspace" introspection endpoints —
 * `/2.0/user`, `/2.0/repositories?role=member`, `/2.0/workspaces`,
 * `/2.0/user/permissions/workspaces` — return 410 Gone for the new
 * Atlassian-issued Bitbucket API tokens. Atlassian's recommended
 * replacement is to scope every call to a known workspace.
 *
 * So the validate flow now requires a workspace slug and probes
 * `/2.0/workspaces/{workspace}` (the workspace metadata endpoint, which
 * survives) — that doubles as auth check + workspace existence check
 * in one call. Returns the workspace name for the connected-as label.
 *
 * Old-style app passwords with the `account:read` scope still hit
 * `/2.0/user` successfully, so we try that first when no workspace
 * slug was provided — only the new tokens are forced to specify one.
 */
export async function validate(
  username: string,
  appPassword: string,
  workspace: string | null,
): Promise<BitbucketUser> {
  if (!workspace) {
    // No workspace given → assume legacy app password and try /2.0/user.
    const userRes = await bbFetch("/2.0/user", username, appPassword);
    if (userRes.ok) {
      return userRes.json() as Promise<BitbucketUser>;
    }
    if (userRes.status === 401) {
      throw new BitbucketError(401, "/2.0/user", await userRes.text());
    }
    // 403 / 410 → token is the new kind that needs a workspace slug.
    throw new BitbucketError(
      userRes.status,
      "/2.0/user",
      `Atlassian API tokens cannot introspect across workspaces — please fill in the 'workspace' field. Original: ${await userRes.text()}`,
    );
  }

  const slug = encodeURIComponent(workspace);
  const wsRes = await bbFetch(`/2.0/workspaces/${slug}`, username, appPassword);
  if (wsRes.ok) {
    const data = (await wsRes.json()) as WorkspaceResponse;
    return { username: data.slug, display_name: data.name };
  }
  throw new BitbucketError(
    wsRes.status,
    `/2.0/workspaces/${slug}`,
    await wsRes.text(),
  );
}
