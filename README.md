# Branch compare

Pick a GitHub owner, repository and branch. Branch compare runs that branch and `main` side by side, each in its own
container, then gives you two ways to compare them:

- **Synced preview**: both applications in side-by-side iframes. Clicks, typing, keys, hover, scroll and link
  navigation in one pane are replayed in the other.
- **Visual comparison**: full-page screenshots of both, with a pixel difference image and a percentage.

## Start

Needs Node 22 or newer, pnpm, Docker (Docker Desktop or Colima) and Google Chrome.

```sh
pnpm install
pnpm start
```

Open http://branch-compare.localhost:3000 in Chrome, Edge or Firefox. `pnpm test` runs the tests.

Port 3000 must be free. To use another port run `PORT=3100 pnpm start`; the applications still listen on 3000 inside
their containers, but the browser address then shows the other port.

## Development

- `pnpm lint` runs Oxlint and `pnpm fmt` runs Oxfmt.
- A pre-commit hook lints and formats the staged files, then runs the tests.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), checked by commitlint.

## GitHub token

Private and organisation repositories need a token. Branch compare takes the first of these:

1. A token you enter on the page with **Add token**. It is checked against GitHub, kept in memory only, and forgotten
   when Branch compare stops.
2. The `GITHUB_TOKEN` (or `GH_TOKEN`) environment variable.
3. The token of a logged-in `gh` CLI.

The token needs read access to the organisation's repositories (classic tokens: the `repo` scope, and SSO
authorisation if the organisation enforces it). Without a token only public repositories are listed, and the page says
so. A rejected token is reported with GitHub's reason.

## How every application sees port 3000

- Each branch is fetched into `data/workspaces/<slug>` and started in its own Docker container with `PORT=3000`.
  Containers do not share a network, so `main` and the branch both listen on 3000 at the same time.
- A small forwarder inside the container makes the application reachable even when it only binds `localhost:3000`.
- Branch compare listens on port 3000 and routes by hostname: `<slug>.branch-compare.localhost:3000` goes to that
  branch's container. The application sees port 3000 in the `Host` header and in `location.port`.
- The same proxy adds the synced-preview agent to each page and removes the headers that forbid framing.

## Settings

| Variable         | Default   | Meaning                              |
| ---------------- | --------- | ------------------------------------ |
| `PORT`           | `3000`    | Port Branch compare listens on       |
| `RUNNER_IMAGE`   | `node:24` | Docker image the applications run in |
| `DATA_DIRECTORY` | `./data`  | Where branches are fetched to        |

The start command is detected from the lockfile (`npm`, `pnpm` or `yarn`, running the `dev` script, else `start`).
Set **Start command** on the page when the application needs something else, for example Vite:
`npm install && npm run dev -- --port 3000`.

## Known limits

- The application is reached as `<slug>.branch-compare.localhost:3000`, not `localhost:3000`. A login provider that
  only allows `http://localhost:3000/...` callback addresses will send the browser to Branch compare instead of the
  application.
- Applications get no `.env` file or secrets; a branch that needs them will fail to start until they are provided
  in the start command.
- Next.js 16 may refuse its hot-reload websocket for these hostnames. Pages still load; add the hostname to
  `allowedDevOrigins` if you need hot reload.
- The synced preview is the vendored component from `synced-preview`
  (`web/src/components/synced-preview/`). Its own limits apply: CSS `:hover` does not mirror, and `pushState`
  navigation is only mirrored through the click that caused it.
- The comparison captures one page path at a 1280 pixel wide viewport.
