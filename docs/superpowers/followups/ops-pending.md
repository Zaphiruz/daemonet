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
