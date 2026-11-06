# dsh-feishu-only

A Feishu (Lark) bot bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It turns a Feishu chat into a control surface for Harness sessions, following
[飞书机器人任务交互设计参考.md](./飞书机器人任务交互设计参考.md): scan-to-create
onboarding, a fixed slash-command language, numbered task navigation,
one live progress card per round, answers delivered separately, and approvals
kept strictly apart from questions.

The plugin has **no runtime dependencies** — not even the Feishu SDK. It speaks
the long-connection protocol, the OpenAPI endpoints and the onboarding device
flow directly over `fetch` and Node's built-in `WebSocket`. That is what lets it
install into any profile with no peer packages to satisfy.

## What it does

| Area | Behaviour |
| --- | --- |
| Onboarding | Scan a QR to create and authorize a bot, or paste an existing App ID/Secret. The QR grants exactly the scopes, event and card callback this bridge uses. |
| Transport | One WebSocket long connection carries both `im.message.receive_v1` and `card.action.trigger`. No public callback URL is needed. |
| Tasks | One DSH session per task. Lists are numbered *snapshots*: `/task 3` means the third row of the list you last saw, and a stale number can never select a different task. |
| Input | Text and rich text become task input. Images alone are staged until you send their instruction. Files are downloaded into the task workspace first. |
| Progress | One card per round, updated in place with phase, tools and produced resources. |
| Results | The final answer is sent as its **own** message, deduplicated by event, so a truncated progress area can never lose it. |
| Approvals | Separate card, private chat only, fail-closed. A delivery failure is a rejection, never a grant. |
| Questions | Separate card with a real form; every question submits together, and free text wins over a selection. |
| Previews | Text and images render inline; Office and PDF are delivered as paged documents. Download is a separate action, because a preview is not an uploaded file. |

## Install

```bash
dsh plugin add dsh-feishu-only
```

Or, in this checkout:

```bash
dsh --profile <profile> plugin add /absolute/path/to/dsh-feishu-only
```

Then enable the `dsh-feishu-only` row and open the plugin's settings to connect
a bot.

## Connect a bot

Two independent paths, because they answer different questions:

**Create** — `POST /plugins/dsh-feishu-only/qr` starts a device authorization.
The response carries a verification URL to render as a QR plus an expiry. Poll
`GET /plugins/dsh-feishu-only/qr` for the state. When the user finishes in their
Feishu client, `poll` returns the new `client_id` / `client_secret`; the block
stores the secret in the credential service and connects immediately.

**Connect existing** — `POST /plugins/dsh-feishu-only/connect` with
`{ "appId": "cli_…", "appSecret": "…" }`. The credential pair is verified against
`/open-apis/bot/v3/info/` before it is saved, so a pair that cannot read its own
bot identity is rejected rather than half-connected.

`GET /plugins/dsh-feishu-only/verify` checks the three layers separately —
robot identity, message connection, card callback — and reports the executor
state as a fourth. Bot reboot is not required.

### Required platform configuration

Creating the bot through the QR flow sets these up. For an app you created by
hand, in [open.feishu.cn](https://open.feishu.cn):

1. **机器人** capability enabled.
2. Scopes: `im:message`, `im:message:send_as_bot`, `im:message:readonly`,
   `im:resource`, `im:chat:read`, `im:chat:create`.
3. **事件与回调 → 事件配置 → 订阅方式: 使用长连接接收事件**, with
   `im.message.receive_v1`.
4. **事件与回调 → 回调配置 → 订阅方式: 使用长连接接收回调**, with
   `card.action.trigger`. This is a *separate* toggle from the event one; both
   must be long connection.
5. Publish the app.

## Commands

A slash command is a control operation. Anything else is task input. An unknown
slash command returns help — it is never forwarded to the model.

| Command | Meaning |
| --- | --- |
| `/help` | Features and one-click entries |
| `/project`, `/project page <n>` | Projects and project-scoped task creation |
| `/task`, `/task page <n>` | Browse and page through tasks |
| `/task <n>` | Select from the last list you saw |
| `/task create <title>` | Create and select a task |
| `/task current` | Everything that decides the next round |
| `/task search <kw>`, `/task search page <n>` | Search and page results |
| `/history`, `/history page <n>` | History by execution round (5 per page) |
| `/last` | Re-read the newest reply — never starts a turn |
| `/plugin` | Enabled plugins and callable skills |
| `/permission`, `/permission <n>` | Permission mode |
| `/model`, `/model <n>` | Model |
| `/reasoning`, `/reasoning <n>` | Reasoning effort |
| `/mode`, `/mode <n>` | Working mode |
| `/compact` | Compact context |
| `/goal`, `/goal set <t>`, `/goal clear` | Goal |
| `/stop` | Stop this task's current round |
| `/status` | Bot, connection, executor and task state — separately |
| `/restart` | Explain restart scope (does not restart the executor) |
| `/update` | Check for a newer bridge version |

Settings change from the **next** round. Switching a setting never kills the
running turn.

## Design notes

**State ownership.** The current task is stored per user, so switching chats
does not silently change the execution target. Every list is a snapshot bound to
its owner: another user pressing your card button gets nothing, and a number
from an old list is rejected rather than resolved against new data.

**Why results are separate.** The progress card answers "what is happening";
the result message carries the answer. Merging them would mean a truncated or
failed card update could destroy the deliverable.

**Why approvals fail closed.** An approval may only be granted by pressing a
button in a private chat. If the private card cannot be delivered, or nobody can
be reached, the request resolves to `rejected` (approvals) or stays pending for
another answerer (questions). Sending a card is never treated as consent.

**Retry policy.** A model-capacity failure is retried only for a task this
bridge started, through the `agent/request-error` waterfall. The interval is
fixed (`capacityRetryMs`, default 10 s) with no attempt cap, every wait is
published on the progress card with its attempt number, and a stop, a new round
or a cleared goal ends the schedule. An observed foreign task is never granted
retry authority by the act of being observed.

**No hand-written profile edits.** The bridge persists its own configuration
through the profile's `configEditor`, and stores the App Secret as a credential
record rather than in plain text.

## Development

```bash
npm test     # 175 tests, node:test only
npm run check
```

`test/frame-codec.test.js` pins the protobuf field order with golden bytes, and
the encoder has been verified byte-for-byte against the reference `pbbp2.Frame`
definition.

### Layout

```
index.js              plugin entry: config, runtime lifecycle, HTTP routes
lib/
  config.js           field metadata, schema document, validation
  cards.js            every card the bridge sends
  commands/parse.js   the slash-command grammar
  state.js            current task, snapshots, staged images, interactions
  harness.js          adapter over Host services (all optional)
  round.js            one execution round's live tracker
  bridge.js           message and card routing
  interactions.js     approval / question waterfall answerers
  preview.js          preview rendering and original-file download
  feishu/
    api.js            OpenAPI client with a tenant-token cache
    ws.js             long connection: pbbp2 codec, ping, reassembly
    registration.js   scan-to-create device authorization
    messages.js       inbound event normalization
```

## Limitations

- `/restart` explains the restart scope and points to the desktop client; the
  bridge does not restart the harness process from Feishu.
- `/update` reports the installed version; upgrading happens through the plugin
  manager.
- Office and PDF previews are delivered as paged PDF documents rather than
  raster screenshots, because this deployment offers no PDF rasterizer. The
  bridge says which it is instead of labelling a first page as the whole file.
- Web-page preview needs a browser capability registered in the profile; without
  one, the bridge says so instead of producing a partial image.

## License

MIT