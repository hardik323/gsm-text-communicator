# geoPulse bot

A Telegram bot that accepts a phone number, records the request and announces it
for processing.

```
 Telegram                    Postgres                    Redis
 ────────                    ────────                    ─────
 /location 9876543210  ──►  locationRequests  ──►  PUBLISH "LocationRequests"
                                  (status 1)              │
        ▲                                                 ▼
        └──────────── acknowledgement ────────────  consumer (programme.js)
```

**Current scope:** the Telegram side, persistence, the queue and the consumer
skeleton are done. Nothing looks up the number's location yet — that is the next
stage.

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
```

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

Invalid numbers fall back to the default with a warning rather than crashing.
`.env` is git-ignored — never commit it.

---

## Project structure

```
bot.js                          entry: the Telegram bot
programme.js                    entry: the queue consumer
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
    locationRequests.js         saveRequest()
  queue/
    redis.js                    connection factory
    locationRequests.js         channel, publish, created-only subscribe
prisma/
  schema.prisma                 model
  migrations/                   0001_init, 0002_query_number_not_empty
test/                           40 tests, one file per module
```

Dependencies point one way: entries → feature modules → `config` / `constants`.
No module imports an entry point.

---

## Message behaviour

| Input | Response |
| :-- | :-- |
| `/location 9876543210` | ✅ Command accepted — "wait a few minutes while we process the location of …" |
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
| 2 | `TSP_REQUESTED` | Handed to the TSP / carrier |
| 3 | `TSP_FOUND` | Carrier located |
| 4 | `TSP_NOT_FOUND` | Carrier could not be located |
| 5 | `LOCATION_REQUESTED` | Location lookup started |
| 6 | `NODAL_RESPONSE_FOUND` | Nodal reply received |
| 7 | `NODAL_RESPONSE_TIMEOUT` | Nodal reply never arrived |

Only `1` is produced today.

---

## Database

Database `geopulse_official_bot`, table `locationRequests`:

| Column | Type | Notes |
| :-- | :-- | :-- |
| `Id` | `uuid` | Primary key, generated |
| `UserId` | `bigint` | Telegram user id — exceeds `int` range |
| `ChatId` | `bigint` | Telegram chat id — negative for groups |
| `QueryNumber` | `varchar(16)` | Normalised number |
| `TSP` | `varchar(100)` | Carrier, filled later |
| `NodalResponse` | `text` | Raw reply, filled later |
| `Status` | `integer` | Defaults to 1, `CHECK 1..7` |
| `CreatedDateTime` | `timestamptz(3)` | Defaults to now |
| `LastStatusChangeDateTime` | `timestamptz(3)` | Defaults to now |

Indexes: `(ChatId, CreatedDateTime)`, `(UserId, CreatedDateTime)`,
`(QueryNumber)`, `(Status, CreatedDateTime)`.

Constraints: `CHECK ("Status" BETWEEN 1 AND 7)` and
`CHECK (length(btrim("QueryNumber")) > 0)` — `NOT NULL` alone allows `''`.

Managing migrations (needs the `node` shim on `PATH`):

```bash
bun x prisma migrate status                 # is the database behind?
bun x prisma migrate deploy                 # apply committed migrations
bun x prisma migrate dev --name <change>    # after editing schema.prisma
bun x prisma generate                       # refresh the client
```

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

## Tests

```bash
bun test test/          # or: bun test
```

40 tests in 6 files, all passing. Unit tests cover the status enum, command
parsing, message wording and the spam guard. Two integration files exercise real
Redis and Postgres, and **skip with a warning** (within 2–3 s) when those
services are not running, so the unit suite stays useful on its own.

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
| No location worker | Requests stop at status 1; nothing advances them |
| Pub/sub is fire-and-forget | A consumer that is down misses the message (the row remains) |
| No duplicate protection | The same user can queue the same number repeatedly |
| No rate limit on valid commands | Only wrong commands are throttled |
| `express` is an unused dependency | From the original skeleton; safe to remove |
| Services are session-bound | They stop when the machine or session ends |
