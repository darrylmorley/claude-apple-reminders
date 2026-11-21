# Apple Reminders plugin

Lets Claude read, add, edit, complete and delete reminders in Apple Reminders on your Mac, and create or delete lists. Nothing else on your Mac is touched (no Calendar, Notes or Contacts).

## Install

In Claude Code or the Claude desktop app:

```
/plugin marketplace add darrylmorley/claude-apple-reminders
/plugin install apple-reminders@claude-apple-reminders
```

Or download a release `.plugin` file and open it in the Claude desktop app.

## Design

- **Local only.** The server makes no network requests. It imports only Node built-ins (`child_process`, `path`, `readline`, `url`). Your reminders still sync through iCloud as usual.
- **No dependencies, no binary, no build.** There are two readable files:
  - `server/server.mjs`: an MCP server over stdio. It validates every argument.
  - `server/reminders.js`: JavaScript for Automation, run with `/usr/bin/osascript -l JavaScript`.
- **Reminder text can't become code.** Each request is passed to `osascript` as one argument with `execFile` (no shell) and parsed as JSON on the other side. It's never pasted into a script.
- **Deletes need a human click.** Deleting reminders or a list shows a native macOS dialog that lists exactly what will go. Nothing is deleted unless you click **Delete**. If nobody answers within 2 minutes, it cancels. The model can't answer the dialog.
- **Region-safe dates.** Dates are built from numbers (`YYYY-MM-DD[THH:MM]`), never parsed from text, so a UK Mac can't swap day and month.

## Tools

| Tool | Does |
|---|---|
| `list_reminder_lists` | All lists, with ids and open counts |
| `get_reminders` | Filter by list, open/completed/all, due before or after, text search, flagged; soonest due first |
| `get_reminder` | One reminder by id |
| `create_reminder` | Title, notes, all-day or timed due date, priority, flag |
| `update_reminder` | Change any field (including the due date), clear notes, move to another list |
| `complete_reminders` | Mark one or many done (or not done) |
| `delete_reminders` | Permanently delete; confirmed on the Mac |
| `create_list` | New list (refuses duplicates) |
| `delete_list` | Delete a list and its reminders; confirmed on the Mac |

## Requirements and first run

- macOS, with Node.js 18 or later available as `node`.
- The first time a tool runs, macOS asks whether Claude may control **Reminders**. Click **OK**. If you click Don't Allow, turn it back on in System Settings > Privacy & Security > Automation.
- If the server doesn't start because the desktop app can't find `node` (common with Homebrew or nvm installs), replace `"command": "node"` in `.mcp.json` with the full path from `which node`.

## Known limits

- **Alerts can't be turned off, and due dates can't be removed.** Reminders adds an alert to every dated reminder (at the due time, or at midnight for all-day ones). Apple's scripting can't remove alerts or due dates. Both JXA `null` and AppleScript `missing value` were tested on a real Mac and are ignored. So the tools only offer setting and changing dates. Removing one needs the Reminders app, or a future EventKit helper.
- Every create and update reads the reminder back. If Reminders stored a date differently from what was asked, the reply includes a `warnings` entry.

- Repeating reminders, location alerts, subtasks, tags and sections aren't supported, because Apple's scripting interface doesn't expose them.
- Moving a reminder to another list depends on Reminders' scripting support for `move`. If your macOS version refuses, the tool reports it clearly and keeps your other changes.
- Large lists (thousands of reminders) take a few seconds, since each property is one Apple Event per list.

## Tests

`npm test` (or `node tests/run-tests.mjs`) runs the real server and script against a simulated Reminders app (no Mac needed). It imitates the Reminders behaviour observed on a real Mac. It covers filtering, dates, alerts that Reminders adds by itself, validation, injection attempts, delete confirmation (confirm, cancel, timeout) and protocol handling.

## Credits

Some design ideas were adapted from [FradSer/mcp-server-apple-events](https://github.com/FradSer/mcp-server-apple-events) (MIT): passing values as process arguments, confirming destructive writes, and treating reminder content as untrusted. No code was copied.

## Licence

MIT © 2026 Bitmoor Ltd. Not affiliated with Apple or Anthropic.
