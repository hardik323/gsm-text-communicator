# How to start — geoPulse bot

## What this is

A Telegram bot that accepts a phone number and:

- saves the request to a local PostgreSQL database,
- publishes it over Redis so the background worker can pick it up,
- sends one SMS to the carrier's nodal number (through an Android phone
  running the SMS Gateway app) to ask the carrier for the number's location,
- listens for the carrier's reply and stores it, and
- shows the whole queue on a local web dashboard.

In plain language: you send it a mobile number, it tells the right carrier
"where is this phone?", waits for the answer, and writes it down. You do not
have to choose which short code to text or what format to use — it figures
that out from the number first.

It is **not** an API aggregator. The lookup goes through a real SIM on an
Android phone via [SMS Gateway for Android](https://sms-gate.app), so the
sender is the phone's own number and the reply comes back to that phone's SMS
inbox. The "who owns this number" part comes from
[API Express](https://apiexpress.in/apis/telecom-operator).

## Why it helps

You get a single place to:

- accept a lookup request from Telegram,
- see every request and its current status on the dashboard,
- know exactly which carrier to text and in which format,
- keep a record of every request, SMS sent, and reply received,
- time out stuck requests automatically so nothing hangs forever.

## What you need before you start

1. **A Telegram bot token** — get one from [@BotFather](https://t.me/BotFather)
   (`/newbot`). That is the only Telegram piece.
2. **An Android phone with the SIM in it**, with
   [SMS Gateway for Android](https://sms-gate.app) installed. The app shows
   its username and password on the Home tab — those go into `.env`.
3. **A pubic HTTPS URL** for the webhook so the SMS Gateway app can push
   incoming texts to this machine. That usually means a tunnel (for example
   Cloudflare Tunnel) ending at `http://127.0.0.1:3001`. Localhost is the
   only exception to the HTTPS requirement.
4. **An API Express key** — optional but recommended. Without it, no operator
   lookup happens and no SMS is sent. Get one at
   [apiexpress.in/signup](https://apiexpress.in/signup), then put the key in
   `.env` as `APIEXPRESS_API_KEY`. **Never paste the key into a chat, commit
   it, or print it anywhere.**
5. **A running Postgres and Redis**. Both are already in `.tools/` (portable
   copies), so there is no system install to do.

This machine has everything local: Postgres on `127.0.0.1:5432`,
Redis on `127.0.0.1:6379`. Nothing is exposed to the network.

## First run, step by step

### 1. Copy the environment file

```bash
cp .env.example .env
```

Then open `.env` and fill in at least `TELEGRAM_BOT_TOKEN`. Add the rest as
you have them:

| Variable | When you need it |
| :-- | :-- |
| `SMS_GATEWAY_USERNAME`, `SMS_GATEWAY_PASSWORD` | to send SMS and register the webhook |
| `SMS_GATEWAY_BASE_URL` | `https://api.sms-gate.app` for cloud mode, `http://<device_ip>:8080` for local |
| `WEBHOOK_URL` | the public HTTPS URL of this machine (tunnel) |
| `APIEXPRESS_API_KEY` | to look up the carrier for a number |
| `NODAL_NUMBER` | only as a fallback when no API key is set |

`.env` is git-ignored — never commit it.

### 2. Install dependencies

```bash
bun install
```

### 3. Start the local databases

From the project folder:

```bash
.tools/pgsql/bin/pg_ctl.exe -D .tools/pgdata -l .tools/pg.log start
.tools/redis/redis-server.exe --port 6379 --bind 127.0.0.1 --save "" --appendonly no
```

PostgreSQL starts as a background process; the second command (Redis) also
runs in the background. To stop them later:

```bash
.tools/pgsql/bin/pg_ctl.exe -D .tools/pgdata -m fast stop
.tools/redis/redis-cli.exe -p 6379 shutdown
```

Both were started in this session and are running now.

### 4. Apply the database schema

Prisma needs a `node` binary, and Node.js is not on this machine, so there is
a shim at `.tools/node` that forwards to Bun. Add it to `PATH` first:

```bash
export PATH="$PWD/.tools:$PATH"
bun x prisma migrate deploy
bun x prisma generate
```

This creates the `geopulse_official_bot` database and the `locationRequests`
and `Tsp` tables with the data already committed. The `Tsp` table's four
carriers (Airtel, JIO, Idea, BSNL) are seeded on startup by `programme.js`, so
you do not need to create them by hand — but if you ever want to correct one,
edit the row directly in the database; the bot never overwrites it.

### 5. Run the four pieces

You need **four terminal tabs** (or screens/tmux panes):

1. **The bot** — accepts `/location` commands.

   ```bash
   bun start
   ```

   It prints:

   ```
   Telegram bot is running.
   Waiting for /location {mobile number} · 3 wrong commands per 60s, then a 1 minute block.
   redis publisher connected to redis://127.0.0.1:6379
   redis subscriber connected to redis://127.0.0.1:6379
   ```

2. **The worker** — `programme.js` — consumes the Redis queue and does the
   operator lookup, SMS send, and reply handling.

   ```bash
   bun programmé.js
   ```

   It prints:

   ```
   redis publisher connected to redis://127.0.0.1:6379
   redis subscriber connected to redis://127.0.0.1:6379
   Listening on "LocationRequests" (created requests → operator lookup → SMS).
   redis messages-subscriber connected to redis://127.0.0.1:6379
   Listening on "MessagesReceived" (SMS replies → NodalResponse).
   Timing out requests with no location reply after 15 minute(s), checked every 30s.
   ```

3. **The webhook receiver** — `webhook.js` — receives texts from the SMS
   Gateway app and republishes them on the `MessagesReceived` channel.

   ```bash
   bun webhhook.js
   ```

   It prints:

   ```
   SMS webhook receiver on http://127.0.0.1:3001/webhook
   Point the SMS Gateway app (Settings → Webhooks) at this URL, or set WEBHOOK_URL in .env.
   ```

   If `WEBHOOK_URL` is set (and the gateway credentials are in `.env`), it
   also registers itself with the gateway on startup.

4. **The dashboard** — `dashboard.js` — the web view of all requests.

   ```bash
   bun dashboard
   ```

   Then open **http://127.0.0.1:3000** in your browser.

### 6. Test the whole thing from Telegram

1. Open the bot (@geopulse_official_bot with the token you added, or whatever
   @BotFather gave you) and send:

   ```
   /location 9876543210
   ```

2. You get back:

   ```
   ✅ Command accepted

   Please wait a few minutes while we process the location of 9876543210.
   The result will arrive in this chat automatically, so there is no need to
   send it again.
   ```

3. The bot saves the row as `CREATED` (status 1), publishes it to Redis, and
   does not tell you anything else until work is done.

4. Watch the dashboard. The row moves through the statuses as the worker
   processes it:

   - `2` — operator lookup started
   - `3` — operator found, stored in `TSP`
   - `5` — lookup SMS sent
   - `6` — reply received
   - `7` — no reply in 15 minutes (timeout)
   - `8` — the operator lookup never answered (overall failed)

### 7. Send the lookup SMS and register the webhook (the phone side)

1. On the Android phone, in **SMS Gateway for Android**, note the username
   and password on the Home tab and put them in `.env`.

2. With `WEBHOOK_URL` set in `.env` (the tunnel URL, e.g.
   `https://example.com`), start the webhook receiver — it registers itself
   automatically. Or, by hand:

   - In the app: Settings → Webhooks → add
     `https://…/webhook` for the `sms:received` event, **or**
   - By curl:

     ```bash
     curl -X POST -u "$SMS_GATEWAY_USERNAME:$SMS_GATEWAY_PASSWORD" \
       -H 'Content-Type: application/json' \
       -d '{ "url": "https://example.com/webhook", "event": "sms:received" }' \
       https://api.sms-gate.app/3rdparty/v1/webhooks
     ```

3. The phone's SIM is the SMS **sender** — you never set a sender in `.env`.
   The **receiver** (the nodal service number) comes from the `Tsp` table once
   the operator is known, or from `NODAL_NUMBER` as a fallback when no API key
   is configured.

4. `SMS_GATEWAY_BASE_URL`:
   - `https://api.sms-gate.app` — cloud mode (the gateway talks to the cloud API)
   - `http://<device_ip>:8080` — local mode (this machine can reach the phone on
     the same network)

5. With the gateway credentials and `WEBHOOK_URL` in `.env`, when you now
   send `/location 9876543210`, `programme.js` looks up the operator, sends the
   lookup SMS to the carrier's nodal number, marks status `5`, and waits for the
   reply on the phone.

6. When the carrier replies by SMS, the gateway app pushes it to `/webhook`,
   `webhook.js` normalises it and publishes it on `MessagesReceived`, and
   `programme.js` stores the reply and moves the row to `6`.

## Making sure it is running right

- Send `/location 9876543210` and confirm the row appears in the dashboard
  within a second or two. If it does not, check:
  - `bun start` is running and printed the listening line,
  - `programme.js` is running and printed both "Listening on" lines,
  - Redis is running (`.tools/redis/redis-cli.exe -p 6379 ping` should return
    `PONG`),
  - Postgres is running (`.tools/pgsql/bin/pg_ctl.exe -D .tools/pgdata status`).

- Without an API key, `programme.js` logs *"no SMS: gateway not configured"*
  and the row stays at status 2 (until the timeout sweep closes it as `8`).
  That is expected — it is protecting against sending to the wrong carrier.

- Without the gateway credentials, `programme.js` logs *"SMS gateway is not
  configured"* and the row stays where it was. Also expected.

## What counts as "done"

The whole flow, from command to stored reply, looks like this:

```
/location 9876543210
  → save row (status 1)
  → publish LocationRequests
  → programme.js: status 2 (operator lookup)
  → programme.js: status 3 (operator found, TSP filled)
  → programme.js: status 5 (SMS sent)
  → carrier replies by SMS
  → SMS Gateway app → /webhook
  → webhook.js → publish MessagesReceived
  → programme.js: status 6 (reply recorded)
```

The result lands in the dashboard and in `locationRequests.NodalResponse` in the
database. You read it from there, or from the browser at
http://127.0.0.1:3000.

## For a second look

- For the full technical picture (schema, channels, timeouts, test suite, known
  gaps), see [README.md](README.md).
- For every environment variable and its default, see `.env.example` — that is
  the canonical reference.
- For the operator lookup and the carrier formats (which short code and which
  message format each carrier uses), see `src/sms/operators/`.
