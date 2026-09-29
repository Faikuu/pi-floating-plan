# @faiku/pi-floating-plan

A [pi](https://github.com/earendil-works/pi) extension that floats the plan the agent is working from in a corner of the terminal.

```
╭─ PLAN ─ step 3 of 4 ──────────╮
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░ │
│ ✔ read the config             │
│ ✔ map every call site         │
│ ▸ implement the panel         │
│ ○ tests, typecheck, README    │
╰─ 2 of 4 done ─────────────────╯
```

The panel is an overlay, not a dialog: it floats above the conversation while the editor keeps focus and every keystroke. The model publishes the plan with the `update_plan` tool, the panel redraws when — and only when — the plan actually changes, and `alt+o` (or `/plan`) shows and hides it.

## What it does

| Action | Result |
|---|---|
| The model calls `update_plan` | The panel shows the new plan, with one step marked in progress |
| The model calls a todo tool named in `mirrorTools` | The same panel, driven by that tool's output |
| `/plan add … start … done …` | The same panel, driven by you — for models that cannot call tools |
| `alt+o`, or `/plan` | The panel appears and disappears |
| A new session, a fork, a branch jump | The plan is rebuilt from the transcript, so it matches the history you are actually on |
| `/plan clear`, or a plan with no steps | The panel closes itself |

## Commands

| Command | Effect |
|---|---|
| `/plan` | Toggle the panel (session only) |
| `/plan show` / `/plan hide` | Show or hide the panel, and remember the choice in `settings.json` |
| `/plan list` | Print the plan in the chat |
| `/plan add <step>` | Append a step |
| `/plan start [step]` | Mark a step in progress (no argument: the last one) |
| `/plan done [step]` | Mark a step completed |
| `/plan block [step]` | Send a step back to pending |
| `/plan note <text>` | Annotate the plan; the note is shown under it |
| `/plan clear` | Drop the plan and close the panel |
| `/plan anchor <corner>` | Float in `top-center` (default), `bottom-center`, `top-left`, `top-right`, `bottom-left`, `bottom-right`, `left-center`, or `right-center` |
| `/plan help` | The same list |

A step is named by its number (`/plan done 3`) or by the start of its text (`/plan done write the`), case-insensitively.

## Working with any model

The panel is the same whichever model is driving, because nothing in the pipeline assumes a particular model's habits.

- **The tool schema is small and conventional** — `steps: [{ text, status }]` with three statuses — so any tool-calling model can produce it.
- **Whatever arrives is normalized.** A model that sends `{ todos: [...] }`, bare strings, `[x] run the tests`, `done: true`, or a status spelled "in progress", "doing", or "current" all land on the same three states. Argument coercion runs before schema validation, so an odd shape is folded rather than rejected.
- **Exactly one step is current.** Models that mark two steps active, or none, are corrected: the first active step wins, and the first untouched step is promoted when nothing is active.
- **A model that cannot call tools still gets a plan**, through `/plan`. Nothing in the panel depends on the tool existing.
- **Other people's plans count.** If a todo tool is named in `mirrorTools`, its output is adopted when it parses as a plan, so an agent already using `todo_write` needs no prompt changes.
- **Repeats cost nothing.** The panel is redrawn only when the plan's content fingerprint changes, so a model that rewrites the same plan on every turn triggers no renders at all.

## Behaviour worth knowing

- **The panel never takes input.** It is shown as a non-capturing overlay, so `esc`, `ctrl+c`, and every editor shortcut behave exactly as they do without it. `alt+o` is handled by pi as a shortcut, not by the panel.
- **It is a spectator in every mode.** Outside the TUI (print, JSON, RPC) nothing terminal-only runs; `ctx.mode` guards the overlay.
- **The plan lives in the transcript, not in a file.** Each `update_plan` result carries the plan as tool-result details, so branching and reloading restore the plan that was in force at that point rather than the last one written.
- **One step in progress, always.** `pending → in_progress → completed` is the whole vocabulary; anything else is folded into it.
- **Long plans slide.** A plan longer than `maxSteps` shows a window around the step in progress, so the work you are on is never the part that got cut.
- **Narrow terminals get a compact block.** Under `compactBelow` columns the frame is dropped for a three-line summary; under 24 columns the overlay is not shown at all.
- **It never covers the input box.** The panel is anchored top-center and capped at 60% of the terminal height, so it grows down from the top and stops well short of the editor. `/plan anchor` moves it if you want it elsewhere.

## Configuration

Optional block in `<agent-dir>/settings.json` (default `~/.pi/agent/settings.json`):

```json
{
  "floatingPlan": {
    "visible": true,
    "anchor": "top-center",
    "width": 38,
    "maxSteps": 24,
    "maxTextLength": 140,
    "showBar": true,
    "showNote": true,
    "showModel": false,
    "compactBelow": 34,
    "toggleKey": "alt+o",
    "mirrorTools": ["todo", "todos", "todo_write", "update_todo_list", "update_plan", "plan", "set_plan"]
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `visible` | `true` | Show the panel as soon as a plan exists. `/plan show` and `/plan hide` write this. |
| `anchor` | `top-center` | Where the panel floats. The default is at the top because pi draws the editor along the bottom of the screen. |
| `width` | `38` | Frame width in columns, capped at 120 and at the terminal's width. |
| `maxSteps` | `24` | Steps shown at once; the window follows the current step. |
| `maxTextLength` | `140` | Characters per step before it is elided. |
| `showBar` | `true` | Draw the completion bar. |
| `showNote` | `true` | Draw the note a model attaches to a change. |
| `showModel` | `false` | Put the active model in the title. A long name costs the summary, never the frame. |
| `compactBelow` | `34` | Columns below which the frame becomes a compact block. |
| `toggleKey` | `alt+o` | Shortcut that toggles the panel. Read at load, so pi must be restarted after a change. |
| `mirrorTools` | see above | Other tools whose plan-shaped output is adopted. A single name may be given as a string. |

Anything of the wrong type or out of range is ignored and the default is used.

## Install

```bash
pi install npm:@faiku/pi-floating-plan
```

Or from a clone, while working on it:

```bash
pi --extension /path/to/pi-floating-plan
```

`alt+o` toggles the panel. If your terminal sends `alt+o` as something else, pick another key with `toggleKey` — `ctrl+j` and `ctrl+y` are usually free.

## Development

```bash
npm install
npm test        # node:test, no build step
npm run typecheck
```

`lib/plan.ts` is the model-facing half and is deliberately free of pi imports, so the normalization is testable on its own. `lib/panel.ts` is the rendering half. `index.ts` wires them to pi and owns the overlay's lifetime.

## License

MIT
