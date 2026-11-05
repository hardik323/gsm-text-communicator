# 📱 Telegram → SMS → Reply

### Testing & installation guide

> Turn a phone with a SIM into a GSM module for your Telegram bot.
> Send `/location 12345` in Telegram, the phone texts it out, and the answer comes back to the chat.
>
> **Time needed:** ~10 minutes · **Coding required:** none
>
> 🤖 **Your bot:** [@geopulse_official_bot](https://t.me/geopulse_official_bot) —
> open it in Telegram, press **Start**, then use the commands below.

---

## 🎯 What you are building

```
  ┌──────────────┐   /location 12345   ┌─────────────────┐   SMS: /location 12345   ┌──────────────┐
  │  Telegram    │ ──────────────────► │  bot.js  (PC)   │ ───────────────────────► │  Phone with  │
  │  chat        │                     │                 │                          │  the SIM     │
  │              │ ◄────────────────── │  polls /inbox   │ ◄─────────────────────── │  (SMS       │
  └──────────────┘   the SMS answer    └─────────────────┘   SMS: "12345 is at …"    │  Gateway app)│
                                                                                     └──────┬───────┘
                                                                                            │ SMS
                                                                                     ┌──────▼───────┐
                                                                                     │ destination  │
                                                                                     │ device       │
                                                                                     └──────────────┘
```

Three pieces, each tested separately:

| Piece | What it is | Where it runs |
| :-- | :-- | :-- |
| **Bot** | `bot.js` — Telegram commands, reply matching, timeouts | This PC |
| **Gateway app** | Free open-source *SMS Gateway for Android* (Local Server mode) | The phone with the SIM |
| **Destination** | The device that answers `/location …` | Any phone |

The bot keeps one request per chat, so **several people can wait at the same time** and each gets their own answer. Unanswered requests expire after 5 minutes (configurable).

---

## 📋 Before you start

- [ ] A phone with an active SIM, able to **send SMS** (has credit).
- [ ] That phone and this PC on the **same Wi-Fi / LAN**.
- [ ] Your bot open in Telegram: **@geopulse_official_bot** → https://t.me/geopulse_official_bot
- [ ] The bot token already in `.env` — never commit it, paste it in chat, or share it.
- [ ] The number of the device that will **answer** the location queries.

> **Why the same network?**
> In this mode the app runs a small HTTP server on the phone, and the bot calls it directly. No public IP, no port forwarding, no tunnel.

---

# 🧩 Part 1 — Set up the phone

## 1.1 Install the app

1. On the phone, open the releases page:
   **https://github.com/capcom6/android-sms-gateway/releases**
2. Download the newest **`.apk`** file.
3. Allow *install from unknown sources* when prompted, then open the APK and install.
4. Launch the app.

> The app is free and open source (Apache-2.0). No account, email or phone number is required in Local Server mode.

## 1.2 Grant permissions

Accept when the app asks for:

| Permission | Why it is needed |
| :-- | :-- |
| **SMS — send** | to send `/location {number}` |
| **SMS — receive** | to read the reply SMS |
| **Phone state** | to pick the SIM card (optional if you have one SIM) |

## 1.3 Start Local Server

1. On the **Home** tab, switch **Local Server** to **on**.
2. Tap **Start Service** — the button becomes **Stop Service**.
3. A **persistent notification** appears. That notification is your proof the server is running; if it disappears, Android killed the app.

4. In the **Local Server** section, write down:
   - the **local IP address** → e.g. `192.168.31.50` (port `8080` by default)
   - the **username**
   - the **password**

> 🔐 Local Server mode supports **Basic authentication only**. Those two strings are the only protection — keep them private.

## 1.4 Stop Android from killing it

- Open the app's **Settings → System → battery optimisation** and disable it, **or** disable battery optimisation for the app in Android settings.
- Keep the phone **on a charger**.
- On Xiaomi / Samsung / Huawei style devices, follow **https://dontkillmyapp.com**.

### ✅ Checkpoint 1

From this PC (Git Bash), with the IP from step 1.3:

```bash
curl -s http://192.168.31.50:8080/health
```

**Expected:** a JSON response. Nothing back? → *Troubleshooting A*.

---

# 💻 Part 2 — Set up the bot

## 2.1 Install dependencies (once)

```bash
cd "gsm-text-communicator"
bun install
```

## 2.2 Fill in `.env`

Open `gsm-text-communicator/.env` and make sure these lines exist and are filled:

```ini
SMS_PROVIDER=smsgate
SMSGATE_URL=http://192.168.31.50:8080
SMSGATE_USERNAME=<username from the app>
SMSGATE_PASSWORD=<password from the app>
SMSGATE_POLL_SECONDS=5

GATEWAY_SIM_DESTINATION_NUMBER=<the number that answers /location>

RESPONSE_TIMEOUT_MINUTES=5
```

| Setting | Meaning |
| :-- | :-- |
| `SMS_PROVIDER` | `smsgate` = use the phone app · `local` = use the bundled app |
| `SMSGATE_URL` | Phone address — **no trailing slash**, not `localhost` |
| `SMSGATE_USERNAME` / `SMSGATE_PASSWORD` | Credentials from the app's *Local Server* box |
| `SMSGATE_POLL_SECONDS` | How often the bot checks the phone's inbox |
| `GATEWAY_SIM_DESTINATION_NUMBER` | Only SMS **from this number** count as answers |
| `RESPONSE_TIMEOUT_MINUTES` | How long each chat waits for an answer |

> `GATEWAY_SIM_SENDER_NUMBER` and `GATEWAY_TOKEN` are only used by the bundled-app backend — leave them as they are.

## 2.3 Start the bot

```bash
bun start
```

**Expected output:**

```
Telegram bot is running.
SMS backend: "SMS Gateway for Android" at http://192.168.31.50:8080
Replies accepted from <destination> · timeout 5 min · polling every 5s
✅ SMS Gateway app is reachable.
```

Keep this terminal **open** — the bot only works while it runs.

| Message | Meaning |
| :-- | :-- |
| `✅ SMS Gateway app is reachable.` | perfect, continue |
| `⚠️ Cannot reach the SMS Gateway app…` | bot is running but the phone is unreachable → *Troubleshooting A* |
| `❌ Missing required environment variables: …` | a `.env` line is missing; it names it |

---

# 🔍 Part 3 — Test one layer at a time

> Test in this order. If a step fails, later steps cannot work — fix the failing layer first.

## Test 1 — Is the phone online?

```bash
curl -s http://192.168.31.50:8080/health
```

✅ JSON returned.

## Test 2 — Can the phone send an SMS?

Replace `<username>`, `<password>` and `<destination>`:

```bash
curl -u '<username>:<password>' -H 'content-type: application/json' \
  -d '{"textMessage":{"text":"/location 12345"},"phoneNumbers":["<destination>"]}' \
  'http://192.168.31.50:8080/messages'
```

**Expected:** `{"id":"…"}` **and** the destination phone receives `/location 12345`.

| Response | Meaning |
| :-- | :-- |
| `{"id":"…"}` | ✅ SMS queued on the phone |
| `401` | wrong username/password |
| `404` | older app build — the bot also tries `/message`, so this is fine |
| timeout / connection refused | the phone server is not running → *Troubleshooting A* |

## Test 3 — Can the bot read the phone's inbox?

1. Reply to that SMS from the destination device with something containing `12345`.
2. Then run:

```bash
curl -u '<username>:<password>' 'http://192.168.31.50:8080/inbox?type=SMS&limit=5'
```

**Expected:** an entry whose `sender` is your destination number and whose `contentPreview` holds the reply.

> The bot reads this same endpoint every `SMSGATE_POLL_SECONDS`. Anything the app shortens for very long SMS arrives shortened.

## Test 4 — Full round trip through Telegram

1. Open **@geopulse_official_bot** in Telegram and send:

   ```
   /location 12345
   ```

2. The chat replies:

   ```
   📤 Sending /location 12345 over SMS.
   Waiting up to 5 min for the reply…
   ```

3. The destination device receives `/location 12345`.
4. Reply from it, e.g. `12345 is at 48.1372, 11.5756`.
5. Within ~5 seconds the chat receives:

   ```
   📩 Reply for /location 12345

   12345 is at 48.1372, 11.5756

   ⏱ 42s · 05/11/2026, 14:03:11
   ```

🎉 That is the whole product working.

### Other messages you will see

| Situation | Chat message |
| :-- | :-- |
| Wrong command format | `❌ Invalid format. Use /location {number}.` |
| Letters in the number | `❌ The number must be numeric.` |
| No answer in time | `⌛ No reply for /location … within 5 min. The phone did not answer in time.` |
| SMS could not be sent | `❌ Could not send the SMS for /location … after N attempt(s).` |
| Plain text (not a command) | echoed back, as before |

## Test 5 — Several users at once

Ask two different Telegram accounts to send `/location 111` and `/location 222` within a few seconds.

- Both chats say *waiting*.
- When the replies arrive, **each chat gets its own answer**: the bot matches the reply whose text contains that chat's number, and falls back to the oldest waiting request if the text contains no known number.

---

# 🤖 Part 4 — Automated tests

```bash
bun test
```

**Expected:**

```
 18 pass
 0 fail
```

| Suite | Tests | Covers |
| :-- | :-- | :-- |
| `test/gateway.test.js` | 10 | queue → claim → send → reply → timeout, per-chat routing, wrong sender, duplicates, retry → fail, lease recovery, auth (401), restart persistence |
| `test/smsgate.test.js` | 8 | exact send payload + Basic auth, `/message` fallback, HTTP errors, inbox query, reply routing, foreign sender, no re-delivery, stale messages, unreachable app |

These need no phone and no Telegram connection.

---

# 🛠 Troubleshooting

### A. The bot cannot reach the phone

1. Is the **Local Server** still on and the **Start Service** button now showing **Stop Service**?
2. Is the persistent notification still visible? If not, Android killed the app → step 1.4.
3. Did the phone's IP change? Re-read it in the app and fix `SMSGATE_URL` (reserve a static IP on the router to avoid this).
4. Same network? Corporate/guest Wi-Fi often blocks device-to-device traffic.
5. Test from the PC with `curl …/health` — if that fails, the bot cannot succeed either.

### B. Other common problems

| Symptom | Fix |
| :-- | :-- |
| `401 Unauthorized` | Re-copy username/password from the app |
| Works, then stops after some minutes | Battery optimisation, or the phone's Wi-Fi sleep — step 1.4 |
| SMS sends, but the chat never gets the reply | `GATEWAY_SIM_DESTINATION_NUMBER` is not the number that actually replied |
| Two chats, wrong chat answered | Both replies contained no number — make the destination include the requested number in its answer |
| Long reply looks cut off | The app's `contentPreview` shortens very long SMS |
| Nothing works after an Android update | Re-grant SMS permissions; open the app once |

---

# 🔐 Security checklist

- [ ] `.env` stays out of git (already ignored) — it holds the bot token and gateway credentials.
- [ ] The SMS Gateway username/password are never shared or committed.
- [ ] Revoke the old BotFather token that was pasted into `New Text Document.txt`, then delete that file.
- [ ] Run the bot on a trusted network only; the phone's API is Basic-auth protected and LAN-only.
- [ ] Keep SIM credit in mind: every request costs **two** SMS.

---

# 📚 Quick reference

### Environment variables

| Variable | Default | Used by |
| :-- | :-- | :-- |
| `TELEGRAM_BOT_TOKEN` | — | both |
| `SMS_PROVIDER` | `smsgate` | backend selector |
| `SMSGATE_URL` | — | smsgate |
| `SMSGATE_USERNAME` / `SMSGATE_PASSWORD` | — | smsgate |
| `SMSGATE_POLL_SECONDS` | `5` | smsgate |
| `GATEWAY_SIM_DESTINATION_NUMBER` | — | both |
| `RESPONSE_TIMEOUT_MINUTES` | `5` | both |
| `SEND_MAX_ATTEMPTS` | `3` | both |
| `DATA_FILE` | `data/state.json` | both |

### Phone app endpoints used by the bot

| Call | Purpose |
| :-- | :-- |
| `POST /messages` | send `/location {number}` (falls back to `/message`) |
| `GET /inbox?type=SMS&limit=50` | read received SMS |
| `GET /health` | check the phone is online |
| `GET /docs` | interactive API docs served by the phone |

### Handy commands

```bash
bun start          # run the bot
bun test           # run all tests
cat data/state.json # inspect pending / answered requests
```

---

*Guide written for this repository. The SMS Gateway app is a separate Apache-2.0 project by capcom6 — its UI labels may differ slightly between releases.*
