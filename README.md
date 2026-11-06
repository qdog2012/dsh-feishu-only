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

Then enable the `dsh-feishu-only` row and open **设置 → 飞书机器人** in the Web UI.

## Connect a bot

The settings page (**设置 → 飞书机器人**) is the front door for onboarding. It
offers two independent paths, because they answer different questions:

**Create** — press *生成授权二维码*. The page starts a device authorization and
renders the verification QR from
`GET /plugins/dsh-feishu-only/qr-image?url=…`, which only draws the URL this
plugin itself issued. Scan with the Feishu mobile app; the page follows the
scan on its own and completes the connection.

**Connect existing** — enter an App ID and Secret in the second card. The pair
is verified against `/open-apis/bot/v3/info/` *before* it is saved, so a pair
that cannot read its own bot identity is rejected rather than half-connected.
The secret goes to the credential store and is cleared from page state; it is
never echoed back or written to the profile file.

The status card reports the robot, message and executor layers separately, has
a one-click *检查接入* check, and a *断开连接* that stops the connection and
forgets the secret while keeping the App ID.

The same capabilities are reachable over HTTP, which is what the page uses:

| Route | Purpose |
| --- | --- |
| `GET /plugins/dsh-feishu-only/status` | Connection, bot identity, capabilities, registration state |
| `GET /plugins/dsh-feishu-only/qr?start=1` | Start (or reuse) a device authorization |
| `GET /plugins/dsh-feishu-only/qr` | Poll the current registration |
| `GET /plugins/dsh-feishu-only/qr-image?url=…` | The QR as SVG, for the issued URL only |
| `GET /plugins/dsh-feishu-only/qr/cancel?cancel=1` | Cancel the attempt |
| `GET /plugins/dsh-feishu-only/connect?appId=…&appSecret=…` | Verify and save a credential pair |
| `GET /plugins/dsh-feishu-only/verify` | The three-layer check |
| `GET /plugins/dsh-feishu-only/menu?sync=1` | Publish/reconcile the `/` command menu |
| `GET /plugins/dsh-feishu-only/disconnect?confirm=1` | Stop the connection and forget the secret |

### The `/` command menu

The panel a user sees when typing `/` in a chat is the only discoverable entry
point, so the bridge publishes its commands there. The reconcile is idempotent
and runs once after connecting (`syncMenu`, on by default):

- **Creates** any command in `lib/menu.js` that the app lacks, in reverse order
  because Feishu lists newest first and resolves ordering only per second.
- **Keeps** an entry whose hint already matches.
- **Replaces** a same-named entry registered by another plugin with a different
  hint. The API has no update, so this is a delete + create; leaving it would
  advertise behaviour this bridge does not have.
- **Removes** any registered command that is not in the menu. A panel entry the
  parser rejects is a dead button, regardless of which plugin added it.

Needs `application:app_slash_command:read` and `application:app_slash_command:write`.
Without them the bridge still works — the menu just is not published, and
`/status` reports the missing scope as an instruction.

`resource` routes answer GET/HEAD only, so the signals travel as query flags
rather than methods. The QR encoder is small and lives in `lib/qr.js`; it was
verified byte-for-byte against an independent decoder before shipping.

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
npm test     # 230 tests, node:test only
npm run check
```

`test/frame-codec.test.js` pins the protobuf field order with golden bytes, and
the encoder has been verified byte-for-byte against the reference `pbbp2.Frame`
definition.

### Layout

```
index.js              plugin entry: config, runtime lifecycle, HTTP routes
client.js             Web UI settings page (settings.section): QR + manual
lib/
  config.js           field metadata, schema document, validation
  cards.js            every card the bridge sends
  qr.js              QR encoder (byte mode, level M) for the onboarding page
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