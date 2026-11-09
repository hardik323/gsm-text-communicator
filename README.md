# geoPulse bot

A Telegram bot that accepts a phone number, records the request and announces it
for processing.

```
 Telegram                    Postgres                    Redis              Android phone
 ────────                    ────────                    ─────              ────────────
 /location 9876543210  ──►  locationRequests  ──►  PUBLISH "LocationRequests"     ┌─ SMS Gateway (SIM)
                                  (status 1)                   │                    │  programme.js
        ▲                                                    ▼                    │  sends "91{number}"
        └──────────── acknowledgement ────────────►  consumer (programme.js) ──► │──── out
                                                                                    │
                                                                                    └─── in (webhook) ──►
                                                              PUBLISH "MessagesReceived" ──► programme.js
```

**Current scope:** the Telegram side, persistence, the queue, the SMS
Gateway lookup and a live web dashboard are done. The reply's business
meaning (what the nodal answers) is still to be interpreted.

---

## Requirements

| Tool | Version used | Notes |
| :-- | :-- | :-- |
| Bun | 1.4.x | Runs everything; Node.js is **not** installed on this machine |
| PostgreSQL | 17.6 | Portable copy in `.tools/pgsql` |
| Redis | 5.0.14.1 | Portable Windows build in `.tools/redis` |

Everything is local: Postgres listens on `127.0.0.1:5432`, Redis on
`127.0.0.1:6379`. Neither is exposed to the network.

---

## Quick start

```bash
# 1. environment
cp .env.example .env          # then fill in TELEGRAM_BOT_TOKEN

# 2. dependencies (already installed in this workspace)
bun install

# 3. databases
.tools/pgsql/bin/pg_ctl.exe -D .tools/pgdata -l .tools/pg.log start
.tools/redis/redis-server.exe --port 6379 --bind 127.0.0.1 --save "" --appendonly no &

# 4. schema
bun x prisma migrate deploy
bun x prisma generate

# 5. run
bun start                     # the bot
bun programme.js              # the consumer, in a second terminal
bun dashboard                 # the web dashboard, in a third terminal
```

Then open **http://127.0.0.1:3000** for the dashboard (see below).

`bun start` prints:

```
Telegram bot is running.
Waiting for /location {mobile number} · 3 wrong commands per 60s, then a 1 minute block.
redis publisher connected to redis://127.0.0.1:6379
redis subscriber connected to redis://127.0.0.1:6379
```

> **Prisma needs a `node` binary.** Node.js is absent here, so `.tools/node` is a
> shim that forwards to Bun. Add it to `PATH` before any `prisma` command:
> `export PATH="$PWD/.tools:$PATH"`.

---

## Configuration

All of it lives in `.env`; `.env.example` is the reference.

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather. Required |
| `MAX_WRONG` | `3` | Wrong commands tolerated inside the window |
| `WRONG_WINDOW_SECONDS` | `60` | Length of the sliding window |
| `BLOCK_SECONDS` | `60` | How long a spammer is ignored |
| `MIN_DIGITS` | `7` | Shortest accepted number |
| `MAX_DIGITS` | `15` | Longest accepted number (E.164) |
| `DATABASE_URL` | local Postgres | Prisma connection string |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection |
| `REDIS_CHANNEL` | `LocationRequests` | Pub/sub channel name |
| `DASHBOARD_HOST` | `127.0.0.1` | Dashboard bind address — loopback only, it has no auth |
| `DASHBOARD_PORT` | `3000` | Dashboard port |
| `SMS_GATEWAY_USERNAME` | — | Gateway account username (app Home tab). Required for sending |
| `SMS_GATEWAY_PASSWORD` | — | Gateway account password. Required for sending |
| `SMS_GATEWAY_BASE_URL` | `https://api.sms-gate.app` | Cloud API; local: `http://<device_ip>:8080` |
| `NODAL_NUMBER` | — | Fallback receiver of the lookup SMS, only used when the operator is unknown |
| `SMS_SIM_NUMBER` | — | 1-based SIM slot (1..3) for dual-SIM phones; empty = default |
| `SMS_DEVICE_ID` | — | Gateway device id; empty = the gateway picks any linked device |
| `SMS_SKIP_PHONE_VALIDATION` | `true` | Nodal numbers are service codes, not E.164 numbers |
| `WEBHOOK_HOST` | `127.0.0.1` | Webhook receiver bind address |
| `WEBHOOK_PORT` | `3001` | Webhook receiver port |
| `WEBHOOK_URL` | — | Public HTTPS URL of the receiver; when set, `bun webhook` registers it |
| `REDIS_MESSAGE_CHANNEL` | `MessagesReceived` | Channel that received texts are published on |
| `APIEXPRESS_API_KEY` | — | Bearer key for the telecom operator API (`/apis/telecom-operator`) |
| `APIEXPRESS_URL` | `https://api.apiexpress.in/v1/telecom/operator` | Operator lookup endpoint |
| `APIEXPRESS_TIMEOUT_MS` | `8000` | How long to wait for the operator answer |
| `NODAL_RESPONSE_TIMEOUT_MINUTES` | `15` | How long a request may wait for a location reply |
| `NODAL_SWEEP_MS` | `30000` | How often the timeout sweep runs |

Invalid numbers fall back to the default with a warning rather than crashing.
`.env` is git-ignored — never commit it.

---

## Project structure

```
dashboard.js                    entry: the web dashboard
bot.js                          entry: the Telegram bot
programme.js                    entry: the consumer (SMS out + replies in)
webhook.js                      entry: the SMS webhook receiver
src/dashboard/
  server.js                     Express app, SSE stream, DB polling
  public/index.html             the page (no build step)
src/
  config.js                     every env var, read once
  constants/
    status.js                   status enum + parseStatus/isStatus
    messages.js                 all chat wording
  telegram/
    client.js                   bot instance + send helper
    command.js                  /location parsing
    handler.js                  validate → save → ack → publish
  security/
    spamGuard.js                wrong-command counting and blocks
  db/
    prisma.js                   one PrismaClient
    locationRequests.js         saveRequest(), findOpenRequest(), recordNodalResponse()
  sms/
    gateway.js                  SMS Gateway client: buildSmsBody, sendSms, webhooks
    telecomOperator.js          API Express operator lookup + provider matching
    providers.js                the four carriers and their message templates
  webhooks/
    server.js                   Express receiver: gateway callbacks → MessagesReceived
  queue/
    redis.js                    connection factory
    locationRequests.js         channel, publish, created-only subscribe
    messagesReceived.js         channel, publish, subscribe
prisma/
  schema.prisma                 model
  migrations/                   0001_init … 0006_tsp_formats
test/                           107 tests, one file per module
```

Dependencies point one way: entries → feature modules → `config` / `constants`.
No module imports an entry point.

---

## Message behaviour

| Input | Response |
| :-- | :-- |
| `/location 9876543210` | ✅ Command accepted — "wait a few minutes while we process the location of …" |
| Same number again while it's still open | ⏳ Already in progress — "no need to send it again" |
| Anything else | 🚫 Wrong command + the exact syntax and an example |
| More than `MAX_WRONG` wrong in the window | ⛔ One "blocked" notice, then total silence until the block expires |

Accepted number formats: `9876543210`, `+91 98765-43210`, `(98765) 432.10`,
`/location@your_bot 9876543210`.

The order is deliberate: **validate → save → acknowledge → publish**. A user is
never told "processing" unless the row exists.

---

## Request lifecycle

`Status` is an integer so it stays compact in the database and the payload.
Never renumber these; add new ones at the end.

| Code | Name | Meaning |
| :-- | :-- | :-- |
| 1 | `CREATED` | Accepted from Telegram, row written |
| 2 | `TSP_REQUESTED` | Operator lookup for `QueryNumber` is in flight |
| 3 | `TSP_FOUND` | Operator known; stored in `TSP` |
| 4 | `TSP_NOT_FOUND` | Operator could not be located |
| 5 | `LOCATION_REQUESTED` | Lookup SMS sent, waiting for the reply |
| 6 | `NODAL_RESPONSE_FOUND` | Location reply received and stored |
| 7 | `NODAL_RESPONSE_TIMEOUT` | SMS went out but no reply within the timeout (15 min) |
| 8 | `FAILED` | Overall failed — the operator lookup never returned, so nothing was sent |

```
1 CREATED ─► 2 TSP_REQUESTED ─► 3 TSP_FOUND ─► 5 LOCATION_REQUESTED ─► 6 NODAL_RESPONSE_FOUND
       │                                     │
       └── operator API never answers ───────┴──► 8 FAILED        5, no reply in 15 min ─► 7 NODAL_RESPONSE_TIMEOUT
```

`1` is written by the bot; `programme.js` walks the row through the rest.

---

## SMS flow

The lookup goes through a physical SIM, not an aggregator: the
[SMS Gateway for Android](https://sms-gate.app) app (free, open-source) turns
an Android phone into an SMS sender. But *which* nodal number to text, and in
which format, depends on who owns the number — that comes from the
[API Express telecom operator API](https://apiexpress.in/apis/telecom-operator).

```
 bot    Redis               programme.js                Gateway phone (SIM)        nodal number
 ───    ─────               ────────────                ───────────────────        ───────────
 save ─► LocationRequests ─► 2 TSP_REQUESTED
                             │  POST api.apiexpress.in/v1/telecom/operator {mobile}
                             │  {operator: "Airtel", circle: "Maharashtra"}
                             │  ─► 3 TSP_FOUND, TSP = "Airtel"
                             │  findProvider(providers, "Airtel") → Tsp row
                             └► sendSms() ─────────────► text "91{number}" ──► <SMS>
                                  5 LOCATION_REQUESTED

 reply ◄── <SMS> ── webhook ──► PUBLISH "MessagesReceived" ──► programme.js
                                      ├─► number echoed → 6 NODAL_RESPONSE_FOUND
                                      └─► no reply in 15 min → 7 NODAL_RESPONSE_TIMEOUT
```

**Step 1 — find the operator.** `programme.js` marks the row `2`
(`TSP_REQUESTED`) and calls `detectOperator(QueryNumber)`
(`src/sms/telecomOperator.js`), which posts `{ mobile: "9876543210" }` to
`APIEXPRESS_URL` with `Authorization: Bearer APIEXPRESS_API_KEY`. The answer
is stored in `locationRequests.TSP` with status `3` (`TSP_FOUND`).

API names are normalised onto the rows we have (`providerForOperator`): `Jio`
→ `JIO`, `Vi (Vodafone Idea)` → `Idea`, `BSNL` → `BSNL`, `Airtel` → `Airtel`.

If the call fails or the API does not know the number, **no SMS is sent**:
the row stays at `2` and the timeout sweep closes it. Guessing a recipient
would defeat the point of asking.

**Step 2 — send one SMS to that carrier's nodal number.** `findProvider()`
returns the matching row from the `Tsp` table; `buildProviderMessage()`
renders its `RequestFormat`, so Airtel/JIO get `919876543210`, Idea gets
`CELL 919876543210` and BSNL gets `Getloc 91****`. `sendSms` then posts
`POST /3rdparty/v1/messages` to the gateway API:

- **Sender** — the phone's own SIM number; the API has no sender field.
- **Receiver** — the row's `NodalNumber` from the `Tsp` table.
- **SIM** — `SMS_SIM_NUMBER` picks the slot (1..3) on dual-SIM phones;
  empty uses the gateway's default.
- **Auth** — Basic with the gateway username/password from the app's Home
  tab (`SMS_GATEWAY_USERNAME`, `SMS_GATEWAY_PASSWORD`).
- `SMS_SKIP_PHONE_VALIDATION=true` by default, because a nodal receiver is a
  service code, not an E.164 number, and the API would reject it.

Only after a successful send is the row moved to `5` (`LOCATION_REQUESTED`,
`LastStatusChangeDateTime` stamped). If the gateway is down, slow or
unconfigured, the row stays where it was and the failure is logged.

**Fallback.** `NODAL_NUMBER` is still honoured, but only when the operator
lookup was never attempted at all (no `APIEXPRESS_API_KEY` set): the message
goes out in the plain `91{query_number}` form to that number.

**Timeouts.** A sweeper runs every `NODAL_SWEEP_MS` and closes any request
that has stopped moving (both clocks key off `LastStatusChangeDateTime`,
stamped on every status change, so "how long in this state?" is exact):

| Stuck in | For | Becomes |
| :-- | :-- | :-- |
| `5` LOCATION_REQUESTED | more than `NODAL_RESPONSE_TIMEOUT_MINUTES` (15) | `7` NODAL_RESPONSE_TIMEOUT |
| `2` TSP_REQUESTED | more than one sweep interval | `8` FAILED |

The `2` case is the overall failure: the user asked, and programme never got
an answer back, so no SMS was ever sent on their behalf. It must be short
(`NODAL_SWEEP_MS` = 30s), because the API answers in under a second; a longer
wait would only leave the user hanging.

That is what stops a row sitting in progress for ever.

**Inbound — `bun webhook`.** The gateway app POSTs the raw envelope to this
process's `/webhook` route; the server normalises it and publishes the result
on the `MessagesReceived` Redis channel. `programme.js` subscribes to that
channel and, for every text:

1. prints the sender and body;
2. extracts the numbers the reply echoes (`extractNumberCandidates`);
3. attaches the reply as `NodalResponse` and moves the matched open request
   to `6` (`NODAL_RESPONSE_FOUND`) — newest open request whose stored number
   ends with the same 10 digits.

A reply that matches no open request is logged and otherwise ignored.

**Wiring the phone up**

1. Install the SMS Gateway app on an Android phone with the SIM in it, and
   note the username/password on the Home tab → put them in `.env`.
2. Start `bun webhook`. The gateway needs a **public HTTPS** URL to reach
   it (localhost is the only HTTP exception), so either:
   - point it at a tunnel to this machine (e.g. a Cloudflare Tunnel) and put
     that URL in `WEBHOOK_URL` — `bun webhook` registers it on startup; or
   - register it by hand in the app: Settings → Webhooks → add
     `https://…/webhook` for the `sms:received` event.
3. `SMS_GATEWAY_BASE_URL` is `https://api.sms-gate.app` for cloud mode, or
   `http://<device_ip>:8080` for local mode (phone and this process on the
   same network).

Registering by API, if you prefer:

```bash
curl -X POST -u "$SMS_GATEWAY_USERNAME:$SMS_GATEWAY_PASSWORD" \
  -H 'Content-Type: application/json' \
  -d '{ "url": "https://example.com/webhook", "event": "sms:received" }' \
  https://api.sms-gate.app/3rdparty/v1/webhooks
```

---

## Database

Database `geopulse_official_bot`.

### `locationRequests`

| Column | Type | Notes |
| :-- | :-- | :-- |
| `Id` | `uuid` | Primary key, generated |
| `UserId` | `bigint` | Telegram user id — exceeds `int` range |
| `ChatId` | `bigint` | Telegram chat id — negative for groups |
| `QueryNumber` | `varchar(16)` | Normalised number |
| `TSP` | `varchar(100)` | Operator the API found, filled by `programme.js` |
| `NodalResponse` | `text` | Raw reply, filled later |
| `Status` | `integer` | Defaults to 1, `CHECK 1..8` |
| `CreatedDateTime` | `timestamptz(3)` | Defaults to now |
| `LastStatusChangeDateTime` | `timestamptz(3)` | Defaults to now |

Indexes: `(ChatId, CreatedDateTime)`, `(UserId, CreatedDateTime)`,
`(QueryNumber)`, `(Status, CreatedDateTime)`.

Constraints: `CHECK ("Status" BETWEEN 1 AND 8)` and
`CHECK (length(btrim("QueryNumber")) > 0)` — `NOT NULL` alone allows `''`.

Managing migrations (needs the `node` shim on `PATH`):

```bash
bun x prisma migrate status                 # is the database behind?
bun x prisma migrate deploy                 # apply committed migrations
bun x prisma migrate dev --name <change>    # after editing schema.prisma
bun x prisma generate                       # refresh the client
```

### `Tsp` — telecom service providers

One row per carrier the gateway phone can query:

| Column | Type | Notes |
| :-- | :-- | :-- |
| `Id` | `uuid` | Primary key, generated |
| `Provider` | `varchar(50)` | Unique: Airtel, JIO, Idea, BSNL |
| `NodalNumber` | `varchar(32)` | Short code the lookup SMS goes to, e.g. `070212 65165` |
| `RequestFormat` | `varchar(64)` | Message template; defaults to `91{query_number}` |
| `IsActive` | `boolean` | Retire a provider without deleting the row |
| `CreatedDateTime` | `timestamptz(3)` | Defaults to now |
| `LastStatusChangeDateTime` | `timestamptz(3)` | Defaults to now |

Seeded from `DEFAULT_PROVIDERS` in `src/sms/providers.js` by `programme.js` on
startup (`ensureProviders`): missing rows are inserted, existing ones —
including operator edits — are never overwritten, so an operator can correct a
nodal number or deactivate a provider directly in the table.

The `RequestFormat` is a column, not a constant, because each carrier has its
own template: Airtel and JIO use `91{query_number}`, Idea uses
`CELL 91{query_number}` and BSNL uses `Getloc 91****` (which masks the
number, so `buildProviderMessage` leaves it exactly as written).

---

## Redis channel

Channel `REDIS_CHANNEL` (default `LocationRequests`). One message per accepted
request, published after the row is committed:

```json
{
  "Id": "caf184bd-0439-42c1-a0f6-384810661f2a",
  "UserId": "8248190184",
  "ChatId": "-1001234567890",
  "QueryNumber": "+919876543210",
  "Status": 1,
  "CreatedDateTime": "2026-11-08T21:53:16.837Z"
}
```

`UserId` and `ChatId` are strings because they are `BIGINT` — `JSON.stringify`
throws on BigInt and JS numbers lose precision past 2^53.

`subscribe()` only hands over messages whose `Status` is `1`; anything else, and
any message that is not JSON, is logged and ignored. Run `bun programme.js` to
watch the channel live.

> **Not durable.** Redis pub/sub drops messages published while nobody is
> subscribed. The database row is the durable record, so a consumer that starts
> late must also scan for `Status = 1`. Redis Streams would fix this if needed.

---

## Dashboard

```bash
bun dashboard          # then open http://127.0.0.1:3000
```

A read-only page over the same table: four stat cards (Total, Open, Located,
Failed), one filter chip per status with its count, a search box, and the
request list newest-first with coloured status badges.

**How realtime works.** The browser holds a Server-Sent Events stream. The
server re-reads the database and broadcasts a full snapshot when either:

- a Redis message arrives on `LocationRequests` (instant — new requests), or
- a 3-second poll notices a change (covers status updates by workers that
  never touch Redis).

A fingerprint of the data suppresses broadcasts when nothing changed.

| Endpoint | Returns |
| :-- | :-- |
| `GET /` | the page |
| `GET /api/snapshot` | `{ total, counts, requests }` as JSON |
| `GET /api/stream` | the SSE stream (`snapshot` then `update` events) |

Timestamps are stored as `timestamptz` (UTC) in the database and shown in the
browser's local timezone, so the page reads correctly on any machine.

It binds to `127.0.0.1` and has **no authentication** — it is a local tool.
Do not expose the port; put it behind your own auth if you ever need that.

---

## Tests

```bash
bun test test/          # or: bun test
```

107 tests in 14 files, all passing. Unit tests cover the status enum, command
parsing, message wording, the spam guard, the SMS gateway client, the operator
API client and the full `programme.js` flow (all with mocked dependencies).
Integration files exercise real Redis, Postgres, the full message handler and
the webhook receiver, and **skip with a warning** (within 2–3 s) when those
services are not running.

Integration tests create their own rows and delete them afterwards.

---

## Local services

Both are portable copies, not Windows services — they do not start on boot and
do not survive a machine restart.

```bash
# PostgreSQL
.tools/pgsql/bin/pg_ctl.exe -D .tools/pgdata -l .tools/pg.log start
.tools/pgsql/bin/pg_ctl.exe -D .tools/pgdata -m fast stop

# Redis
.tools/redis/redis-server.exe --port 6379 --bind 127.0.0.1 --save "" --appendonly no
.tools/redis/redis-cli.exe -p 6379 ping
```

Credentials for local development: user `postgres`, password `postgres`
(see `DATABASE_URL`).`.tools/` is git-ignored — it holds the Postgres and Redis
  binaries (hundreds of megabytes) plus the database files. `.tools/pg.zip` and
  `.tools/redis.zip` are only downloads and can be deleted.

Connecting a GUI: expand `Databases → geopulse_official_bot → Schemas → public →
Tables` and refresh. The table name is mixed case, so SQL needs quotes:
`select * from public."locationRequests";`

---

## Security

- `.env`, `New Text Document.txt` and `.tools/` are git-ignored.
- The bot token was pasted into a chat once and should be treated as leaked —
  revoke it with @BotFather (`/revoke`) and put the new one in `.env`.
- Query numbers belong to third parties who never consented to being looked up.
  Plan a retention window for `locationRequests`.
- Local Postgres/Redis listen on loopback only; keep it that way unless you add
  authentication and TLS.

---

## Known gaps

| Gap | Effect |
| :-- | :-- |
| No API key | Without `APIEXPRESS_API_KEY` no operator lookup happens and no SMS is sent |
| Pub/sub is fire-and-forget | A consumer that is down misses the message (the row remains) |
| No retry after a timeout | A request that times out at 7 is not re-sent; use `Status = 1` and re-publish |
| No rate limit on valid commands | Only wrong commands are throttled |
| Services are session-bound | They stop when the machine or session ends |
