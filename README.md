# WCRP Department Utilities

Node.js / discord.js bot for shared FiveM duty-hour tracking across multiple Discord servers, plus report and ride-along tools kept in one dedicated Discord server.

## What is global

These commands are registered as global application commands and all read the same MySQL duty data, no matter which Discord server the command is used in:

- `/hours`
- `/allhours`
- `/totalhours`
- `/weeklydeptours`
- `/deptofhours`
- `/tophours`
- `/leaderboard`
- `/evaluate`
- `/inactive_officers`
- `/promotions`
- `/leomulti`
- `/dept_officers`
- `/add_org`
- `/add_org_hours`
- `/rename_org`
- `/permissions`
- `/admin-roles`

The bot watches the same MySQL `duty_hours` table, so hours are shared between every Discord server where the bot is installed.

## Reports and ride-alongs server

The following tools only run in `LOG_GUILD_ID`:

- `/officer-report-panel`
- `/anonreport`
- `/addofficer`
- `/reportadd`
- `/report-config`
- `/report-staff`
- `/log-config`
- `/ridealong`
- `/ridealong-permissions`
- `/ridealong-config`
- `/rename`
- `/close`
- `/delete`

The default `LOG_GUILD_ID` is `1499578614298181642`.

## Departments

The supported departments are:

- USM
- SASP
- BCSO
- LSPD

FiveM writes the department into `duty_hours.department` when the player clocks in. Discord never asks the player to choose their department for the duty session.

## Duty hours

FiveM owns the `/duty` command. The Discord bot does not replace it.

When a new row appears in `duty_hours` with `outTime IS NULL`, the bot detects the clock-in and sends the user an `On Duty` DM.

When `outTime` is filled, the bot detects the clock-out, calculates the session, weekly Friday-to-Thursday total and Discord LEO voice coverage, then sends the `Off Duty` DM.

The bot tracks voice activity in these three LEO channels:

- `1542399560394088538`
- `1542399564588261446`
- `1542399567234994206`

Time in those channels counts as `In Voice`. Everything else during the duty session counts as `Out of Voice`.

`Voice Coverage = In Voice / Session Duration`.

## `/hours`

Use:

`/hours user:@User department:USM timeframe:This Week`

The user option is optional. Without it, the command checks the person running the command.

Timeframes:

- Last Week
- This Week
- This Month
- Last Month
- All Time

## `/evaluate`

Use:

`/evaluate user:@User department:USM`

The command compares the user's current Friday-to-Thursday department hours against that department's configured requirement. The requirement is stored with the global department settings key `requirement:USM`, `requirement:SASP`, `requirement:BCSO`, or `requirement:LSPD` and defaults to 8 hours.

## Report panel

Run `/officer-report-panel` in the log server after configuring the report system.

The panel presents:

- Officer Report
- Higher Up Report

The ticket collects department, incident date, in-game ID, clip, description and context. The officer being reported is optional and can be added later by the reports team with `/addofficer`.

## `/addofficer`

Reports staff can run:

`/addofficer user:@User`

or:

`/addofficer user_id:123456789012345678`

It updates the report embed with the officer being reported.

## Anonymous reports

Run `/anonreport` inside an existing report ticket.

The bot will:

1. Update the report data.
2. Clear the channel's messages.
3. Rename the channel to `anon-usm`, `anon-sasp`, `anon-bcso`, or `anon-lspd`.
4. Repost the report embed with the submitted clip, date, game ID, description and context.
5. Ping the configured department report role.

If `/anonreport` is run outside a report ticket, the bot creates a new anonymous report ticket in the log server.

## `/rename`

In a report ticket, `/rename` reads the report owner and renames the channel to:

`username-handling`

Example:

`teo-handling`

## Report permissions

All permission configuration is command based. No Discord role IDs are required in environment variables.

### `/admin-roles`

Add, remove, clear or view roles that count as bot administrators for that server.

### `/permissions`

Add, remove, clear or view roles allowed to run a specific command.

Example:

`/permissions action:Add command:hours role:@Supervisor`

### `/report-staff`

Configure the roles that can see and handle report tickets.

### `/ridealong-permissions`

Configure the roles that can log ride-alongs.

### `/report-config`

Select the report role ping for each department and the report ticket category.

### `/log-config`

Set:

- Report Logs
- Transcript Logs
- Ride-Along Logs

## Ride-alongs

`/ridealong` is only available in the log server.

Run it with:

`/ridealong player:@User department:USM result:Passed ridealong_role:@Completed notes:...`

The ride-along role is optional per command. You can also configure a default role with `/ridealong-config`.

The trainee role is configured with `/ridealong-config`.

When a ride-along is logged, the bot automatically removes the configured trainee role from the player if they have it. When the result is `Passed`, the selected/configured ride-along role is added.

Every ride-along is also written to `ridealongs` and posted to the configured Ride-Along Logs channel.

## Database

Run `schema.sql` on the same MySQL database used by FiveM.

The existing `duty_hours` table is preserved. The bot adds these tables:

- `duty_voice_segments`
- `bot_settings`
- `department_orgs`
- `org_hours_adjustments`
- `ridealongs`
- `reports`

## FiveM integration

This project includes `fivem-duty-adapter.lua` for `oxmysql`.

Do not create a second `/duty` command. Add the two calls to your existing duty resource.

### Clock in

After your existing department selection is known:

```lua
StartDuty(source, department)
```

`department` must be `USM`, `SASP`, `BCSO`, or `LSPD`.

### Clock out

In your existing clock-out branch:

```lua
EndDuty(source)
```

The adapter uses the player's FiveM `discord:` identifier and stores Unix timestamps in seconds.

If your existing `/duty` resource already writes the `duty_hours` table, you do not need the adapter at all. Just make sure:

- `discordId` is the Discord user ID only, not `discord:123...`
- `inTime` is Unix seconds
- `outTime` is Unix seconds when the shift ends
- `department` is one of the four supported department codes

If your server uses `mysql-async` instead of `oxmysql`, replace the adapter's MySQL calls with the equivalent functions from your current database resource.

## Railway

Set these variables:

- `DISCORD_TOKEN`
- `CLIENT_ID`
- `LOG_GUILD_ID`
- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DATABASE`
- `TIMEZONE`
- `DUTY_POLL_MS`
- `BOT_ADMINS`

Start command:

`node index.js`

Commands are registered globally. Discord can take some time to propagate global command changes.

## Discord bot permissions

The bot should have:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Manage Channels
- Manage Messages
- Manage Roles

The bot also needs the `Guild Members` and `Guild Voice States` privileged intents enabled in the Discord Developer Portal.


## Interaction handling
All slash commands acknowledge the Discord interaction before database work. A MySQL outage therefore does not leave commands stuck on `thinking`; commands return a database-unavailable message after a short timeout.

Anonymous report tickets remove the reporter from the channel and keep the reported user (when known), the department report role, and the configured reports staff roles.
