// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceControlProviderError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

const makeRepositoryIdentityResolverTestLayer = (options: {
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}) =>
  Layer.effect(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    RepositoryIdentityResolver.make({
      cacheCapacity: 16,
      ...options,
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("refreshes the Git root only when requested", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let rootPath = "/repo";
    let remoteUrl = "git@github.com:T3Tools/t3code.git";
    let refinements = 0;
    let refinementFails = false;
    const processRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          return {
            stdout: input.args.includes("rev-parse")
              ? `${rootPath}\n`
              : `origin\t${remoteUrl} (fetch)\n`,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const resolverLayer = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make({
        refine: (identity) => {
          refinements++;
          if (refinementFails)
            return Effect.fail(
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "detectProvider",
                cwd: rootPath,
                detail: "account unavailable",
              }),
            );
          return Effect.succeed(
            identity.canonicalKey.startsWith("ssh.forge.test/")
              ? {
                  ...identity,
                  provider: "forgejo",
                  webUrl: "http://forge.test:3000/git/team/repo",
                }
              : identity,
          );
        },
      }),
    ).pipe(Layer.provide(processRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const first = yield* resolver.resolve("/repo/packages/web");
      rootPath = "/repo/packages/web";
      // Longer than the one-minute cadence of the background sweeps.
      yield* TestClock.adjust(Duration.minutes(10));
      const second = yield* resolver.resolve("/repo/packages/web");

      expect(first?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(second).toEqual(first);
      expect(refinements).toBe(1);
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
        ["-G", "-l", "git", "github.com"],
      ]);

      const refreshed = yield* resolver.resolve("/repo/packages/web", { refresh: true });
      expect(refreshed?.rootPath).toBe("/repo/packages/web");
      expect(yield* resolver.resolve("/repo/packages/web")).toEqual(refreshed);
      expect(calls.slice(3)).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo/packages/web", "remote", "-v"],
        ["-G", "-l", "git", "github.com"],
      ]);
      remoteUrl = "git@ssh.forge.test:team/repo.git";
      const forgejo = yield* resolver.resolve(rootPath, { refresh: true });
      expect(forgejo?.webUrl).toBe("http://forge.test:3000/git/team/repo");
      expect(forgejo?.provider).toBe("forgejo");
      expect(forgejo?.canonicalKey).toBe("ssh.forge.test/team/repo");
      expect(forgejo?.locator.remoteUrl).toBe(remoteUrl);
      expect(yield* resolver.resolve(rootPath)).toEqual(forgejo);
      expect(refinements).toBe(3);
      refinementFails = true;
      const unavailable = yield* resolver.resolve(rootPath, { refresh: true });
      expect(unavailable?.webUrl).toBeUndefined();
      expect(unavailable?.canonicalKey).toBe("ssh.forge.test/team/repo");
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), resolverLayer)));
  });

  it.effect("retries Git root discovery after the negative TTL", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let rootAttempts = 0;
    const processRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          const rootLookup = input.args.includes("rev-parse");
          const failed = rootLookup && rootAttempts++ === 0;
          return {
            stdout: rootLookup
              ? failed
                ? ""
                : "/repo\n"
              : "origin\tgit@github.com:T3Tools/t3code.git (fetch)\n",
            stderr: failed ? "temporary Git failure" : "",
            code: ChildProcessSpawner.ExitCode(failed ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const resolverLayer = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make(),
    ).pipe(Layer.provide(processRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve("/repo/packages/web")).toBeNull();
      expect(yield* resolver.resolve("/repo/packages/web")).toBeNull();

      yield* TestClock.adjust(Duration.minutes(1));
      const recovered = yield* resolver.resolve("/repo/packages/web");
      expect(recovered?.rootPath).toBe("/repo");
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
        ["-G", "-l", "git", "github.com"],
      ]);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), resolverLayer)));
  });

  it.effect("keys a remote through its SSH host alias", () => {
    const sshHosts: Array<string> = [];
    let remoteUrl = "gh:T3Tools/t3code";
    let sshFails = false;
    // `Host gh` / `HostName github.com`, `Host gh443` for the port-443 endpoint,
    // and `alice-box` / `bob-box`, two logins on one server.
    const sshConfigs: Record<string, string> = {
      gh: "user git\nhostname github.com",
      gh443: "user git\nhostname ssh.github.com",
      "alice-box": "user alice\nhostname 192.0.2.10",
      "bob-box": "user bob\nhostname 192.0.2.10",
      nouser: "user localuser\nhostname github.com",
      // `Match originalhost review user git` picks GitHub; otherwise GitLab.
      "git@review": "user git\nhostname github.com",
      review: "user me\nhostname gitlab.com",
    };
    const processRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          const sshArgs = input.args.slice(1);
          const host = sshArgs.at(-1) ?? "";
          const user = sshArgs.includes("-l") ? sshArgs[sshArgs.indexOf("-l") + 1] : undefined;
          if (input.command === "ssh") sshHosts.push(sshArgs.join(" "));
          const config = sshConfigs[`${user}@${host}`] ?? sshConfigs[host];
          const stdout =
            input.command === "ssh"
              ? `${config ?? `user git\nhostname ${host}`}\nport 22\n`
              : input.args.includes("rev-parse")
                ? "/repo\n"
                : `origin\t${remoteUrl} (fetch)\n`;
          const failed = input.command === "ssh" && sshFails;
          return {
            stdout: failed ? "" : stdout,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(failed ? 255 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const resolverLayer = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make(),
    ).pipe(Layer.provide(processRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const resolveKey = (url: string) => {
        remoteUrl = url;
        return resolver.resolve("/repo", { refresh: true });
      };

      const aliased = yield* resolveKey("gh:T3Tools/t3code");
      expect(aliased?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(aliased?.provider).toBe("github");
      expect(aliased?.owner).toBe("t3tools");
      // Git still reaches the repository through the alias.
      expect(aliased?.locator.remoteUrl).toBe("gh:T3Tools/t3code");

      expect((yield* resolveKey("me@gh:T3Tools/t3code.git"))?.canonicalKey).toBe(
        "github.com/t3tools/t3code",
      );
      expect((yield* resolveKey("ssh://gh/T3Tools/t3code.git"))?.canonicalKey).toBe(
        "github.com/t3tools/t3code",
      );
      expect((yield* resolveKey("git+ssh://git@gh:2222/T3Tools/t3code"))?.canonicalKey).toBe(
        "github.com/t3tools/t3code",
      );
      expect((yield* resolveKey("gh443:T3Tools/t3code"))?.canonicalKey).toBe(
        "github.com/t3tools/t3code",
      );
      // A server alias with an absolute path keys like the same path by address.
      const byAlias = yield* resolveKey("alice-box:/srv/git/app.git");
      const byAddress = yield* resolveKey("ssh://deploy@192.0.2.10/srv/git/app.git");
      expect(byAlias?.canonicalKey).toBe("192.0.2.10/srv/git/app");
      expect(byAddress?.canonicalKey).toBe(byAlias?.canonicalKey);
      // The remote's user and port reach ssh, which `Match` rules can depend on.
      expect(sshHosts).toEqual([
        "gh",
        "-l me gh",
        "gh",
        "-l git -p 2222 gh",
        "gh443",
        "alice-box",
        "-l deploy 192.0.2.10",
      ]);
      expect((yield* resolveKey("git@review:Team/App"))?.canonicalKey).toBe("github.com/team/app");
      expect((yield* resolveKey("review:Team/App"))?.canonicalKey).toBe("gitlab.com/team/app");

      // A relative path on a server is in the login's home: two logins, two repositories.
      const aliceHome = "192.0.2.10/~alice/app";
      expect((yield* resolveKey("alice-box:app.git"))?.canonicalKey).toBe(aliceHome);
      expect((yield* resolveKey("bob-box:app.git"))?.canonicalKey).toBe("192.0.2.10/~bob/app");
      expect((yield* resolveKey("alice@192.0.2.10:~/app.git"))?.canonicalKey).toBe(aliceHome);
      expect((yield* resolveKey("ssh://alice@192.0.2.10/~/app.git"))?.canonicalKey).toBe(aliceHome);
      expect((yield* resolveKey("bob-box:~alice/app.git"))?.canonicalKey).toBe(aliceHome);
      // A forge reads the path as the repository, whatever the login.
      expect((yield* resolveKey("me@gitlab.example.com:team/app.git"))?.canonicalKey).toBe(
        "gitlab.example.com/team/app",
      );

      // Every spelling of one repository keys the same, on every kind of host.
      const codeCommit = "git-codecommit.us-east-1.amazonaws.com/v1/repos/app";
      for (const [remote, key] of [
        ["git@bitbucket.org:Team/App.git", "bitbucket.org/team/app"],
        ["https://me@bitbucket.org/Team/App.git", "bitbucket.org/team/app"],
        ["git@git.sr.ht:~alice/app", "git.sr.ht/~alice/app"],
        ["https://git.sr.ht/~alice/app", "git.sr.ht/~alice/app"],
        // A self-hosted forge on a plain name still serves everyone as `git`.
        ["git@git.corp.example:team/app.git", "git.corp.example/team/app"],
        ["https://git.corp.example/team/app", "git.corp.example/team/app"],
        // Per-user logins with absolute paths: CodeCommit's key id, Gerrit's account.
        ["ssh://APKAEXAMPLE@git-codecommit.us-east-1.amazonaws.com/v1/repos/App", codeCommit],
        [`https://${codeCommit}`, codeCommit],
        ["ssh://me@review.corp.example:29418/platform/app", "review.corp.example/platform/app"],
        ["https://review.corp.example/platform/app", "review.corp.example/platform/app"],
        // An alias without `User` logs in as the local account; GitHub ignores it.
        ["nouser:Team/App", "github.com/team/app"],
      ] as const) {
        expect((yield* resolveKey(remote))?.canonicalKey, remote).toBe(key);
      }
      const sshCalls = sshHosts.length;

      // HTTPS never reaches ssh, nor does a host that reads as an option or a
      // user with shell syntax a `Match exec` `%r` would expand.
      expect((yield* resolveKey("https://github.com/T3Tools/t3code"))?.canonicalKey).toBe(
        "github.com/t3tools/t3code",
      );
      yield* resolveKey("-oProxyCommand=calc:T3Tools/t3code");
      yield* resolveKey("x;id@gh:T3Tools/t3code");
      yield* resolveKey("ssh://x%3Bid@gh/T3Tools/t3code");
      expect(sshHosts).toHaveLength(sshCalls);

      // Without ssh, the alias keys the repository as before.
      sshFails = true;
      const unresolved = yield* resolveKey("gh:T3Tools/t3code");
      expect(unresolved?.canonicalKey).toBe("gh/t3tools/t3code");
      // A login spelled in the remote keys its home the same with or without ssh.
      expect((yield* resolveKey("alice@192.0.2.10:app.git"))?.canonicalKey).toBe(aliceHome);
    }).pipe(Effect.provide(resolverLayer));
  });

  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      // Native realpath, since git reports the long form of a directory the
      // temp dir may name by its 8.3 short form on Windows.
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedCwd = NodeFS.realpathSync.native(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(normalizeResolvedPath(resolvedCwd));
      expect(identity?.displayName).toBe("t3tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "packages", "web");

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedRepoRoot = NodeFS.realpathSync.native(repoRoot);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
        normalizeResolvedPath(resolvedRepoRoot),
      );
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns null for non-git folders and repos without remotes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-non-git-",
      });
      const gitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-no-remote-",
      });

      yield* git(gitDir, ["init"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const nonGitIdentity = yield* resolver.resolve(nonGitDir);
      const noRemoteIdentity = yield* resolver.resolve(gitDir);

      expect(nonGitIdentity).toBeNull();
      expect(noRemoteIdentity).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["add", "replace"] as const)(
    "refreshes the primary upstream after %s before cache expiry",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-upstream-test-",
        });

        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
        if (change === "replace") {
          yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/previous.git"]);
        }

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity?.canonicalKey).toBe(
          change === "add" ? "github.com/julius/t3code" : "github.com/t3tools/previous",
        );

        yield* git(cwd, [
          "remote",
          change === "add" ? "add" : "set-url",
          "upstream",
          "git@github.com:T3Tools/t3code.git",
        ]);
        expect(yield* resolver.resolve(cwd)).toEqual(initialIdentity);
        const identity = yield* resolver.resolve(cwd, { refresh: true });

        expect(identity).not.toBeNull();
        expect(identity?.locator.remoteName).toBe("upstream");
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(identity?.displayName).toBe("t3tools/t3code");
        expect(yield* resolver.resolve(cwd)).toEqual(identity);
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:T3Tools/platform/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/t3code");
      expect(identity?.displayName).toBe("t3tools/platform/t3code");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect(
    "keeps null identities cached across repeated resolves until the negative TTL expires",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-late-remote-test-",
        });

        yield* git(cwd, ["init"]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity).toBeNull();

        yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

        for (const _attempt of [1, 2, 3]) {
          const cachedIdentity = yield* resolver.resolve(cwd);
          expect(cachedIdentity).toBeNull();
        }

        yield* TestClock.adjust(Duration.millis(120));

        const refreshedIdentity = yield* resolver.resolve(cwd);
        expect(refreshedIdentity).not.toBeNull();
        expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(refreshedIdentity?.name).toBe("t3code");
      }).pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            makeRepositoryIdentityResolverTestLayer({
              negativeCacheTtl: Duration.millis(50),
              positiveCacheTtl: Duration.seconds(1),
            }),
          ),
        ),
      ),
  );

  it.effect("refreshes cached identities after the positive TTL when a remote changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-remote-change-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const initialIdentity = yield* resolver.resolve(cwd);
      expect(initialIdentity).not.toBeNull();
      expect(initialIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* git(cwd, ["remote", "set-url", "origin", "git@github.com:T3Tools/t3code-next.git"]);

      const cachedIdentity = yield* resolver.resolve(cwd);
      expect(cachedIdentity).not.toBeNull();
      expect(cachedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* TestClock.adjust(Duration.millis(180));

      const refreshedIdentity = yield* resolver.resolve(cwd);
      expect(refreshedIdentity).not.toBeNull();
      expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code-next");
      expect(refreshedIdentity?.displayName).toBe("t3tools/t3code-next");
      expect(refreshedIdentity?.name).toBe("t3code-next");
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          makeRepositoryIdentityResolverTestLayer({
            negativeCacheTtl: Duration.millis(50),
            positiveCacheTtl: Duration.millis(100),
          }),
        ),
      ),
    ),
  );
});
