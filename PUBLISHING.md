# Publishing elysia-autoscale (owner checklist)

Not shipped in the tarball (`files` in package.json lists only `src`, `docs`, `README.md`, `LICENSE`, `CHANGELOG.md`).
Nothing has been published. `elysia-autoscale` was unclaimed on npm when this was prepared; re-check right before.

## 1. Fill in what only you know

Replace the values in capitals, then run from `packages/elysia-autoscale`:

```bash
npm pkg set author="YOUR NAME <you@example.com>"
npm pkg set repository.type=git repository.url="git+https://github.com/YOU/REPO.git"
npm pkg set homepage="https://github.com/YOU/REPO#readme"
npm pkg set bugs.url="https://github.com/YOU/REPO/issues"
```

If the package lives in a subfolder of a bigger repo, also: `npm pkg set repository.directory=packages/elysia-autoscale`.


## 2. Check, then publish

```bash
cd packages/elysia-autoscale
npm view elysia-autoscale            # must say 404 (name free)
bun test                             # package tests
npm pack --dry-run                   # expect 13 files: src/*, docs/ADDING-A-RUNTIME.md, README, LICENSE, CHANGELOG, package.json
npm login
npm publish --access public          # asks for your 2FA code
```

If the name is taken, rename it (or scope it, e.g. `npm pkg set name=@YOU/elysia-autoscale`; `publishConfig.access` is already public).

## 3. Tag it

```bash
git tag elysia-autoscale-v0.1.0 && git push origin elysia-autoscale-v0.1.0
```

## 4. Switch the backend to the npm copy (after it is published)

1. `package.json` (backend): `"elysia-autoscale": "workspace:*"` -> `"elysia-autoscale": "^0.1.0"`.
2. Delete `packages/elysia-autoscale`, the `"workspaces"` entry, the `test:packages` script (and its use in `test`).
3. `Dockerfile`: remove the `COPY packages/elysia-autoscale/package.json ...` and `COPY ./packages ./packages` lines.
4. `bun install`, `bun run typecheck`, `bun run test`, `bun run build`; deploy to staging and watch for the `workers: ...` log lines under load before production.

## Known gaps (also in the README)

- A real container with a CPU or memory limit set was never read end to end; only the unlimited case ran.
- cgroup v1 hosts, Windows, Node and Deno are untested. Tested: Bun 1.4.x, Elysia 2.0.0-rc.4, Linux.
- The package ships TypeScript source (no build step); Bun or a bundler is required.
