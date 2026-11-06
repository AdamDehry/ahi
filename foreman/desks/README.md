# Standing desks

A desk is a scheduled job that watches one thing and acts on its own — "make it a rule that X happens
automatically". `queue_desk.sh` is the worked example: when no build is active but `QUEUE.md` still
has open work, it wakes Michael once so the chain does not stall.

Every desk follows the same shape:

| Part | Rule |
|---|---|
| Schedule | One UTC crontab line, installed by a person or the supervisor — a script never installs its own. Cron ignores `CRON_TZ` on many systems, so decide local time in code. |
| KILL file | `$FOREMAN_ROOT/<NAME>-OFF` — present means do nothing, say so, exit 0. |
| DRY switch | `<NAME>_DRY=1` prints what it would do and changes nothing. |
| Lock | `flock -n` on `$FOREMAN_ROOT/locks/<name>.lock`, so a slow tick never overlaps the next. |
| Log | `$AHI_HOME/state/logs/<name>.log`, tail-trimmed every run. |
| State | `$AHI_HOME/state/foreman/<name>.state` — what was handed out and when. |
| One at a time | A desk that starts builds starts one, through `build_start.sh` / `build_from_brief.sh`, and waits while it is active. |
| Cooldown | The same gap set is never handed out twice inside the cooldown — a gap a build could not close comes back to Michael, it does not loop. |
| Exit status | Always 0, so cron never alarms; reasons go to the log. |
| Reader | Name who reads the desk's findings. A signal nobody reads is not delivered. |

Install the example:

```bash
( crontab -l 2>/dev/null; echo "*/15 * * * * AHI_HOME=$AHI_HOME $AHI_HOME/foreman/desks/queue_desk.sh >/dev/null 2>&1" ) | crontab -
```

Edit a crontab by appending through a pipe like this; never print it into a shared transcript if
it carries secrets in environment lines.
