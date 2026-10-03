# Operational steps pending (user checklist)

Everything the agents could not do because it touches real infrastructure (SSH, Vault, Authentik, Cloudflare, GitHub
settings). Work through it in order and tick items off. Later plans may append their own operational steps to this
file. Step numbers refer to `OPERATIONS.md` in the repo root.

## SP1 plan 4 (infra and deploy)

Before merging the branch `feat/sp1-plan4-infra-deploy` to `main`:

- [ ] Be aware that merging queues a Deploy run automatically (CI succeeds, then `deploy.yml` fires). It stays queued
      until a runner labelled `daemonet` exists, so nothing deploys by accident, but it must be cancelled before the
      runner is registered (see below).
- [ ] Create the GitHub `production` environment now (Settings > Environments) with deployment branches set to `main`
      only (OPERATIONS Step 2b). A queued run may auto-create it without that restriction; set it either way.

Before registering the runner (OPERATIONS Step 2, "Before registering the runner"):

- [ ] `gh run list --workflow deploy.yml --repo Zaphiruz/daemonet` and cancel every queued or waiting run with
      `gh run cancel <id> --repo Zaphiruz/daemonet`.
- [ ] After the runner is registered and the `production` environment is configured, set the repository variable
      `DAEMONET_DEPLOY_ENABLED` to `true` (GitHub → Settings → Secrets and variables → Actions → Variables, or
      `gh variable set DAEMONET_DEPLOY_ENABLED --body true --repo Zaphiruz/daemonet`); until then deploys are skipped.

Then, in order:

- [ ] Task 2: S1 baseline incl. the Vault reachability probe, runner user `.ssh` setup, deploy key, clone, runner
      registration (OPERATIONS Steps 1, 2, 2b).
- [ ] Task 3: PostgreSQL user, database and LAN-only publishing on S2 with the `DOCKER-USER` rule (Step 3). Do it at a
      quiet time: it briefly restarts the shared database.
- [ ] Task 4: Authentik public client `daemonet-bot` with the device flow, groups `daemonet-users`/`daemonet-admins`
      (Step 4).
- [ ] Task 5: Vault secrets and the app token: `bash scripts/provision-secrets.sh`, then the token and `.env` on S1
      (Steps 5 and 6).
- [ ] Task 6: nginx on LC2 and the Cloudflare Tunnel hostname (Step 7).
- [ ] Task 7: first deploy and the acceptance checklist, including the staging load test (Steps 8 and 9).
- [ ] Task 8, after the first deploy has been accepted:
  - [ ] Add the Daemonet entries to the homelab doc `D:\docs\MikroTik\CLAUDE.md` (OPERATIONS Step 10): S1 hosts
        Daemonet on 3010, shared PostgreSQL published on `192.168.40.20:5432` restricted to S1, the nginx
        `websocket-upgrade.conf` map, Authentik `daemonet-bot` public client + device flow, Vault `secret/daemonet`,
        runner `s1-daemonet`, port table entry.
  - [ ] Edit the SP1 spec `docs/superpowers/specs/2026-09-27-daemonet-sp1-core-sim-design.md`: in section 10 replace
        "Redis is provisioned now..." with "Redis is not provisioned or used in SP1", and mark the section 11
        acceptance items as verified with the date.
  - [ ] Commit those docs and push (a docs-only push does not redeploy).

## SP2 plan 1 (web API)

Before the first deploy that includes `apps/api` (OPERATIONS Steps 4 item 5, 5, 8, 9 item 6):

- [ ] Authentik: create the **confidential** provider `daemonet` (web login) and the application `Daemonet Web` (slug
      `daemonet`), bound to `daemonet-users`; redirect URI = `FRONTEND_ORIGIN` + `/api/auth/callback`, i.e.
      `https://daemonet.wispy-nook.casa/api/auth/callback`; same scopes incl. `groups`. Note Client ID and Secret.
- [ ] Vault: re-run `bash scripts/provision-secrets.sh` (it now also asks for the web client ID and secret and adds
      `SESSION_SECRET`, `SESSION_COOKIE_SECURE`, `FRONTEND_ORIGIN`, `AUTHENTIK_WEB_ISSUER_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`,
      `AUTHENTIK_REDIRECT_URI`, `AUTH_ADMIN_GROUP`): expect `kv written: 17 keys`. It is a full replace, so re-apply any
      `vault kv patch` changes afterwards.
- [ ] `TRUST_PROXY_HOPS` is one key shared by the sim and the api (value `3`); confirm it still matches the chain
      (acceptance 5 and 6).
- [ ] The first deploy log shows `Ignored non-allowlisted key(s)` for both services: expected (each app drops the
      other's keys).
- [ ] After the deploy: `curl https://daemonet.wispy-nook.casa/api/ready` returns `{"ok":true}` and the OPERATIONS
      Step 9 item 6 login check passes.

## SP2 plan 3 (web client)

The frontend image now serves the Vite build (the SP1 placeholder page is gone) plus the static player-script
sandbox. Nothing new is needed in Vault or Authentik; the checks below happen after the first deploy that includes it.

- [ ] Deploy as usual (push `main` with CI green; the CI `e2e` job runs the Playwright smoke first). The frontend image
      build now compiles the libraries and the client, so the first build on S1 takes a few minutes.
- [ ] OPERATIONS Step 9 item 6, "Web client (SP2 plan 3)": log in, claim/see RAM, move, capture panel, Script tab run
      (`online as …` in the Log), spectate.
- [ ] In the browser devtools confirm there are no Content-Security-Policy violations on `/` and that
      `curl -sI https://daemonet.wispy-nook.casa/sandbox.html` shows the strict `default-src 'none'; script-src 'self' blob:`
      policy and `X-Frame-Options: SAMEORIGIN`, reachable without logging in. If a Cloudflare rule or the nginx
      server block on LC2 adds its own `Content-Security-Policy`, remove it for `/sandbox.html` (two policies would
      both apply).
- [ ] Optional hardening not done in this plan: the `frontend` service in `docker-compose.prod.yml` has no `cap_drop`,
      `read_only` or resource limits like `sim`/`api` (Caddy needs `/data` and `/config` writable and `NET_BIND_SERVICE`);
      add them after testing on S1.
