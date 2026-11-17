---
title: Sync with Convex
description: Set up your Convex deployment for Leaflogue, step by step.
---

[Convex](https://www.convex.dev/) is a hosted database service. You
put Leaflogue's backend on your own Convex project, create a **sync key**, and
paste the deployment's address and the key into Leaflogue on each computer.
You never need the Leaflogue source code.

## Two things you will copy

- **The deployment URL**, such as `https://quiet-otter-123.convex.cloud`. It
  says *where* your library is. It is not a secret.
- **The sync key**, a long random password you create once. It is what lets
  a computer read and change your library.

:::caution[Anyone with the sync key can read and change your library]
Keep it like a password. The key can only reach this deployment's library: it
cannot deploy code, change settings, or delete the deployment. Leaflogue
never asks for a Convex deploy key or your Convex account.
:::

## Before you start

You need [Node.js](https://nodejs.org/) 22.22.2 or later, `openssl`, and a
Convex account. Leaflogue must already be installed.

## 1. Deploy Leaflogue's backend

Open the [GitHub release](https://github.com/Ka1Thakkar/leaflogue/releases)
whose version **exactly matches** your Leaflogue. Download these three files
into one empty folder:

- `Leaflogue-Convex-VERSION.tar.gz`
- `Leaflogue-Convex-VERSION.manifest.json`
- `SHA256SUMS-convex.txt`

In a terminal in that folder, replacing `VERSION` with the release number
(without the leading `v`):

```sh
sha256sum --check SHA256SUMS-convex.txt
tar -xzf Leaflogue-Convex-VERSION.tar.gz
./leaflogue-convex-VERSION/deploy.sh
```

The checksum command should print `OK` for each file. `deploy.sh` then
installs the exact Convex tools this release was tested with, asks you to log
in to Convex, lets you create or choose a project, and deploys to that
project's **development deployment**, which is fine for personal use. At the
end it prints your deployment URL. Keep the extracted folder: the next steps
run inside it.

:::tip[Production deployments]
To use the project's production deployment instead, run
`./leaflogue-convex-VERSION/deploy.sh --production`, and add `--prod` to the
`npx convex env` commands below.
:::

## 2. Create the sync key

```sh
cd leaflogue-convex-VERSION
npx convex env set LEAFLOGUE_SYNC_KEY "$(openssl rand -base64 32)"
npx convex env get LEAFLOGUE_SYNC_KEY
```

The first command creates a random key and stores it on the deployment. The
second prints it so you can copy it. Keys shorter than 32 characters are
refused.

## 3. Connect Leaflogue

1. Open **Settings → Remote library** and choose **Convex**.
2. Paste the deployment URL (it is also on your Convex dashboard) and the sync
   key, then choose **Save connection**. The key is never shown again.
3. Choose **Check connection**. It confirms the deployment runs a Leaflogue
   version this computer supports.
4. Choose **Sync now**. The first sync creates your library on the deployment
   and uploads this computer's books, passages, and notes.

## Add another computer

On the other computer, repeat step 3 with the **same** URL and key, then
choose **Sync now**. It downloads the library. From then on, Leaflogue sends
and receives changes each time it opens and whenever you choose sync.

## Lose a computer, or change the key

Every computer shares one key, so to cut one off you replace the key. In the
extracted backend folder:

```sh
npx convex env set LEAFLOGUE_SYNC_KEY "$(openssl rand -base64 32)"
npx convex env get LEAFLOGUE_SYNC_KEY
```

The old key stops working at once. On each computer you keep, open
**Settings → Remote library**, leave the URL empty, paste the new key, and
choose **Save connection**. Changes made in the meantime wait on that computer
until then.

## Update after a new Leaflogue release

1. **Update Leaflogue on every computer first.**
2. Then download that release's Convex files, verify and extract them as in
   step 1, and run its `deploy.sh` again. Choose the existing project when
   asked. You do not need the sync key to deploy.

If you update the deployment first, older Leaflogue versions refuse to sync
with it until they are updated. If a computer is newer than the deployment, it
sends what the deployment can store, keeps the rest waiting, and says "Update
the Convex deployment…" in Settings; nothing is lost. **Check connection**
names the exact release and command when versions do not match.

## Troubleshooting

| Message | What to do |
| --- | --- |
| "Leaflogue could not reach the Convex deployment" | Check the URL and your network connection. |
| "…status function is unavailable" | The URL is not a Leaflogue deployment, or step 1 did not finish. Run `deploy.sh` again. |
| "No CONVEX_DEPLOYMENT set" (from `npx convex`) | Run the command from inside the extracted backend folder. If it still fails, run `npx convex dev --once` there and choose your existing project. |
| "This desktop supports Convex schema…" | Leaflogue and the deployment are different versions. Update whichever is older. |
| "Configure a sync provider, and a sync key for Convex…" | The deployment has no sync key (step 2), or this computer has none saved (step 3). |
| "The sync provider rejected the configured credentials" | The key on this computer does not match the deployment's. Paste the current key. |
| "Update the Convex deployment…" | This computer is newer than the deployment. Follow "Update after a new Leaflogue release". |


## Upgrading an existing deployment

The desktop app and Convex backend are separate installations. Installing a
new desktop automatically upgrades its local SQLite database and creates a
pre-upgrade backup. It does not deploy Convex code: that requires the deployment
owner’s Convex account or deploy key, which the app never stores.

If you use a backend hosted by someone else, update the desktop and ask its
administrator to upgrade the backend once for everyone. If you own your Convex
project, upgrade each desktop first, then upgrade that same project’s backend.
Do not create a replacement project, change the sync key, or reset your library.

1. In Settings → Remote library, check the installed backend schema/contract
   and the version this desktop needs. A newer backend may require a desktop
   update instead; do not downgrade it to satisfy an older app.
2. Download the matching release’s `Leaflogue-Convex-VERSION.tar.gz`,
   `Leaflogue-Convex-VERSION.manifest.json`, and `SHA256SUMS-convex.txt`.
   Replace `VERSION` below with the desktop release number without `v`.
3. Verify both downloaded files. On Linux run
   `sha256sum --check SHA256SUMS-convex.txt`; on macOS use
   `shasum -a 256 --check SHA256SUMS-convex.txt`.
4. Extract the archive:

   ```sh
   tar -xzf Leaflogue-Convex-VERSION.tar.gz
   ```

5. For a development deployment run
   `./leaflogue-convex-VERSION/deploy.sh` and choose your **existing** project.
   For production, identify the existing project with `CONVEX_DEPLOYMENT`
   (or use its production deploy key in your terminal), then run:

   ```sh
   CONVEX_DEPLOYMENT=prod:YOUR_PRODUCTION_DEPLOYMENT ./leaflogue-convex-VERSION/deploy.sh --production
   ```

   `YOUR_PRODUCTION_DEPLOYMENT` is the deployment name from its Convex URL, not
   a new project name. The CLI must be signed in to an account with access. If it is signed out,
   authenticate using the bundle’s pinned CLI first:

   ```sh
   cd leaflogue-convex-VERSION
   npm ci --ignore-scripts --no-audit --no-fund
   npx --no-install convex login
   cd ..
   ```

   Then run the production command above.
   The script installs this release’s pinned tools. With an account already
   signed in, the command updates the chosen existing production deployment.
6. Choose **Check connection**, then **Sync now** in Leaflogue. Repeat Sync now
   if a large library reaches a bounded migration/sync limit.

### During the transition

This desktop can sync ordinary library data with a contract-23 backend while
contract-24 highlight colours wait in a separate durable local queue. Text,
notes, tags and other supported changes continue sending and receiving.
The queue survives app restarts and SQLite backups. After upgrading the
backend, the next sync sends the retained colours with fresh revisions.

Settings displays the installed/required versions and explains which part needs
an update. Older incompatible contracts (including contract 22, which cannot
represent all current passage/thread data) may still pause sync to avoid losing
information. Unsent edits remain local; fixing versions does not require
re-importing your books.
