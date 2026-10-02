import type { RepositoryIdentity, SourceControlProviderError } from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
// Background sweeps resolve every project each minute. A long TTL keeps them
// from spawning git each time. Clone, publish, and PR discovery (after a turn
// and before it saves links) resolve with `refresh: true`.
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(15);
// Short, so a folder that gains a repository or a remote shows up quickly.
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  readonly refine?: (
    identity: RepositoryIdentity,
  ) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (
      cwd: string,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<RepositoryIdentity | null>;
  }
>()("t3/project/RepositoryIdentityResolver") {}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

// The SSH-over-443 endpoints providers document. They serve the same
// repositories as the main host, so they key the same.
const SSH_ENDPOINT_HOSTS: Readonly<Record<string, string>> = {
  "ssh.github.com": "github.com",
  "altssh.gitlab.com": "gitlab.com",
  "altssh.bitbucket.org": "bitbucket.org",
};
// Only plain host and user names go to ssh, so a remote can neither pass it an
// option (`-oProxyCommand=…`) nor put shell syntax in the `%h` / `%r` tokens a
// `Match exec` line expands. OpenSSH before 9.6 does not reject those itself.
const SSH_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

interface SshRemote {
  readonly user: string | undefined;
  readonly host: string;
  readonly port?: string;
  readonly path: string;
}

/**
 * The parts of an SSH remote in either spelling git accepts: `[user@]host:path`
 * or `ssh://[user@]host[:port]/path`. Null for every other transport.
 */
function parseSshRemote(remoteUrl: string): SshRemote | null {
  const trimmed = remoteUrl.trim();
  if (/^(?:ssh|git\+ssh|ssh\+git):\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed.replace(/^[^:]+:/, "ssh:"));
      if (!url.hostname || url.pathname.length <= 1) return null;
      // The path stays absolute, so the SCP spelling below names the same one.
      return {
        user: url.username ? decodeURIComponent(url.username) : undefined,
        host: url.hostname,
        ...(url.port ? { port: url.port } : {}),
        path: url.pathname,
      };
    } catch {
      return null;
    }
  }
  if (trimmed.includes("://")) return null;
  // A one-letter host is a Windows drive, which git reads as a path.
  const match = /^(?:([^@/\s]+)@)?([^:/\s@]{2,}):(\S+)$/.exec(trimmed);
  const [, user, host, path] = match ?? [];
  return host && path ? { user, host, path } : null;
}

function parseSshConfigValue(stdout: string, key: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const [name, ...value] = line.trim().split(/\s+/);
    if (name?.toLowerCase() === key && value.length > 0) return value.join(" ");
  }
  return undefined;
}

/**
 * The path with a relative one spelled under its login's home (`~user/app.git`).
 *
 * On a plain server `alice@host:app.git` and `bob@host:app.git` are two
 * repositories, one in each home. Forges serve every repository to one shared
 * `git` login and read the path as the repository's name, so theirs stay as is.
 */
function homeQualifiedPath(path: string, user: string | undefined, host: string): string {
  if (!user || user === "git") return path;
  if (detectSourceControlProviderFromGitRemoteUrl(`git@${host}:`)?.kind !== "unknown") return path;
  const inOwnHome = path.replace(/^\/?~\//, "");
  // Absolute (`/srv/app.git`) or in a named home (`~other/app.git`) already.
  if (inOwnHome === path && /^[/~]/.test(path)) return path;
  return `~${user}/${inOwnHome}`;
}

/**
 * The remote with an `~/.ssh/config` host alias replaced by the host it names.
 *
 * `gh:owner/repo` with `Host gh` / `HostName github.com` is the same repository
 * as `https://github.com/owner/repo`, but only ssh knows that. Asking `ssh -G`
 * reads the config the way ssh does (`Include`, `Match`, wildcards) without
 * connecting. The remote's user and port go along, since `Match` rules can
 * depend on them. A remote that is not SSH, or that ssh cannot read, stays as is.
 */
const expandSshHostAlias = Effect.fn("RepositoryIdentityResolver.expandSshHostAlias")(function* (
  remoteUrl: string,
) {
  const remote = parseSshRemote(remoteUrl);
  if (
    !remote ||
    ![remote.host, remote.user ?? "git"].every((name) => SSH_NAME_PATTERN.test(name))
  ) {
    return remoteUrl;
  }

  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: "ssh",
      args: [
        "-G",
        ...(remote.user ? ["-l", remote.user] : []),
        ...(remote.port ? ["-p", remote.port] : []),
        remote.host,
      ],
      timeout: Duration.seconds(5),
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  const sshConfig = result._tag === "Some" && result.value.code === 0 ? result.value.stdout : "";

  const hostName = (parseSshConfigValue(sshConfig, "hostname") ?? remote.host).toLowerCase();
  const host = SSH_ENDPOINT_HOSTS[hostName] ?? hostName;
  // An IPv6 address has no SCP spelling without brackets git would misread.
  if (host.includes(":")) return remoteUrl;
  const user = remote.user ?? parseSshConfigValue(sshConfig, "user");
  const path = homeQualifiedPath(remote.path, user, host);
  if (host === remote.host.toLowerCase() && path === remote.path) return remoteUrl;
  return `${user ?? "git"}@${host}:${path}`;
});

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  /** The remote with SSH host aliases expanded, which keys the repository. */
  readonly resolvedRemoteUrl: string;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.resolvedRemoteUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(
    input.resolvedRemoteUrl,
  );
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;

    // git is a real executable on every platform — no cmd.exe shell mode, which
    // would split paths containing spaces during cmd's re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-toplevel"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "None" || topLevelResult.value.code !== 0) {
      return null;
    }

    const candidate = topLevelResult.value.stdout.trim();
    return candidate.length > 0 ? candidate : null;
  },
);

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* (
  cacheKey: string,
): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const remoteResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", cacheKey, "remote", "-v"],
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  // `git remote -v` already applies `url.<base>.insteadOf`; SSH host aliases
  // live outside git, so they are expanded here.
  const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.value.stdout));
  if (!remote) return null;
  const resolvedRemoteUrl = yield* expandSshHostAlias(remote.remoteUrl);
  return buildRepositoryIdentity({ ...remote, resolvedRemoteUrl, rootPath: cacheKey });
});

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const cacheCapacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;
  const refine = options.refine ?? Effect.succeed;
  // Git errors and timeouts resolve to null, so they use the negative TTL like
  // "no repository" or "no remote". Only interrupts and defects skip the cache.
  const timeToLive = (exit: Exit.Exit<unknown>) =>
    Exit.match(exit, {
      onSuccess: (value) =>
        value === null
          ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
          : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
      onFailure: () => Duration.zero,
    });

  const repositoryRootCache = yield* Cache.makeWith<string, string | null>(
    (cwd) =>
      resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cacheKey) =>
      resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.filterOrElse(
          (identity): identity is null => identity === null,
          (identity) => refine(identity).pipe(Effect.orElseSucceed(() => identity)),
        ),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  // Untraced because almost every call is a cache hit. The lookups that spawn
  // git keep their own spans.
  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fnUntraced(
    function* (cwd, options) {
      if (options?.refresh) yield* Cache.invalidate(repositoryRootCache, cwd);
      const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
      if (cacheKey === null) return null;
      if (options?.refresh) yield* Cache.invalidate(repositoryIdentityCache, cacheKey);
      return yield* Cache.get(repositoryIdentityCache, cacheKey);
    },
  );

  return RepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
