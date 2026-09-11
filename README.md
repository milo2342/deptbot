# WCRP Department Utilities

Discord.js bot for WCRP FiveM duty-hour tracking, LEO voice tracking, department reports, higher-up reports, ride-alongs, and department purchase tickets.

## Runtime

- Node.js 18.17 or newer.
- All slash commands register globally.
- Reports, higher-up reports, ride-alongs, and department purchase tickets are restricted to guild `1499578614298181642`.
- Tracked departments: USM, SASP, BCSO, LSPD.
- LEO voice channels:
  - `1542399560394088538`
  - `1542399564588261446`
  - `1542399567234994206`

The bot reads FiveM duty sessions from the MySQL `duty_hours` table. `schema.sql` creates the supporting tables without replacing existing duty data.

## MySQL behavior

The Discord client starts even if MySQL is unavailable. Database queries use a short timeout and a cooldown. When MySQL goes offline, the bot logs the offline transition once, retries silently in the background, and logs again when database access is restored. Database-dependent commands receive a normal Discord response instead of hanging or dumping a stack trace into the interaction.

`settings-cache.json` is used as the local fallback for Discord configuration. Configuration commands update the local cache immediately and also write to MySQL whenever it is reachable.

If the bot runs directly on the same VPS as MySQL, `MYSQL_HOST=127.0.0.1` is correct. If the bot runs in Railway or another remote container, `127.0.0.1` points at that container, not the VPS. In that case `MYSQL_HOST` must be a network address reachable from the container, and MySQL/firewall permissions must permit the connection.

## Interaction handling

Slash commands are deferred before permissions or database work. Buttons and modal submissions either open their next modal immediately or defer immediately before asynchronous work. Ephemeral interactions use Discord message flags rather than the deprecated `ephemeral` defer option.

## Officer reports

`/officer-report-panel` posts two buttons only:

- Officer Report
- Higher Up Report

After either button is pressed, the user receives a department dropdown containing USM, SASP, BCSO, and LSPD. The selected department controls the ticket category, handler roles, role ping, and permissions.

The report modal contains exactly five fields:

- Date of incident
- In-game ID of who is being reported
- Clips/evidence
- Description of what is shown in the clip
- All necessary context

The officer Discord account is intentionally handled separately because Discord modals only allow five inputs. The configured handler uses `/addofficer user:<member>` or `/addofficer user_id:<exact id>`.

The report ticket embed follows the requested report layout:

- Department
- Date of incident
- In Game ID of who you are reporting
- Suspected Discord
- Clip / additional clips
- Describe in detail what is in the clip
- Provide all necessary context for the clip

Evidence links are also posted as raw messages beneath the embed so Discord can generate link previews. The department handler role is pinged after the evidence, matching the ticket flow.

### Department-specific Reports Team

`/report-staff` now requires a department. Roles configured for one department do not receive explicit access to another department's officer-report tickets.

Examples:

- `/report-staff action:Add department:USM role:@USM Reports Team`
- `/report-staff action:Add department:SASP role:@SASP Reports Team`
- `/report-staff action:View department:USM`

The same department-specific Reports Team roles are used for:

- Ticket access
- New-ticket pings
- `/addofficer`
- `/rename`
- `/close`
- `/delete`
- Anonymous report handling

### Department-specific categories

`/report-config` stores a different category for each department.

Examples:

- `/report-config action:Set Department Ticket Category department:USM category:USM Reports`
- `/report-config action:Set Department Ticket Category department:SASP category:SASP Reports`
- `/report-config action:View department:USM`

A legacy single report category is still accepted as a fallback when no department category has been configured yet.

## Higher-up reports

Higher Up Report uses the same department dropdown and report form but has a separate handler configuration. Standard Reports Team roles are not explicitly added to higher-up tickets.

Use `/higherup-config` to configure department coordinator roles and, optionally, a separate category for each department.

Examples:

- `/higherup-config action:Add Department Coordinator Role department:USM role:@USM Department Coordinator`
- `/higherup-config action:Set Higher-Up Ticket Category department:USM category:USM Higher Up Reports`
- `/higherup-config action:View department:USM`

If no higher-up category is set, that department's normal report category is used.

## Anonymous reports

`/anonreport` anonymizes the current report ticket without asking the reporter to re-enter evidence. It:

- Keeps the original report data and clips.
- Renames the channel to `anon-usm`, `anon-sasp`, `anon-bcso`, or `anon-lspd`.
- Clears and rebuilds the ticket.
- Removes the opener's channel access.
- Keeps only the configured handler role for that department/type and the bot.
- Keeps the reported Discord user read-only when `/addofficer` has been used.
- Reposts the complete report embed and raw evidence links.
- Pings the reported user when applicable.

For a higher-up report, the retained handler role is the configured department coordinator role rather than the normal Reports Team role.

## Closing and deleting report tickets

`/close` and the Close button are restricted to the configured handler for the ticket's department/type.

When a report is closed the bot now:

1. Automatically archives a transcript to the configured transcript log channel, falling back to the report log channel if needed.
2. Removes the opener and reported officer access.
3. Removes the old Close button.
4. Pings the configured handler role.
5. Posts a `Ticket Closed` embed.
6. Posts a second `Delete Ticket` embed with a `Delete Ticket` button.
7. Logs the close event in the configured report log channel and pings the handler role there.

`/delete` and the Delete Ticket button permanently delete the ticket after logging it.

## Department purchase tickets

`/dept ticket` posts a `Purchase a Department` panel with a `Purchase Department` button. Posting the panel is an admin action; users submit applications through the button.

The application is split across two modal steps because Discord allows a maximum of five modal inputs. Every requested question is required:

- What department do you want to open?
- Reason for opening
- Is it Local, Federal, or State?
- Do you already have EUP and vehicles ready?
- Do you have the entire high command team ready?
- Do you have a Discord ready?
- Why should WCRP allow you to open the new department?

Use `/dept-config` to configure handler roles, the department purchase category, and its log channel.

Examples:

- `/dept-config action:Add Handler Role role:@Department Management`
- `/dept-config action:Set Ticket Category category:Department Purchases`
- `/dept-config action:Set Log Channel channel:#department-purchase-logs`
- `/dept-config action:View`

The created ticket only explicitly grants access to the applicant, configured department purchase handler roles, and the bot.

## Duty hours and ride-alongs

`/hours` requires department and timeframe and has an optional user.

`/evaluate` requires an exact user, department, and timeframe.

Timeframes are Last Week, This Week, This Month, Last Month, and All Time.

`/ridealong` removes the configured trainee role if the trainee already has it. On a passed result it can also assign the configured or selected ride-along role.

When a duty session ends, the bot DMs the officer the WCRP Off Duty embed containing the clock-out time, session length, Friday-to-Thursday weekly hours, department, LEO voice time, out-of-voice time, and voice coverage.

## Validation

Run:

```bash
npm run check
npm test
```

The included static integration tests cover global command registration, interaction acknowledgement ordering, no deprecated ephemeral defers, department-specific report roles/categories, higher-up coordinator isolation, anonymous ticket rebuilding, close/delete behavior, department purchase flows, MySQL offline log suppression, WCRP branding, and the fixed guild/voice IDs.
