---
title: Host the web app with PostgreSQL
description: Run Leaflogue's web app in one container beside your PostgreSQL database.
---

The web app and its small server run together in one container. The
repository includes a ready-made setup with its own PostgreSQL; you can also
point it at a database you already run.

## Before you start

You need a server with [Docker](https://docs.docker.com/get-docker/), a web
address for the app (such as `https://reading.example.com`) with HTTPS in
front of it, and a Google account to create a sign-in client.

## 1. Create a Google sign-in client

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client ID** of type **Web application**.
2. Add `https://reading.example.com/auth/callback` (with your address) as an
   **authorized redirect URI**.
3. Keep the client ID and client secret for the next step.

## 2. Configure and start it

```sh
git clone https://github.com/Ka1Thakkar/leaflogue.git
cd leaflogue/deploy/web
cp .env.example .env
```

Fill in `.env`:

- `LEAFLOGUE_PUBLIC_URL`: the address readers open.
- `LEAFLOGUE_OIDC_CLIENT_ID` and `LEAFLOGUE_OIDC_CLIENT_SECRET`: from step 1.
- `AUTH_ALLOWED_EMAILS`: the emails that may sign in, separated by commas.
- `POSTGRES_PASSWORD`: a long random password, for example from
  `openssl rand -base64 32`.
- Optionally `GEMINI_API_KEY`, to offer the AI. See
  [Explain a passage with AI](/ai/gemini/) for getting a free key.

Then start it:

```sh
docker compose up -d
```

It listens on port 8787 on this server only. Point your HTTPS proxy (such as
Caddy or nginx) at it for your address, then open the address and sign in.

## Use a database you already run

To serve the library your computers already sync with, remove the `db`
service from `compose.yaml` and set `DATABASE_URL` in `.env` to that database's
connection URL, the same one you gave Leaflogue in
[Sync with PostgreSQL](/sync/postgresql/). The web app brings the database up
to date when it starts.

## Updating

```sh
git pull
docker compose up -d --build
```

Update your computers' Leaflogue too, so they understand anything the newer
web app writes.
