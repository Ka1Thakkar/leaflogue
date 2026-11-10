---
title: Sync with PostgreSQL
description: Use a PostgreSQL database you run as Leaflogue's sync provider.
---

If you already run PostgreSQL, Leaflogue can sync through it. You need
**PostgreSQL 16 or newer**, a database and user for Leaflogue, and a
connection URL.

## The connection URL

```text
postgresql://leaflogue:PASSWORD@db.example.com:5432/leaflogue?sslmode=require
```

- For any server other than this computer, the URL must require TLS with
  `sslmode=require`, `verify-ca`, or `verify-full`. Leaflogue refuses a remote
  URL without it.
- A database on this computer (`localhost`) may connect without TLS.
- The URL contains a password, so treat it like one. Once saved, it is never
  shown in the interface again.

## Connect

1. Open **Settings → Remote library** and choose **PostgreSQL**.
2. Paste the connection URL and choose **Save connection**.
3. Choose **Check connection**. A new database reports that it has not been
   initialised for Leaflogue yet.
4. Choose **Initialize schema** and confirm. This creates Leaflogue's tables
   inside a `leaflogue` schema in that database and nowhere else. Running it
   again is safe.
5. Choose **Sync now**.

On each other computer, save the same URL and choose **Sync now**; there is
no need to initialise the schema again. From then on, Leaflogue syncs each
time it opens and whenever you choose sync.

## Updating

When a new Leaflogue release changes the database layout, **Check
connection** says so, and **Initialize schema** applies the update. Update
Leaflogue on every computer before you do.
