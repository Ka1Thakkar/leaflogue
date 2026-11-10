---
title: Host the web app with Convex
description: Put Leaflogue's web app on any static web host, signing in through your Convex deployment.
---

With Convex, the web app is a folder of static files you can put on any web
host, and your Convex deployment does the rest. Set up
[Sync with Convex](/sync/convex/) first; the steps below run in the same
`leaflogue-convex-VERSION` folder.

## 1. Create a Google sign-in client

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client ID** of type **Web application**.
2. Add `https://YOUR-DEPLOYMENT.convex.site/api/auth/callback/google` as an
   **authorized redirect URI**. It is your deployment URL with `.convex.site`
   instead of `.convex.cloud`.

## 2. Turn on sign-in on your deployment

```sh
cd leaflogue-convex-VERSION
node sign-in-keys.mjs
npx convex env set AUTH_GOOGLE_ID "your client ID"
npx convex env set AUTH_GOOGLE_SECRET "your client secret"
npx convex env set AUTH_ALLOWED_EMAILS "you@example.com"
npx convex env set SITE_URL "https://reading.example.com"
```

The first command creates the keys your deployment signs readers in with and
stores them there; it never shows them. (Running it again replaces them and
signs everyone out.) For a production deployment, add `--prod` to every
command here.
`AUTH_ALLOWED_EMAILS` lists who may sign in, separated by commas; with it
unset, nobody can. `SITE_URL` is the address you will open the web app at.
To offer the AI, also set a provider key such as `GEMINI_API_KEY` (see
[Explain a passage with AI](/ai/gemini/)).

## 3. Build the web app

You need [Node.js](https://nodejs.org/) 22.22.2 or later.

```sh
git clone https://github.com/Ka1Thakkar/leaflogue.git
cd leaflogue
npm ci --ignore-scripts
npm run build --workspace @leaflogue/web
```

## 4. Put it online

Upload the `apps/web/dist` folder to any static host, such as Netlify,
Cloudflare Pages, or Vercel, at the address you set as `SITE_URL`. If your host
lets you set security headers, this policy fits the web app:

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://*.convex.cloud wss://*.convex.cloud; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'
```

Open the address. The first time, it asks for your deployment's address
(the one your computers sync with, such as
`https://quiet-otter-123.convex.cloud`) and remembers it in that browser. Then
sign in with an allowed Google account. To switch to another deployment later,
use **Use a different deployment** in Settings.

The files themselves name no deployment, so one copy can serve anyone who
points it at their own; each deployment's `SITE_URL` must be this address.
