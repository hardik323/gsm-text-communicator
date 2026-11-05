# GSM Text Communicator

Telegram bot that forwards `/location {number}` queries over a real GSM SIM and
posts the SMS answer back into the chat that asked for it.

Project layout:

| Folder | Contents |
| --- | --- |
| `bot.js`, `lib/`, `config.js` | Telegram bot + HTTP gateway API (server side) |
| `android-gateway/` | Android app that turns a phone's SIM into the GSM modem |
| `test/` | Tests for the queue / reply / timeout logic |

The SIM lives in an old Android phone running **`android-gateway/`**: the bot
queues SMS, the phone polls for them, sends them through its SIM, and forwards
every incoming SMS back to the bot.

## Flow

```
Telegram user                bot.js                    Android phone (SIM)          destination device
     |                          |                              |                            |
     |-- /location 12345 ------>|                              |                            |
     |                          | queue SMS "/location 12345"  |                            |
     |<- "sent, waiting…" ------|                              |                            |
     |                          |<-- POST /gateway/outbox/claim |                            |
     |                          |--- { to, body } ------------>|                            |
     |                          |                              |--- SMS "/location 12345" ->|
     |                          |<-- POST /gateway/outbox/result                            |
     |                          |        status: "sent"        |                            |
     |                          |                              |<-- SMS "12345 is at …" ----|
     |                          |<-- POST /gateway/inbound ----|                            |
     |<- reply text ------------|  match pending request       |                            |
     |                          |  by number, then by age      |                            |
```

`GATEWAY_SIM_SENDER_NUMBER` is the SIM inside the phone; `GATEWAY_SIM_DESTINATION_NUMBER`
is the device that answers. Replies are only accepted from the destination
number.

## Choosing the SMS backend

`SMS_PROVIDER` decides how the bot sends and receives the SMS.

### `smsgate` — recommended, nothing to build

Uses the free, open-source [SMS Gateway for Android](https://sms-gate.app) app
(Apache-2.0; install the prebuilt APK from
[GitHub Releases](https://github.com/capcom6/android-sms-gateway/releases)) in
**Local Server** mode:

1. Install the APK on the phone holding the SIM (Android 5.0+) and grant
   `SEND_SMS`, `RECEIVE_SMS` and `READ_PHONE_STATE`.
2. On the Home tab switch **Local Server** on, then tap **Start Service**. A
   persistent notification stays visible while it runs.
3. From the bot machine open `http://<phone-ip>:8080/health` — that proves the
   LAN path works before the bot is involved.
4. Copy the local IP and the Basic-auth username/password shown in the *Local
   Server* section into `SMSGATE_URL`, `SMSGATE_USERNAME`, `SMSGATE_PASSWORD`.
5. Disable battery optimisation for the app (**Settings → System**) and keep the
   phone on a charger, or Android will kill the server.

Only the phone's port needs to be reachable, and only from your LAN; the bot
machine needs no inbound port in this mode.

The bot sends with `POST /messages`
(`{ "textMessage": { "text": "/location 12345" }, "phoneNumbers": ["<destination>"] }`,
Basic auth) and then reads `GET /inbox?type=SMS&limit=50` every
`SMSGATE_POLL_SECONDS`, forwarding anything sent by
`GATEWAY_SIM_DESTINATION_NUMBER`. The inbox API exists only in Local Server
mode; the cloud mode of the app delivers incoming SMS through webhooks instead.

The inbox returns `contentPreview`, which the app may shorten for very long SMS.
Replies are expected to be one or two SMS parts.

### `local` — the bundled app in `android-gateway/`

Here the phone polls the bot, so the bot can run anywhere (even behind NAT) and
the phone just needs outbound internet. Requires building the app; see
[Android gateway app](#android-gateway-app-android-gateway) below.

## Bot setup

1. `cp .env.example .env` and fill in:
   - `TELEGRAM_BOT_TOKEN` — from @BotFather
   - `GATEWAY_SIM_SENDER_NUMBER` — the phone's own number
   - `GATEWAY_SIM_DESTINATION_NUMBER` — the device that answers location queries
   - `GATEWAY_TOKEN` — shared secret for the phone, e.g.
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - optional: `RESPONSE_TIMEOUT_MINUTES` (default 5), `GATEWAY_PORT` (default 8080),
     `CLAIM_LEASE_SECONDS` (60), `SEND_MAX_ATTEMPTS` (3)
2. `bun install` (or `npm install`)
3. `bun start` (or `node bot.js` with Node.js installed)

The scripts assume [Bun](https://bun.sh) because this machine has no Node.js
installed; `start:node` / `test:node` are provided if you prefer Node.

With the `local` backend the bot listens on `0.0.0.0:8080`, so the phone must be
able to reach it: use the LAN address while testing, or a tunnel / VPN / reverse
proxy in production. Serve it over HTTPS — the token is the only protection.
With the `smsgate` backend no server is started; the bot is only a client.

State is persisted in `data/state.json`, so pending requests survive a restart.

## Commands

| Message | Effect |
| --- | --- |
| `/location {number}` | Queues `/location {number}` as an SMS to the destination SIM and waits for the reply |
| anything else | Echoed back (original behaviour) |

Several people can wait at the same time. Each chat gets its own request and
replies are routed back to the right chat. A reply is matched to the oldest
pending request whose `{number}` appears in the SMS body; if the body contains
no known number it goes to the oldest pending request overall. Unanswered
requests time out after `RESPONSE_TIMEOUT_MINUTES` and the chat is told so.

## Gateway API

All `/gateway/*` routes require the header `x-gateway-token: $GATEWAY_TOKEN`.

| Route | Body | Response |
| --- | --- | --- |
| `GET /health` | – | `{ ok, uptimeSeconds, sender }` |
| `POST /gateway/outbox/claim` | `{}` | `{ sms: { requestId, to, body } \| null }` |
| `POST /gateway/outbox/result` | `{ requestId, status: "sent"\|"failed", error? }` | `{ ok, status }` |
| `POST /gateway/inbound` | `{ from, body, receivedAt, messageId }` | `{ ok, matched, requestId? }` |

A claimed SMS is leased for `CLAIM_LEASE_SECONDS`; if the phone dies mid-send the
request is handed out again. Failed sends are retried up to `SEND_MAX_ATTEMPTS`
times before the chat is told the send failed. `messageId` makes inbound
delivery idempotent, so a re-delivered SMS never produces two answers.

## Android gateway app (`android-gateway/`)

Small Kotlin app, no dependencies beyond AndroidX:

- Settings screen: bot URL, gateway token, poll interval, auto-start after reboot
- `GatewayService` — foreground service that polls `/gateway/outbox/claim`,
  sends the SMS with `SmsManager` (multipart aware) and reports the result
- `SmsReceiver` — forwards every incoming SMS to `/gateway/inbound`
- `BootReceiver` — restarts the service after a reboot

### Build

Requires JDK 17 and the Android SDK (compileSdk 34).

```bash
cd android-gateway
gradle wrapper          # once, if gradlew is missing
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or open `android-gateway/` in Android Studio and press Run.

### Phone setup

1. Grant the SMS and notification permissions on first launch.
2. Enter the bot URL (`http://192.168.1.x:8080` on a LAN) and the gateway token.
3. Press **Start** and allow the notification. Keep the phone charged, plugged in,
   with the screen lock disabled.

Android only lets the *default* SMS app receive `SMS_DELIVER`, but `SMS_RECEIVED`
is still delivered to any app holding `RECEIVE_SMS`, which is what this app uses
— so it does not have to be the default messaging app.

## Notes and limits

- Every request costs one SMS in each direction; watch the SIM credit.
- Some carriers throttle or block automated SMS; check the local rules.
- An SMS that arrives after its request timed out is logged and dropped
  (`onUnmatchedInbound` in `bot.js`) instead of being guessed at.
- The bot process must stay running: it is a polling Telegram bot plus a small
  HTTP server.
- Never commit `.env` or the BotFather token file — `.env` and `data/` are git-ignored.

## Tests

`bun test` covers the queue → claim → send → reply → timeout flow, per-chat
routing, deduplication, auth and persistence. With Node.js installed, use
`bun run test:node`.
