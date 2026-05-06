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

interface UserWorkspacesResponse {
  values?: Array<{
    slug?: string;
    name?: string;
    uuid?: string;
  }>;
}

export interface BitbucketValidation extends BitbucketUser {
  /** All workspace slugs the credential can see — populated from
   *  /2.0/user/workspaces. The first one is selected by default for the
   *  navbar workspace label. */
  workspaces?: string[];
}

/**
 * Validate the credential pair against Bitbucket.
 *
 * The /2.0/user/workspaces endpoint (the supported replacement after
 * CHANGE-2770 killed /2.0/workspaces and /2.0/user/permissions/workspaces
 * in 2026-Q1) lists every workspace the caller can see — auth check +
 * workspace enumeration in one call. We try /2.0/user first for the
 * display name, but fall through to /2.0/user/workspaces on 403/410
 * since some scoped tokens have workspace scope but not account scope.
 */
export async function validate(
  username: string,
  appPassword: string,
): Promise<BitbucketValidation> {
  let display_name: string | undefined;
  let account_id: string | undefined;

  const userRes = await bbFetch("/2.0/user", username, appPassword);
  if (userRes.ok) {
    const u = (await userRes.json()) as BitbucketUser;
    display_name = u.display_name;
    account_id = u.account_id;
  } else if (userRes.status === 401) {
    // Bad credential — no fallback worth attempting.
    throw new BitbucketError(401, "/2.0/user", await userRes.text());
  } else if (userRes.status !== 403 && userRes.status !== 410 && userRes.status !== 404) {
    throw new BitbucketError(userRes.status, "/2.0/user", await userRes.text());
  }
  // 403/410/404 just means the token lacks `account` scope; the
  // workspace listing is the actual authorization probe.

  const wsRes = await bbFetch("/2.0/user/workspaces?pagelen=100", username, appPassword);
  if (!wsRes.ok) {
    throw new BitbucketError(
      wsRes.status,
      "/2.0/user/workspaces",
      await wsRes.text(),
    );
  }
  const data = (await wsRes.json()) as UserWorkspacesResponse;
  const workspaces = (data.values ?? [])
    .map((w) => w.slug)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  return {
    display_name,
    account_id,
    workspaces,
  };
}
