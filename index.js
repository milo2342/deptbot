require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
} = require('discord.js');
const mysql = require('mysql2/promise');
const { DateTime } = require('luxon');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const LOG_GUILD_ID = process.env.LOG_GUILD_ID || '1499578614298181642';
const TIMEZONE = process.env.TIMEZONE || 'Europe/London';
const DUTY_POLL_MS = Math.max(3000, Number(process.env.DUTY_POLL_MS || 5000));
const DB_OPERATION_TIMEOUT_MS = 6000;

const DEPARTMENTS = ['USM', 'SASP', 'BCSO', 'LSPD'];
const LEO_VOICE_CHANNELS = [
  '1542399560394088538',
  '1542399564588261446',
  '1542399567234994206',
];

const GLOBAL_COMMAND_NAMES = new Set();
const SERVER_ONLY_COMMANDS = new Set([
  'officer-report-panel',
  'anonreport',
  'addofficer',
  'reportadd',
  'report-config',
  'report-staff',
  'log-config',
  'rename',
  'close',
  'delete',
  'ridealong',
  'ridealong-permissions',
  'ridealong-config',
]);

const ADMIN_ONLY_COMMANDS = new Set([
  'bot-status',
  'admin-roles',
  'permissions',
  'report-config',
  'report-staff',
  'log-config',
  'ridealong-permissions',
  'ridealong-config',
  'officer-report-panel',
  'add_org',
  'add_org_hours',
  'rename_org',
]);

if (!TOKEN || !CLIENT_ID) {
  throw new Error('Missing DISCORD_TOKEN or CLIENT_ID.');
}

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 5000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const activeDuty = new Map();
const dbErrorState = { lastAt: 0, lastMessage: '' };
let dbOnline = false;
let dutyPollTimer = null;
let dbRetryTimer = null;

function now() {
  return Math.floor(Date.now() / 1000);
}

function localDateTime(ts) {
  return DateTime.fromSeconds(Number(ts), { zone: TIMEZONE });
}

function formatDateTime(ts) {
  return localDateTime(ts).toFormat('cccc, dd LLLL yyyy HH:mm');
}

function formatShort(ts) {
  return localDateTime(ts).toFormat('dd/MM/yyyy HH:mm');
}

function formatDuration(seconds) {
  let value = Math.max(0, Math.floor(Number(seconds || 0)));
  const days = Math.floor(value / 86400);
  value %= 86400;
  const hours = Math.floor(value / 3600);
  value %= 3600;
  const minutes = Math.floor(value / 60);
  const secs = value % 60;
  if (days) return `${days}d ${hours}h ${minutes}m ${secs}s`;
  if (hours) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function hoursText(seconds) {
  return `${(Math.max(0, Number(seconds || 0)) / 3600).toFixed(2)}h`;
}

function cleanName(value) {
  return String(value || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70) || 'user';
}

function parseIds(value) {
  return String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
}

function deptName(code) {
  return {
    USM: 'United States Marshals',
    SASP: 'San Andreas State Police',
    BCSO: "Blaine County Sheriff's Office",
    LSPD: 'Los Santos Police Department',
  }[code] || code;
}

function assertDepartment(value) {
  const department = String(value || '').trim().toUpperCase();
  return DEPARTMENTS.includes(department) ? department : null;
}

function isLeoVoice(channelId) {
  return Boolean(channelId && LEO_VOICE_CHANNELS.includes(channelId));
}

function settingKey(guildId, key) {
  return guildId ? `guild:${guildId}:${key}` : key;
}

function interactionCommandName(interaction) {
  if (interaction.commandName !== 'ridealong') return interaction.commandName;
  const group = interaction.options?.getSubcommandGroup(false);
  const sub = interaction.options?.getSubcommand(false);
  return group ? `ridealong ${group} ${sub}` : `ridealong ${sub}`;
}

function timeframeLabel(value) {
  return {
    last_week: 'Last Week',
    this_week: 'This Week',
    this_month: 'This Month',
    last_month: 'Last Month',
    all_time: 'All Time',
  }[value] || value;
}

function safeText(value, fallback = 'Not provided') {
  const text = String(value || '').trim();
  return text ? text.slice(0, 1024) : fallback;
}

async function dbQuery(sql, params = [], timeoutMs = DB_OPERATION_TIMEOUT_MS) {
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) {
    throw new Error('MySQL environment variables are not configured.');
  }

  let timer;
  const queryPromise = pool.execute(sql, params);
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Database operation timed out.')), timeoutMs);
  });

  try {
    const [rows] = await Promise.race([queryPromise, timeoutPromise]);
    dbOnline = true;
    return rows;
  } catch (error) {
    dbOnline = false;
    const message = error?.message || String(error);
    if (Date.now() - dbErrorState.lastAt > 10000 || dbErrorState.lastMessage !== message) {
      console.error(`DATABASE ERROR: ${message}`);
      dbErrorState.lastAt = Date.now();
      dbErrorState.lastMessage = message;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await dbQuery(statement, [], 8000);
}

async function getSetting(key, fallback = null, guildId = null) {
  const rows = await dbQuery(
    'SELECT settingValue FROM bot_settings WHERE settingKey=? LIMIT 1',
    [settingKey(guildId, key)]
  );
  return rows[0]?.settingValue ?? fallback;
}

async function setSetting(key, value, guildId = null) {
  await dbQuery(
    'INSERT INTO bot_settings (settingKey, settingValue) VALUES (?, ?) ON DUPLICATE KEY UPDATE settingValue=VALUES(settingValue)',
    [settingKey(guildId, key), String(value)]
  );
}

async function getJsonSetting(key, fallback, guildId = null) {
  try {
    const raw = await getSetting(key, JSON.stringify(fallback), guildId);
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function setJsonSetting(key, value, guildId = null) {
  return setSetting(key, JSON.stringify(value), guildId);
}

async function isAdmin(member) {
  if (!member) return false;
  if (parseIds(process.env.BOT_ADMINS).includes(member.id)) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  const roleIds = await getJsonSetting('adminRoles', [], member.guild.id);
  return roleIds.some((id) => member.roles.cache.has(id));
}

async function commandAllowed(member, commandName) {
  if (!member) return false;
  if (await isAdmin(member)) return true;
  const configured = await getJsonSetting(`cmdperm:${commandName}`, [], member.guild.id);
  if (!configured.length) return true;
  return configured.some((id) => member.roles.cache.has(id));
}

async function roleAllowed(member, settingName) {
  if (!member) return false;
  if (await isAdmin(member)) return true;
  const roleIds = await getJsonSetting(settingName, [], member.guild.id);
  return roleIds.some((id) => member.roles.cache.has(id));
}

async function ensureGuild(interaction) {
  if (interaction.guild) return true;
  await safeReply(interaction, { content: 'This command can only be used in a server.' });
  return false;
}

async function ensureLogServer(interaction) {
  if (!(await ensureGuild(interaction))) return false;
  if (interaction.guildId !== LOG_GUILD_ID) {
    await safeReply(interaction, { content: 'This command is only available in the reports and ride-along server.' });
    return false;
  }
  return true;
}

async function ensureAdmin(interaction) {
  if (!(await ensureGuild(interaction))) return false;
  try {
    if (await isAdmin(interaction.member)) return true;
  } catch (error) {
    await safeReply(interaction, { content: `Unable to check administrator roles because the database is unavailable: ${error.message}` });
    return false;
  }
  await safeReply(interaction, { content: 'Administrator permission required.' });
  return false;
}

async function ensureCommandAccess(interaction) {
  if (!(await ensureGuild(interaction))) return false;
  const name = interaction.commandName === 'ridealong'
    ? `ridealong ${interaction.options.getSubcommand(false)}`
    : interaction.commandName;
  try {
    if (!(await commandAllowed(interaction.member, name))) {
      await safeReply(interaction, { content: 'You do not have permission to use this command.' });
      return false;
    }
  } catch (error) {
    await safeReply(interaction, { content: `Unable to check command permissions because the database is unavailable: ${error.message}` });
    return false;
  }
  return true;
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred) return await interaction.editReply(payload);
    if (interaction.replied) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (error) {
    console.error(`Discord reply error: ${error.message}`);
    return null;
  }
}

async function safeDefer(interaction, ephemeral = false) {
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferReply({ ephemeral });
    return true;
  } catch (error) {
    console.error(`Discord defer error: ${error.message}`);
    return false;
  }
}

async function getDiscordUser(discordId) {
  const id = String(discordId || '').replace(/^discord:/, '').trim();
  if (!/^\d{17,20}$/.test(id)) return null;
  return client.users.fetch(id).catch((error) => {
    console.warn(`Unable to fetch Discord user ${id}: ${error.message}`);
    return null;
  });
}

function getUserDisplay(user) {
  return user?.globalName || user?.username || user?.id || 'User';
}

async function sendDM(user, embed) {
  if (!user) return false;
  try {
    await user.send({ embeds: [embed] });
    console.log(`DM sent to ${user.id}.`);
    return true;
  } catch (error) {
    console.warn(`Unable to DM ${user.id}: ${error.message}`);
    return false;
  }
}

function dutyOnEmbed({ user, department, inTime }) {
  return new EmbedBuilder()
    .setColor(0x2f9e44)
    .setTitle('On Duty')
    .setDescription(`You have clocked in for ${department}.`)
    .addFields(
      { name: 'Department', value: `${department} — ${deptName(department)}`, inline: false },
      { name: 'Clock In', value: formatDateTime(inTime), inline: true }
    )
    .setFooter({ text: `WCRP Department Utilities • ${formatShort(inTime)}` });
}

function dutyOffEmbed({ user, department, outTime, inTime, session, weekly, inVoice, outVoice, coverage, reason }) {
  return new EmbedBuilder()
    .setColor(0xe04f5f)
    .setTitle('Off Duty')
    .setDescription(`Thanks for your service, ${getUserDisplay(user)}.`)
    .addFields(
      { name: 'Reason', value: safeText(reason, 'Clock Out'), inline: false },
      { name: 'Clock Out', value: formatDateTime(outTime), inline: true },
      { name: 'Session', value: formatDuration(session), inline: true },
      { name: 'This Week (Fri-Thu)', value: hoursText(weekly.total), inline: true },
      { name: 'Week', value: `${weekly.startLabel} - ${weekly.endLabel}`, inline: true },
      { name: 'Department', value: `${department} — ${deptName(department)}`, inline: true },
      { name: 'In Voice', value: formatDuration(inVoice), inline: true },
      { name: 'Out of Voice', value: formatDuration(outVoice), inline: true },
      { name: 'Voice Coverage', value: `${coverage.toFixed(0)}%`, inline: true },
      { name: 'Clock In', value: formatDateTime(inTime), inline: false }
    )
    .setFooter({ text: `WCRP Department Utilities • ${formatShort(outTime)}` });
}

function getWeekWindow(ts = now()) {
  const current = localDateTime(ts);
  // Luxon weekday: Monday=1, Friday=5.
  const daysSinceFriday = (current.weekday - 5 + 7) % 7;
  const start = current.minus({ days: daysSinceFriday }).startOf('day');
  const end = start.plus({ days: 7 });
  return {
    start: Math.floor(start.toSeconds()),
    end: Math.floor(end.toSeconds()),
    startLabel: start.toFormat('LLL dd'),
    endLabel: end.minus({ days: 1 }).toFormat('LLL dd'),
    total: 0,
  };
}

function windowFor(value, ts = now()) {
  const current = localDateTime(ts);
  if (value === 'all_time') return { start: 0, end: 2147483647 };

  if (value === 'this_week' || !value) return getWeekWindow(ts);

  if (value === 'last_week') {
    const thisWeek = getWeekWindow(ts);
    return {
      start: thisWeek.start - 7 * 86400,
      end: thisWeek.start,
      startLabel: localDateTime(thisWeek.start - 7 * 86400).toFormat('LLL dd'),
      endLabel: localDateTime(thisWeek.start - 86400).toFormat('LLL dd'),
    };
  }

  if (value === 'this_month') {
    const start = current.startOf('month');
    const end = start.plus({ months: 1 });
    return {
      start: Math.floor(start.toSeconds()),
      end: Math.floor(end.toSeconds()),
      startLabel: start.toFormat('dd LLL yyyy'),
      endLabel: end.minus({ days: 1 }).toFormat('dd LLL yyyy'),
    };
  }

  if (value === 'last_month') {
    const start = current.startOf('month').minus({ months: 1 });
    const end = start.plus({ months: 1 });
    return {
      start: Math.floor(start.toSeconds()),
      end: Math.floor(end.toSeconds()),
      startLabel: start.toFormat('dd LLL yyyy'),
      endLabel: end.minus({ days: 1 }).toFormat('dd LLL yyyy'),
    };
  }

  return getWeekWindow(ts);
}

async function totalDutySeconds({ discordId, department, window }) {
  const rows = await dbQuery(
    `SELECT COALESCE(SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))), 0) AS seconds
     FROM duty_hours
     WHERE discordId=? AND department=? AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ?`,
    [window.end, window.start, discordId, department, window.end, window.start]
  );
  return Number(rows[0]?.seconds || 0);
}

async function getVoiceSeconds(dutyId, inTime, outTime) {
  const rows = await dbQuery(
    `SELECT COALESCE(SUM(GREATEST(0, LEAST(COALESCE(outTime, ?), ?) - GREATEST(inTime, ?))), 0) AS seconds
     FROM duty_voice_segments
     WHERE dutyId=? AND isLeoVoice=1 AND inTime < ? AND COALESCE(outTime, ?) > ?`,
    [outTime, outTime, inTime, dutyId, outTime, outTime, inTime]
  );
  return Number(rows[0]?.seconds || 0);
}

async function getWeeklySummary(discordId, department, ts = now()) {
  const window = getWeekWindow(ts);
  const total = await totalDutySeconds({ discordId, department, window });
  return { ...window, total };
}

async function startVoiceSegmentForUser(duty, channelId, startTime = now()) {
  await dbQuery(
    `INSERT INTO duty_voice_segments (dutyId, discordId, channelId, inTime, outTime, isLeoVoice)
     VALUES (?, ?, ?, ?, NULL, ?)`,
    [duty.id, duty.discordId, channelId || null, startTime, isLeoVoice(channelId) ? 1 : 0]
  );
}

async function closeOpenVoiceSegment(dutyId, outTime = now()) {
  await dbQuery(
    'UPDATE duty_voice_segments SET outTime=? WHERE dutyId=? AND outTime IS NULL',
    [outTime, dutyId]
  );
}

async function changeVoiceSegment(duty, oldChannelId, newChannelId, ts = now()) {
  if (!duty) return;
  await closeOpenVoiceSegment(duty.id, ts);
  await startVoiceSegmentForUser(duty, newChannelId, ts);
}

function buildDutyMapKey(row) {
  return String(row.id);
}

async function handleDutyClockIn(row) {
  const key = buildDutyMapKey(row);
  if (activeDuty.has(key)) return;

  const duty = {
    id: Number(row.id),
    discordId: String(row.discordId),
    department: assertDepartment(row.department) || String(row.department || 'Unknown'),
    inTime: Number(row.inTime),
  };

  activeDuty.set(key, duty);

  const user = await getDiscordUser(duty.discordId);
  await sendDM(user, dutyOnEmbed({ user, department: duty.department, inTime: duty.inTime }));

  const guilds = [...client.guilds.cache.values()];
  for (const guild of guilds) {
    const member = await guild.members.fetch(duty.discordId).catch(() => null);
    if (member?.voice?.channelId) {
      await startVoiceSegmentForUser(duty, member.voice.channelId, Math.max(duty.inTime, now())).catch(() => {});
      break;
    }
  }
}

async function handleDutyClockOut(row) {
  const rowId = buildDutyMapKey(row);
  const rowIdNumber = Number(row.id);
  const duty = activeDuty.get(rowId) || {
    id: rowIdNumber,
    discordId: String(row.discordId),
    department: assertDepartment(row.department) || String(row.department || 'Unknown'),
    inTime: Number(row.inTime),
  };
  const outTime = Number(row.outTime || now());
  const session = Math.max(0, outTime - Number(row.inTime));

  await closeOpenVoiceSegment(rowIdNumber, outTime).catch(() => {});
  const inVoice = Math.min(session, await getVoiceSeconds(rowIdNumber, Number(row.inTime), outTime).catch(() => 0));
  const outVoice = Math.max(0, session - inVoice);
  const coverage = session > 0 ? (inVoice / session) * 100 : 0;
  const weekly = await getWeeklySummary(String(row.discordId), duty.department, outTime).catch(() => ({ ...getWeekWindow(outTime), total: 0 }));

  const user = await getDiscordUser(row.discordId);
  await sendDM(user, dutyOffEmbed({
    user,
    department: duty.department,
    outTime,
    inTime: Number(row.inTime),
    session,
    weekly,
    inVoice,
    outVoice,
    coverage,
    reason: row.reason || 'Clock Out',
  }));

  activeDuty.delete(rowId);
}

async function pollDuty() {
  try {
    const openRows = await dbQuery(
      'SELECT * FROM duty_hours WHERE outTime IS NULL AND inTime IS NOT NULL AND discordId IS NOT NULL ORDER BY id ASC',
      []
    );

    const seen = new Set();
    for (const row of openRows) {
      const key = buildDutyMapKey(row);
      seen.add(key);
      await handleDutyClockIn(row);
    }

    const completedRows = await dbQuery(
      'SELECT * FROM duty_hours WHERE outTime IS NOT NULL AND outTime >= ? ORDER BY outTime ASC',
      [now() - 120]
    );

    for (const row of completedRows) {
      const key = buildDutyMapKey(row);
      if (activeDuty.has(key)) await handleDutyClockOut(row);
    }

    for (const [key, duty] of activeDuty.entries()) {
      if (!seen.has(key)) {
        await closeOpenVoiceSegment(duty.id).catch(() => {});
        activeDuty.delete(key);
      }
    }

    dbOnline = true;
  } catch (error) {
    dbOnline = false;
    console.error(`Duty poll error: ${error.message}`);
  }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  const discordId = String(newState.id || oldState.id);
  const duty = [...activeDuty.values()].find((item) => item.discordId === discordId);
  if (!duty) return;
  if (oldState.channelId === newState.channelId) return;

  try {
    await changeVoiceSegment(duty, oldState.channelId, newState.channelId, now());
  } catch (error) {
    console.error(`Voice tracking error for ${discordId}: ${error.message}`);
  }
});

function deptChoices() {
  return DEPARTMENTS.map((value) => ({ name: value, value }));
}

const timeframeChoices = [
  { name: 'Last Week', value: 'last_week' },
  { name: 'This Week', value: 'this_week' },
  { name: 'This Month', value: 'this_month' },
  { name: 'Last Month', value: 'last_month' },
  { name: 'All Time', value: 'all_time' },
];

function addDepartmentOption(command, required = true) {
  return command.addStringOption((option) =>
    option.setName('department')
      .setDescription('Department')
      .setRequired(required)
      .addChoices(...deptChoices())
  );
}

const commands = [
  new SlashCommandBuilder().setName('hours').setDescription('Check duty hours for yourself or another user')
    .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(true).addChoices(...deptChoices()))
    .addStringOption((o) => o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...timeframeChoices))
    .addUserOption((o) => o.setName('user').setDescription('Exact person to check').setRequired(false)),

  new SlashCommandBuilder().setName('allhours').setDescription('Show hours for everyone in a department')
    .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(true).addChoices(...deptChoices()))
    .addStringOption((o) => o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...timeframeChoices)),

  new SlashCommandBuilder().setName('totalhours').setDescription('Get total hours for a department')
    .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(true).addChoices(...deptChoices()))
    .addStringOption((o) => o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...timeframeChoices)),

  new SlashCommandBuilder().setName('weeklydeptours').setDescription('Get department hours for a selected time frame')
    .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(true).addChoices(...deptChoices()))
    .addStringOption((o) => o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...timeframeChoices)),

  new SlashCommandBuilder().setName('deptofhours').setDescription('Show the top people in a department by hours')
    .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(true).addChoices(...deptChoices()))
    .addStringOption((o) => o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...timeframeChoices)),

  new SlashCommandBuilder().setName('tophours').setDescription('Show the top users by all-time hours'),

  new SlashCommandBuilder().setName('leaderboard').setDescription('Show a department leaderboard')
    .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(true).addChoices(...deptChoices()))
    .addStringOption((o) => o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...timeframeChoices)),

  new SlashCommandBuilder().setName('evaluate').setDescription('Evaluate a user against the weekly requirement')
    .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(true).addChoices(...deptChoices()))
    .addUserOption((o) => o.setName('user').setDescription('Person to evaluate').setRequired(false)),

  new SlashCommandBuilder().setName('inactive_officers').setDescription('Show inactive department officers')
    .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(true).addChoices(...deptChoices()))
    .addIntegerOption((o) => o.setName('weeks_back').setDescription('Inactivity threshold in weeks').setRequired(false).addChoices({ name: '2 weeks', value: 2 }, { name: '4 weeks', value: 4 })),

  new SlashCommandBuilder().setName('dept_officers').setDescription('Show department officers by activity status')
    .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(true).addChoices(...deptChoices()))
    .addIntegerOption((o) => o.setName('weeks_back').setDescription('Inactivity threshold in weeks').setRequired(false).addChoices({ name: '2 weeks', value: 2 }, { name: '4 weeks', value: 4 })),

  new SlashCommandBuilder().setName('promotions').setDescription('List promotion eligible department officers')
    .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(true).addChoices(...deptChoices()))
    .addIntegerOption((o) => o.setName('min_hours').setDescription('Minimum hours').setRequired(false).setMinValue(0)),

  new SlashCommandBuilder().setName('leomulti').setDescription('Start a temporary hour multiplier')
    .addIntegerOption((o) => o.setName('duration_minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(10080))
    .addNumberOption((o) => o.setName('multiplier').setDescription('Multiplier').setRequired(false).setMinValue(0.1).setMaxValue(10)),

  new SlashCommandBuilder().setName('add_org').setDescription('Admin: add an organisation')
    .addStringOption((o) => o.setName('code').setDescription('Organisation code').setRequired(true))
    .addStringOption((o) => o.setName('name').setDescription('Organisation name').setRequired(true)),

  new SlashCommandBuilder().setName('add_org_hours').setDescription('Admin: add hours to an organisation total')
    .addStringOption((o) => o.setName('code').setDescription('Organisation code').setRequired(true))
    .addNumberOption((o) => o.setName('hours').setDescription('Hours to add').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('rename_org').setDescription('Admin: rename an organisation')
    .addStringOption((o) => o.setName('old_code').setDescription('Old code').setRequired(true))
    .addStringOption((o) => o.setName('new_code').setDescription('New code').setRequired(true))
    .addStringOption((o) => o.setName('name').setDescription('New organisation name').setRequired(true)),

  new SlashCommandBuilder().setName('admin-roles').setDescription('Admin: configure administrator roles')
    .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices(
      { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
    ))
    .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(false)),

  new SlashCommandBuilder().setName('permissions').setDescription('Admin: configure command permissions')
    .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices(
      { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
    ))
    .addStringOption((o) => o.setName('command').setDescription('Command name').setRequired(true))
    .addRoleOption((o) => o.setName('role').setDescription('Allowed role').setRequired(false)),

  new SlashCommandBuilder().setName('bot-status').setDescription('Admin: show bot and database status'),

  new SlashCommandBuilder().setName('officer-report-panel').setDescription('Admin: post the officer report panel'),

  new SlashCommandBuilder().setName('anonreport').setDescription('Convert the current report into an anonymous report or create one')
    .addStringOption((o) => o.setName('department').setDescription('Department if creating a report').setRequired(false).addChoices(...deptChoices()))
    .addStringOption((o) => o.setName('date').setDescription('Date of incident override').setRequired(false))
    .addStringOption((o) => o.setName('game_id').setDescription('In-game ID override').setRequired(false))
    .addStringOption((o) => o.setName('clip').setDescription('Clip URL override').setRequired(false))
    .addStringOption((o) => o.setName('description').setDescription('Description override').setRequired(false))
    .addStringOption((o) => o.setName('context').setDescription('Additional context override').setRequired(false)),

  new SlashCommandBuilder().setName('addofficer').setDescription('Reports team: set the person being reported')
    .addUserOption((o) => o.setName('user').setDescription('Reported user').setRequired(false))
    .addStringOption((o) => o.setName('user_id').setDescription('Reported Discord user ID').setRequired(false)),

  new SlashCommandBuilder().setName('reportadd').setDescription('Reports team: create a report ticket')
    .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(true).addChoices(...deptChoices()))
    .addStringOption((o) => o.setName('date').setDescription('Date of incident').setRequired(false))
    .addStringOption((o) => o.setName('game_id').setDescription('In-game ID').setRequired(false))
    .addStringOption((o) => o.setName('clip').setDescription('Clip URL').setRequired(false))
    .addStringOption((o) => o.setName('description').setDescription('Description').setRequired(false))
    .addStringOption((o) => o.setName('context').setDescription('Additional context').setRequired(false))
    .addUserOption((o) => o.setName('officer').setDescription('Officer being reported').setRequired(false)),

  new SlashCommandBuilder().setName('report-config').setDescription('Admin: configure report department roles and category')
    .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(false).addChoices(...deptChoices()))
    .addRoleOption((o) => o.setName('role').setDescription('Role pinged for that department').setRequired(false))
    .addChannelOption((o) => o.setName('category').setDescription('Report ticket category').setRequired(false).addChannelTypes(ChannelType.GuildCategory)),

  new SlashCommandBuilder().setName('report-staff').setDescription('Admin: configure report handling roles')
    .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices(
      { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
    ))
    .addRoleOption((o) => o.setName('role').setDescription('Reports handling role').setRequired(false)),

  new SlashCommandBuilder().setName('log-config').setDescription('Admin: configure report, transcript and ride-along log channels')
    .addStringOption((o) => o.setName('type').setDescription('Log type').setRequired(true).addChoices(
      { name: 'Report Logs', value: 'report_log' }, { name: 'Transcript Logs', value: 'transcript_log' }, { name: 'Ride-Along Logs', value: 'ridealong_log' }
    ))
    .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(false).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder().setName('ridealong-permissions').setDescription('Admin: configure ride-along logging roles')
    .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices(
      { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
    ))
    .addRoleOption((o) => o.setName('role').setDescription('Role allowed to log ride-alongs').setRequired(false)),

  new SlashCommandBuilder().setName('ridealong-config').setDescription('Admin: configure ride-along and trainee roles')
    .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices(
      { name: 'Set', value: 'set' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
    ))
    .addRoleOption((o) => o.setName('ridealong_role').setDescription('Role assigned on a passed ride-along').setRequired(false))
    .addRoleOption((o) => o.setName('trainee_role').setDescription('Role removed when a ride-along is logged').setRequired(false)),

  new SlashCommandBuilder().setName('ridealong').setDescription('Ride-along tools')
    .addSubcommand((sub) => sub.setName('log').setDescription('Log a ride-along result')
      .addUserOption((o) => o.setName('player').setDescription('Trainee').setRequired(true))
      .addStringOption((o) => o.setName('department').setDescription('Department').setRequired(true).addChoices(...deptChoices()))
      .addStringOption((o) => o.setName('result').setDescription('Result').setRequired(true).addChoices({ name: 'Passed', value: 'Passed' }, { name: 'Failed', value: 'Failed' }))
      .addRoleOption((o) => o.setName('ridealong_role').setDescription('Optional role to assign on pass').setRequired(false))
      .addStringOption((o) => o.setName('notes').setDescription('Notes').setRequired(false)))
    .addSubcommand((sub) => sub.setName('role').setDescription('View or set the ride-along roles')
      .addRoleOption((o) => o.setName('ridealong_role').setDescription('Role assigned on pass').setRequired(false))
      .addRoleOption((o) => o.setName('trainee_role').setDescription('Role removed on log').setRequired(false))),

  new SlashCommandBuilder().setName('rename').setDescription('Rename a report ticket to username-handling'),
  new SlashCommandBuilder().setName('close').setDescription('Close a report ticket'),
  new SlashCommandBuilder().setName('delete').setDescription('Delete a report ticket and save a transcript'),
].map((c) => c.setDMPermission(false));

for (const command of commands) GLOBAL_COMMAND_NAMES.add(command.name);

function reportPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x496c8e)
    .setTitle('Submit a Report')
    .setDescription('Select the type of report you want to submit. The next form will ask for the department, date, clip and incident details.')
    .addFields(
      { name: 'Officer Report', value: 'Report misconduct or rule violations by a department officer.', inline: true },
      { name: 'Higher Up Report', value: 'Report misconduct by command staff or senior leadership.', inline: true }
    )
    .setFooter({ text: 'WCRP Department Utilities' });
}

function reportPanelRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('report_type')
      .setPlaceholder('Select report type')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Officer Report').setDescription('Report a department officer').setValue('officer'),
        new StringSelectMenuOptionBuilder().setLabel('Higher Up Report').setDescription('Report command or senior leadership').setValue('higher')
      )
  );
}

function reportFormModal(type) {
  return new ModalBuilder()
    .setCustomId(`report_modal:${type}`)
    .setTitle(type === 'higher' ? 'Higher Up Report' : 'Officer Report')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('department').setLabel('Department').setPlaceholder('USM / SASP / BCSO / LSPD').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Date of incident').setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('clip').setLabel('Clip URL').setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('game_id').setLabel('In-game ID').setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Description and context').setStyle(TextInputStyle.Paragraph).setRequired(false))
    );
}

function buildReportEmbed({ anonymous, type, department, dateOfIncident, gameId, reportedUserId, clip, description, context }) {
  return new EmbedBuilder()
    .setColor(type === 'higher' ? 0x6d5dfc : 0x496c8e)
    .setTitle(anonymous ? 'Anonymous Report' : (type === 'higher' ? 'Higher Up Report' : 'Officer Report'))
    .addFields(
      { name: 'Department', value: `${department} — ${deptName(department)}`, inline: false },
      { name: 'Date of Incident', value: safeText(dateOfIncident), inline: true },
      { name: 'In-Game ID', value: safeText(gameId), inline: true },
      { name: 'Officer Being Reported', value: reportedUserId ? `<@${reportedUserId}> (${reportedUserId})` : 'Not provided', inline: false },
      { name: 'Clip', value: safeText(clip), inline: false },
      { name: 'Description', value: safeText(description), inline: false },
      { name: 'Additional Context', value: safeText(context), inline: false }
    )
    .setFooter({ text: `WCRP Department Utilities • ${formatShort(now())}` });
}

async function getReportByChannel(channelId) {
  const rows = await dbQuery('SELECT * FROM reports WHERE channelId=? LIMIT 1', [channelId]);
  return rows[0] || null;
}

async function getReportStaffRoleIds(guildId) {
  return getJsonSetting('reportStaffRoles', [], guildId);
}

async function ensureReportStaff(member) {
  if (await isAdmin(member)) return true;
  const roleIds = await getReportStaffRoleIds(member.guild.id);
  return roleIds.some((id) => member.roles.cache.has(id));
}

async function getDepartmentReportRoleIds(guildId, department) {
  return getJsonSetting(`reportRoles:${department}`, [], guildId);
}

async function createReportTicket({
  interaction,
  type,
  department,
  anonymous,
  dateOfIncident,
  gameId,
  clip,
  description,
  context,
  reportedUserId = null,
}) {
  const guild = interaction.guild;
  const departmentRoles = await getDepartmentReportRoleIds(guild.id, department);
  const staffRoles = await getReportStaffRoleIds(guild.id);
  const categoryId = await getSetting('reportCategoryId', null, guild.id);

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
  ];

  if (!anonymous) {
    overwrites.push({
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  if (anonymous && reportedUserId) {
    overwrites.push({
      id: reportedUserId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  for (const roleId of [...new Set([...departmentRoles, ...staffRoles])]) {
    if (guild.roles.cache.has(roleId)) {
      overwrites.push({
        id: roleId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      });
    }
  }

  const channel = await guild.channels.create({
    name: anonymous ? `anon-${department.toLowerCase()}` : `report-${department.toLowerCase()}-${cleanName(interaction.member.displayName || interaction.user.username)}`,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites: overwrites,
  });

  await dbQuery(
    `INSERT INTO reports (channelId,ticketType,department,reporterId,reportedUserId,dateOfIncident,gameId,clip,description,context,anonymous,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [channel.id, type, department, interaction.user.id, reportedUserId, dateOfIncident || null, gameId || null, clip || null, description || null, context || null, anonymous ? 1 : 0, now()]
  );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('report_close').setLabel('Close').setStyle(ButtonStyle.Danger)
  );

  const roleMentions = departmentRoles.map((id) => `<@&${id}>`).join(' ');
  await channel.send({
    content: roleMentions || undefined,
    embeds: [buildReportEmbed({ anonymous, type, department, dateOfIncident, gameId, reportedUserId, clip, description, context })],
    components: [buttonRow],
  });

  const reportLogId = await getSetting('reportLogChannelId', null, guild.id);
  if (reportLogId) {
    const logChannel = guild.channels.cache.get(reportLogId);
    if (logChannel) {
      await logChannel.send({
        embeds: [new EmbedBuilder().setColor(0x496c8e).setTitle('Report Created').addFields(
          { name: 'Type', value: type === 'higher' ? 'Higher Up Report' : 'Officer Report', inline: true },
          { name: 'Department', value: department, inline: true },
          { name: 'Ticket', value: `${channel}`, inline: true },
          { name: 'Anonymous', value: anonymous ? 'Yes' : 'No', inline: true }
        ).setFooter({ text: `Created ${formatShort(now())}` })]
      }).catch(() => {});
    }
  }

  if (!anonymous) {
    const confirmation = new EmbedBuilder()
      .setColor(0x496c8e)
      .setTitle('Report Submitted')
      .setDescription(`Your report has been submitted and assigned to ${channel}.`)
      .addFields(
        { name: 'Department', value: department, inline: true },
        { name: 'Type', value: type === 'higher' ? 'Higher Up Report' : 'Officer Report', inline: true }
      )
      .setFooter({ text: `WCRP Department Utilities • ${formatShort(now())}` });
    await sendDM(interaction.user, confirmation);
  }

  return channel;
}

async function clearChannel(channel) {
  for (let round = 0; round < 30; round += 1) {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages?.size) break;
    for (const message of messages.values()) await message.delete().catch(() => {});
    if (messages.size < 100) break;
  }
}

async function updateReportMessage(channel, report) {
  const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const botMessages = fetched ? [...fetched.values()].filter((m) => m.author.id === client.user.id && m.embeds.length) : [];
  const embed = buildReportEmbed({
    anonymous: Boolean(report.anonymous),
    type: report.ticketType,
    department: report.department,
    dateOfIncident: report.dateOfIncident,
    gameId: report.gameId,
    reportedUserId: report.reportedUserId,
    clip: report.clip,
    description: report.description,
    context: report.context,
  });
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('report_close').setLabel('Close').setStyle(ButtonStyle.Danger)
  );
  if (botMessages.length) {
    await botMessages[botMessages.length - 1].edit({ embeds: [embed], components: [buttonRow] }).catch(() => {});
  } else {
    await channel.send({ embeds: [embed], components: [buttonRow] }).catch(() => {});
  }
}

async function makeTranscript(channel) {
  const all = [];
  let before;
  for (let i = 0; i < 30; i += 1) {
    const messages = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!messages?.size) break;
    all.push(...messages.values());
    before = messages.last().id;
    if (messages.size < 100) break;
  }
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return all.map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content || '[embed/attachment]'}`).join('\n');
}

async function handleHours(interaction) {
  const department = assertDepartment(interaction.options.getString('department'));
  const timeframe = interaction.options.getString('timeframe') || 'this_week';
  const target = interaction.options.getUser('user') || interaction.user;
  const window = windowFor(timeframe);

  const total = await totalDutySeconds({ discordId: target.id, department, window });
  const embed = new EmbedBuilder()
    .setColor(0x496c8e)
    .setTitle('Duty Hours')
    .addFields(
      { name: 'Member', value: `<@${target.id}>`, inline: true },
      { name: 'Department', value: department, inline: true },
      { name: 'Time Frame', value: timeframeLabel(timeframe), inline: true },
      { name: 'Total Hours', value: hoursText(total), inline: false }
    )
    .setFooter({ text: `WCRP Department Utilities • ${window.startLabel || ''} - ${window.endLabel || ''}` });

  return interaction.editReply({ embeds: [embed] });
}

async function handleDepartmentList(interaction, mode) {
  const department = assertDepartment(interaction.options.getString('department'));
  const timeframe = interaction.options.getString('timeframe') || 'this_week';
  const window = windowFor(timeframe);

  const rows = await dbQuery(
    `SELECT discordId,
      SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))) AS seconds
     FROM duty_hours
     WHERE department=? AND discordId IS NOT NULL AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ?
     GROUP BY discordId ORDER BY seconds DESC`,
    [window.end, window.start, department, window.end, window.start]
  );

  let embed;
  if (mode === 'total') {
    const total = rows.reduce((sum, row) => sum + Number(row.seconds || 0), 0);
    embed = new EmbedBuilder().setColor(0x496c8e).setTitle(`${department} Total Hours`).addFields(
      { name: 'Time Frame', value: timeframeLabel(timeframe), inline: true },
      { name: 'Total', value: hoursText(total), inline: true }
    );
  } else {
    const limit = mode === 'allhours' ? 25 : 10;
    const description = rows.slice(0, limit).length
      ? rows.slice(0, limit).map((row, index) => `${index + 1}. <@${row.discordId}> — ${hoursText(row.seconds)}`).join('\n')
      : 'No recorded hours.';
    const title = mode === 'leaderboard' || mode === 'deptofhours' ? `${department} Leaderboard` : `${department} Hours`;
    embed = new EmbedBuilder().setColor(0x496c8e).setTitle(title).setDescription(description).setFooter({ text: timeframeLabel(timeframe) });
  }
  return interaction.editReply({ embeds: [embed] });
}

async function handleEvaluate(interaction) {
  const department = assertDepartment(interaction.options.getString('department'));
  const user = interaction.options.getUser('user') || interaction.user;
  const window = getWeekWindow();
  const requirement = Number(await getSetting(`requirement:${department}`, '8'));
  const total = await totalDutySeconds({ discordId: user.id, department, window });
  const requiredSeconds = requirement * 3600;
  const remaining = Math.max(0, requiredSeconds - total);
  const met = total >= requiredSeconds;

  return interaction.editReply({ embeds: [
    new EmbedBuilder().setColor(met ? 0x2f9e44 : 0xe04f5f).setTitle(`${department} Weekly Evaluation`).addFields(
      { name: 'Member', value: `<@${user.id}>`, inline: true },
      { name: 'Hours Worked', value: hoursText(total), inline: true },
      { name: 'Required', value: `${requirement.toFixed(2)}h`, inline: true },
      { name: 'Status', value: met ? 'Requirement Met' : 'Below Requirement', inline: true },
      { name: 'Remaining', value: hoursText(remaining), inline: true },
      { name: 'Week', value: `${window.startLabel} - ${window.endLabel}`, inline: true }
    )]
  });
}

async function handleCommand(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const commandName = interactionCommandName(interaction);

  if (!(await ensureGuild(interaction))) return;

  if (SERVER_ONLY_COMMANDS.has(interaction.commandName) && interaction.guildId !== LOG_GUILD_ID) {
    await safeReply(interaction, { content: 'This command is only available in the configured reports and ride-along server.' });
    return;
  }

  if (!(await safeDefer(interaction, false))) return;

  try {
    if (!ADMIN_ONLY_COMMANDS.has(interaction.commandName) && !SERVER_ONLY_COMMANDS.has(interaction.commandName)) {
      const allowed = await commandAllowed(interaction.member, commandName);
      if (!allowed) {
        await interaction.editReply({ content: 'You do not have permission to use this command.' });
        return;
      }
    }

    if (ADMIN_ONLY_COMMANDS.has(interaction.commandName) && !(await isAdmin(interaction.member))) {
      await interaction.editReply({ content: 'Administrator permission required.' });
      return;
    }

    if (interaction.commandName === 'ridealong' && interaction.options.getSubcommand(false) === 'log') {
      if (!(await roleAllowed(interaction.member, 'ridealongRoles'))) {
        await interaction.editReply({ content: 'You do not have permission to log ride-alongs.' });
        return;
      }
      const player = interaction.options.getUser('player');
      const department = assertDepartment(interaction.options.getString('department'));
      const result = interaction.options.getString('result');
      const selectedRole = interaction.options.getRole('ridealong_role');
      const notes = interaction.options.getString('notes');
      const configuredRoleId = await getSetting('ridealongResultRoleId', null, interaction.guild.id);
      const traineeRoleId = await getSetting('traineeRoleId', null, interaction.guild.id);
      const roleId = selectedRole?.id || configuredRoleId || null;
      const member = await interaction.guild.members.fetch(player.id).catch(() => null);

      if (member && traineeRoleId && member.roles.cache.has(traineeRoleId)) {
        await member.roles.remove(traineeRoleId, `Ride-along logged by ${interaction.user.tag}`).catch((error) => console.warn(`Unable to remove trainee role: ${error.message}`));
      }
      if (member && result === 'Passed' && roleId) {
        await member.roles.add(roleId, `Ride-along passed and logged by ${interaction.user.tag}`).catch((error) => console.warn(`Unable to assign ride-along role: ${error.message}`));
      }

      await dbQuery(
        'INSERT INTO ridealongs (discordId,department,ridealongRoleId,result,notes,createdBy,createdAt) VALUES (?,?,?,?,?,?,?)',
        [player.id, department, roleId, result, notes || null, interaction.user.id, now()]
      );

      const logChannelId = await getSetting('ridealongLogChannelId', null, interaction.guild.id);
      const logChannel = logChannelId ? interaction.guild.channels.cache.get(logChannelId) : null;
      const embed = new EmbedBuilder().setColor(result === 'Passed' ? 0x2f9e44 : 0xe04f5f).setTitle('Ride-Along Log').addFields(
        { name: 'Player', value: `<@${player.id}>`, inline: true },
        { name: 'Department', value: department, inline: true },
        { name: 'Result', value: result, inline: true },
        { name: 'Ride-Along Role', value: roleId ? `<@&${roleId}>` : 'Not configured', inline: true },
        { name: 'Trainee Role', value: traineeRoleId ? `<@&${traineeRoleId}> removed if present` : 'Not configured', inline: true },
        { name: 'Notes', value: safeText(notes, 'None'), inline: false },
        { name: 'Logged By', value: `<@${interaction.user.id}>`, inline: true }
      ).setFooter({ text: `WCRP Department Utilities • ${formatShort(now())}` });
      if (logChannel) await logChannel.send({ embeds: [embed] }).catch(() => {});
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (interaction.commandName === 'ridealong' && interaction.options.getSubcommand(false) === 'role') {
      const rideRole = interaction.options.getRole('ridealong_role');
      const traineeRole = interaction.options.getRole('trainee_role');
      if (rideRole) await setSetting('ridealongResultRoleId', rideRole.id, interaction.guild.id);
      if (traineeRole) await setSetting('traineeRoleId', traineeRole.id, interaction.guild.id);
      const currentRide = await getSetting('ridealongResultRoleId', null, interaction.guild.id);
      const currentTrainee = await getSetting('traineeRoleId', null, interaction.guild.id);
      await interaction.editReply({ content: `Ride-along role: ${currentRide ? `<@&${currentRide}>` : 'Not configured'}\nTrainee role: ${currentTrainee ? `<@&${currentTrainee}>` : 'Not configured'}` });
      return;
    }

    if (interaction.commandName === 'bot-status') {
      let dbStatus = 'Offline';
      let dbMessage = 'Not checked';
      try {
        await dbQuery('SELECT 1 AS ok');
        dbStatus = 'Online';
        dbMessage = 'Database connection is responding.';
      } catch (error) {
        dbMessage = error.message;
      }
      await interaction.editReply({ embeds: [
        new EmbedBuilder().setColor(dbStatus === 'Online' ? 0x2f9e44 : 0xe04f5f).setTitle('WCRP Department Utilities Status').addFields(
          { name: 'Bot', value: client.ws.status === 0 ? 'Online' : 'Degraded', inline: true },
          { name: 'Global Commands', value: String(commands.length), inline: true },
          { name: 'Database', value: dbStatus, inline: true },
          { name: 'Database Details', value: safeText(dbMessage), inline: false },
          { name: 'Reports/Ride-Alongs Server', value: LOG_GUILD_ID, inline: false }
        ).setFooter({ text: `WCRP Department Utilities • ${formatShort(now())}` })
      ] });
      return;
    }

    if (interaction.commandName === 'officer-report-panel') {
      await interaction.channel.send({ embeds: [reportPanelEmbed()], components: [reportPanelRow()] });
      await interaction.editReply({ content: 'Report panel posted.' });
      return;
    }

    if (interaction.commandName === 'admin-roles') {
      const action = interaction.options.getString('action');
      const role = interaction.options.getRole('role');
      let roles = await getJsonSetting('adminRoles', [], interaction.guild.id);
      if (action === 'view') {
        await interaction.editReply({ content: `Administrator roles: ${roles.length ? roles.map((id) => `<@&${id}>`).join(', ') : 'None'}` });
        return;
      }
      if (action === 'add' && role) roles = [...new Set([...roles, role.id])];
      if (action === 'remove' && role) roles = roles.filter((id) => id !== role.id);
      if (action === 'clear') roles = [];
      await setJsonSetting('adminRoles', roles, interaction.guild.id);
      await interaction.editReply({ content: `Administrator roles: ${roles.length ? roles.map((id) => `<@&${id}>`).join(', ') : 'None'}` });
      return;
    }

    if (interaction.commandName === 'permissions') {
      const action = interaction.options.getString('action');
      const command = interaction.options.getString('command').toLowerCase().replace(/^\//, '');
      const role = interaction.options.getRole('role');
      let roles = await getJsonSetting(`cmdperm:${command}`, [], interaction.guild.id);
      if (action === 'view') {
        await interaction.editReply({ content: `${command}: ${roles.length ? roles.map((id) => `<@&${id}>`).join(', ') : 'Everyone'}` });
        return;
      }
      if (action === 'add' && role) roles = [...new Set([...roles, role.id])];
      if (action === 'remove' && role) roles = roles.filter((id) => id !== role.id);
      if (action === 'clear') roles = [];
      await setJsonSetting(`cmdperm:${command}`, roles, interaction.guild.id);
      await interaction.editReply({ content: `${command}: ${roles.length ? roles.map((id) => `<@&${id}>`).join(', ') : 'Everyone'}` });
      return;
    }

    if (interaction.commandName === 'report-config') {
      const department = interaction.options.getString('department')?.toUpperCase();
      const role = interaction.options.getRole('role');
      const category = interaction.options.getChannel('category');
      if (department && role) await setJsonSetting(`reportRoles:${department}`, [role.id], interaction.guild.id);
      if (category) await setSetting('reportCategoryId', category.id, interaction.guild.id);
      const lines = [];
      for (const dep of DEPARTMENTS) {
        const ids = await getJsonSetting(`reportRoles:${dep}`, [], interaction.guild.id);
        lines.push(`${dep}: ${ids.length ? ids.map((id) => `<@&${id}>`).join(', ') : 'Not configured'}`);
      }
      const categoryId = await getSetting('reportCategoryId', null, interaction.guild.id);
      lines.push(`Category: ${categoryId ? `<#${categoryId}>` : 'Not configured'}`);
      await interaction.editReply({ content: lines.join('\n') });
      return;
    }

    if (interaction.commandName === 'report-staff' || interaction.commandName === 'ridealong-permissions') {
      const isRide = interaction.commandName === 'ridealong-permissions';
      const action = interaction.options.getString('action');
      const role = interaction.options.getRole('role');
      const key = isRide ? 'ridealongRoles' : 'reportStaffRoles';
      let roles = await getJsonSetting(key, [], interaction.guild.id);
      if (action === 'view') {
        await interaction.editReply({ content: `${isRide ? 'Ride-along permission' : 'Report staff'} roles: ${roles.length ? roles.map((id) => `<@&${id}>`).join(', ') : 'None'}` });
        return;
      }
      if (action === 'add' && role) roles = [...new Set([...roles, role.id])];
      if (action === 'remove' && role) roles = roles.filter((id) => id !== role.id);
      if (action === 'clear') roles = [];
      await setJsonSetting(key, roles, interaction.guild.id);
      await interaction.editReply({ content: `${isRide ? 'Ride-along permission' : 'Report staff'} roles: ${roles.length ? roles.map((id) => `<@&${id}>`).join(', ') : 'None'}` });
      return;
    }

    if (interaction.commandName === 'ridealong-config') {
      const action = interaction.options.getString('action');
      if (action === 'set') {
        const rideRole = interaction.options.getRole('ridealong_role');
        const traineeRole = interaction.options.getRole('trainee_role');
        if (rideRole) await setSetting('ridealongResultRoleId', rideRole.id, interaction.guild.id);
        if (traineeRole) await setSetting('traineeRoleId', traineeRole.id, interaction.guild.id);
      }
      if (action === 'clear') {
        await setSetting('ridealongResultRoleId', '', interaction.guild.id);
        await setSetting('traineeRoleId', '', interaction.guild.id);
      }
      const currentRide = await getSetting('ridealongResultRoleId', null, interaction.guild.id);
      const currentTrainee = await getSetting('traineeRoleId', null, interaction.guild.id);
      await interaction.editReply({ content: `Ride-along role: ${currentRide ? `<@&${currentRide}>` : 'Not configured'}\nTrainee role: ${currentTrainee ? `<@&${currentTrainee}>` : 'Not configured'}` });
      return;
    }

    if (interaction.commandName === 'log-config') {
      const type = interaction.options.getString('type');
      const channel = interaction.options.getChannel('channel');
      const key = type === 'report_log' ? 'reportLogChannelId' : type === 'transcript_log' ? 'transcriptChannelId' : 'ridealongLogChannelId';
      if (channel) await setSetting(key, channel.id, interaction.guild.id);
      const current = await getSetting(key, null, interaction.guild.id);
      await interaction.editReply({ content: `${type}: ${current ? `<#${current}>` : 'Not configured'}` });
      return;
    }

    if (interaction.commandName === 'addofficer') {
      if (!(await ensureReportStaff(interaction.member))) {
        await interaction.editReply({ content: 'Reports team permission required.' });
        return;
      }
      const report = await getReportByChannel(interaction.channel.id);
      if (!report) {
        await interaction.editReply({ content: 'This is not a report ticket.' });
        return;
      }
      const targetUser = interaction.options.getUser('user');
      const suppliedId = interaction.options.getString('user_id')?.trim();
      const targetId = targetUser?.id || suppliedId;
      if (!/^\d{17,20}$/.test(String(targetId || ''))) {
        await interaction.editReply({ content: 'Provide a valid Discord user or Discord user ID.' });
        return;
      }
      await dbQuery('UPDATE reports SET reportedUserId=? WHERE channelId=?', [targetId, interaction.channel.id]);
      if (report.anonymous) {
        await interaction.channel.permissionOverwrites.edit(targetId, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        }).catch(() => {});
      }
      const updated = await getReportByChannel(interaction.channel.id);
      await updateReportMessage(interaction.channel, updated);
      await interaction.editReply({ content: `Officer being reported set to <@${targetId}>.` });
      return;
    }

    if (interaction.commandName === 'reportadd') {
      if (!(await ensureReportStaff(interaction.member))) {
        await interaction.editReply({ content: 'Reports team permission required.' });
        return;
      }
      const department = assertDepartment(interaction.options.getString('department'));
      const channel = await createReportTicket({
        interaction,
        type: 'officer',
        department,
        anonymous: false,
        reportedUserId: interaction.options.getUser('officer')?.id || null,
        dateOfIncident: interaction.options.getString('date'),
        gameId: interaction.options.getString('game_id'),
        clip: interaction.options.getString('clip'),
        description: interaction.options.getString('description'),
        context: interaction.options.getString('context'),
      });
      await interaction.editReply({ content: channel ? `Report created: ${channel}` : 'Unable to create the report.' });
      return;
    }

    if (interaction.commandName === 'anonreport') {
      if (interaction.channel) {
        const report = await getReportByChannel(interaction.channel.id);
        if (report) {
          if (!(await ensureReportStaff(interaction.member)) && report.reporterId !== interaction.user.id) {
            await interaction.editReply({ content: 'Only the reporter or reports team can convert this ticket to anonymous.' });
            return;
          }

          const department = assertDepartment(interaction.options.getString('department')) || report.department;
          const updates = {
            dateOfIncident: interaction.options.getString('date') || report.dateOfIncident,
            gameId: interaction.options.getString('game_id') || report.gameId,
            clip: interaction.options.getString('clip') || report.clip,
            description: interaction.options.getString('description') || report.description,
            context: interaction.options.getString('context') || report.context,
          };

          await dbQuery(
            `UPDATE reports SET department=?, dateOfIncident=?, gameId=?, clip=?, description=?, context=?, anonymous=1 WHERE channelId=?`,
            [department, updates.dateOfIncident || null, updates.gameId || null, updates.clip || null, updates.description || null, updates.context || null, interaction.channel.id]
          );

          await interaction.channel.permissionOverwrites.edit(report.reporterId, {
            ViewChannel: false,
            SendMessages: false,
            ReadMessageHistory: false,
          }).catch(() => {});

          const staffRoles = await getReportStaffRoleIds(interaction.guild.id);
          const departmentRoles = await getDepartmentReportRoleIds(interaction.guild.id, department);
          const rolesToKeep = [...new Set([...staffRoles, ...departmentRoles])];
          for (const roleId of rolesToKeep) {
            if (interaction.guild.roles.cache.has(roleId)) {
              await interaction.channel.permissionOverwrites.edit(roleId, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
              }).catch(() => {});
            }
          }

          if (report.reportedUserId) {
            await interaction.channel.permissionOverwrites.edit(report.reportedUserId, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true,
            }).catch(() => {});
          }

          await clearChannel(interaction.channel);
          await interaction.channel.setName(`anon-${department.toLowerCase()}`).catch(() => {});
          const fresh = await getReportByChannel(interaction.channel.id);
          const roleMentions = departmentRoles.map((id) => `<@&${id}>`).join(' ');
          await interaction.channel.send({
            content: roleMentions || undefined,
            embeds: [buildReportEmbed({
              anonymous: true,
              type: fresh.ticketType,
              department: fresh.department,
              dateOfIncident: fresh.dateOfIncident,
              gameId: fresh.gameId,
              reportedUserId: fresh.reportedUserId,
              clip: fresh.clip,
              description: fresh.description,
              context: fresh.context,
            })],
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('report_close').setLabel('Close').setStyle(ButtonStyle.Danger))],
          });
          await interaction.editReply({ content: 'The report was converted to anonymous mode. The reporter no longer has access to this ticket.' });
          return;
        }
      }

      const department = assertDepartment(interaction.options.getString('department'));
      if (!department) {
        await interaction.editReply({ content: 'Use /anonreport inside an existing report ticket, or provide a department when creating a new anonymous report.' });
        return;
      }
      const channel = await createReportTicket({
        interaction,
        type: 'officer',
        department,
        anonymous: true,
        reportedUserId: null,
        dateOfIncident: interaction.options.getString('date'),
        gameId: interaction.options.getString('game_id'),
        clip: interaction.options.getString('clip'),
        description: interaction.options.getString('description'),
        context: interaction.options.getString('context'),
      });
      await interaction.editReply({ content: channel ? `Anonymous report created: ${channel}` : 'Unable to create the anonymous report.' });
      return;
    }

    if (interaction.commandName === 'rename') {
      if (!(await ensureReportStaff(interaction.member))) {
        await interaction.editReply({ content: 'Reports team permission required.' });
        return;
      }
      const report = await getReportByChannel(interaction.channel.id);
      if (!report) {
        await interaction.editReply({ content: 'This is not a report ticket.' });
        return;
      }
      const reporter = await getDiscordUser(report.reporterId);
      const base = cleanName(reporter?.username || report.reporterId || 'user');
      await interaction.channel.setName(`${base}-handling`);
      await interaction.editReply({ content: `Ticket renamed to ${base}-handling.` });
      return;
    }

    if (interaction.commandName === 'close') {
      if (!(await ensureReportStaff(interaction.member))) {
        await interaction.editReply({ content: 'Reports team permission required.' });
        return;
      }
      const report = await getReportByChannel(interaction.channel.id);
      if (!report) {
        await interaction.editReply({ content: 'This is not a report ticket.' });
        return;
      }
      await dbQuery('UPDATE reports SET closedAt=? WHERE channelId=?', [now(), interaction.channel.id]);
      await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false }).catch(() => {});
      const staffRoles = await getReportStaffRoleIds(interaction.guild.id);
      for (const roleId of staffRoles) {
        await interaction.channel.permissionOverwrites.edit(roleId, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => {});
      }
      await interaction.editReply({ content: 'Ticket closed.' });
      return;
    }

    if (interaction.commandName === 'delete') {
      if (!(await ensureReportStaff(interaction.member))) {
        await interaction.editReply({ content: 'Reports team permission required.' });
        return;
      }
      const report = await getReportByChannel(interaction.channel.id);
      if (!report) {
        await interaction.editReply({ content: 'This is not a report ticket.' });
        return;
      }
      const transcript = await makeTranscript(interaction.channel);
      const transcriptId = await getSetting('transcriptChannelId', null, interaction.guild.id);
      const transcriptChannel = transcriptId ? interaction.guild.channels.cache.get(transcriptId) : null;
      if (transcriptChannel) {
        await transcriptChannel.send({
          content: `Transcript for #${interaction.channel.name}`,
          files: [{ attachment: Buffer.from(transcript || 'No messages.'), name: `${interaction.channel.name}-transcript.txt` }],
        }).catch(() => {});
      }
      await interaction.editReply({ content: 'Saving transcript and deleting ticket...' });
      setTimeout(() => interaction.channel.delete().catch(() => {}), 1000);
      return;
    }

    if (interaction.commandName === 'hours') return handleHours(interaction);
    if (['allhours', 'totalhours', 'weeklydeptours', 'deptofhours', 'leaderboard'].includes(interaction.commandName)) {
      return handleDepartmentList(interaction, interaction.commandName);
    }

    if (interaction.commandName === 'tophours') {
      const rows = await dbQuery(
        `SELECT discordId, SUM(GREATEST(0, COALESCE(outTime, UNIX_TIMESTAMP()) - inTime)) AS seconds
         FROM duty_hours WHERE discordId IS NOT NULL GROUP BY discordId ORDER BY seconds DESC LIMIT 10`
      );
      const description = rows.length ? rows.map((r, i) => `${i + 1}. <@${r.discordId}> — ${hoursText(r.seconds)}`).join('\n') : 'No recorded hours.';
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x496c8e).setTitle('Top Hours').setDescription(description)] });
      return;
    }

    if (interaction.commandName === 'evaluate') return handleEvaluate(interaction);

    if (interaction.commandName === 'inactive_officers' || interaction.commandName === 'dept_officers') {
      const department = assertDepartment(interaction.options.getString('department'));
      const weeks = interaction.options.getInteger('weeks_back') || 2;
      const cutoff = now() - weeks * 7 * 86400;
      const rows = await dbQuery(
        `SELECT discordId, MAX(COALESCE(outTime, UNIX_TIMESTAMP())) AS lastDuty
         FROM duty_hours WHERE department=? AND discordId IS NOT NULL GROUP BY discordId HAVING lastDuty < ? ORDER BY lastDuty ASC`,
        [department, cutoff]
      );
      const description = rows.length ? rows.map((r) => `<@${r.discordId}> — last duty ${formatShort(Number(r.lastDuty))}`).join('\n') : 'No inactive officers found.';
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xe0a458).setTitle(`${department} Inactive Officers`).setDescription(description).setFooter({ text: `${weeks}+ weeks without duty` })] });
      return;
    }

    if (interaction.commandName === 'promotions') {
      const department = assertDepartment(interaction.options.getString('department'));
      const minimum = interaction.options.getInteger('min_hours') ?? 8;
      const window = getWeekWindow();
      const rows = await dbQuery(
        `SELECT discordId, SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))) AS seconds
         FROM duty_hours WHERE department=? AND discordId IS NOT NULL AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ?
         GROUP BY discordId HAVING seconds >= ? ORDER BY seconds DESC`,
        [window.end, window.start, department, window.end, window.start, minimum * 3600]
      );
      const description = rows.length ? rows.map((r) => `<@${r.discordId}> — ${hoursText(r.seconds)}`).join('\n') : 'No members meet the current threshold.';
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x496c8e).setTitle(`${department} Promotion Eligibility`).setDescription(description).setFooter({ text: `Minimum ${minimum}h this week` })] });
      return;
    }

    if (interaction.commandName === 'leomulti') {
      const duration = interaction.options.getInteger('duration_minutes');
      const multiplier = interaction.options.getNumber('multiplier') || 1.5;
      await setJsonSetting('leoMultiplier', { multiplier, until: now() + duration * 60 });
      await interaction.editReply({ content: `LEO hour multiplier started at ${multiplier}x for ${duration} minutes.` });
      return;
    }

    if (interaction.commandName === 'add_org') {
      const code = interaction.options.getString('code').toUpperCase();
      const name = interaction.options.getString('name');
      await dbQuery('INSERT INTO department_orgs (code,name,createdBy) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [code, name, interaction.user.id]);
      await interaction.editReply({ content: `Added organisation ${code} — ${name}.` });
      return;
    }

    if (interaction.commandName === 'add_org_hours') {
      const code = interaction.options.getString('code').toUpperCase();
      const hours = interaction.options.getNumber('hours');
      const reason = interaction.options.getString('reason');
      await dbQuery('INSERT INTO org_hours_adjustments (orgCode,hours,reason,createdBy,createdAt) VALUES (?,?,?,?,?)', [code, hours, reason || null, interaction.user.id, now()]);
      await interaction.editReply({ content: `Added ${hours.toFixed(2)} hours to ${code}.` });
      return;
    }

    if (interaction.commandName === 'rename_org') {
      const oldCode = interaction.options.getString('old_code').toUpperCase();
      const newCode = interaction.options.getString('new_code').toUpperCase();
      const name = interaction.options.getString('name');
      await dbQuery('UPDATE department_orgs SET code=?,name=? WHERE code=?', [newCode, name, oldCode]);
      await dbQuery('UPDATE org_hours_adjustments SET orgCode=? WHERE orgCode=?', [newCode, oldCode]);
      await interaction.editReply({ content: `Renamed ${oldCode} to ${newCode}.` });
      return;
    }

    await interaction.editReply({ content: `/${interaction.commandName} is registered, but no handler has been configured yet.` });
  } catch (error) {
    console.error(`Command /${interaction.commandName} failed:`, error);
    await safeReply(interaction, {
      content: error.message.includes('timed out') || error.code === 'ETIMEDOUT'
        ? 'The database did not respond in time. The command is working, but the MySQL server is currently unreachable from Railway.'
        : `The command failed: ${error.message}`,
    });
  }
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = commands.map((command) => command.toJSON());

  for (const command of body) {
    if (!Array.isArray(command.options)) continue;
    let optionalSeen = false;
    for (const option of command.options) {
      if (option.type === 1 || option.type === 2) continue;
      if (!option.required) optionalSeen = true;
      if (optionalSeen && option.required) {
        throw new Error(`Invalid required option order in /${command.name}: ${option.name}`);
      }
    }
  }

  const registered = await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
  console.log(`Registered ${Array.isArray(registered) ? registered.length : body.length} global commands.`);
  const verified = await rest.get(Routes.applicationCommands(CLIENT_ID));
  console.log(`Discord reports ${Array.isArray(verified) ? verified.length : 0} global commands currently registered.`);
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isStringSelectMenu() && interaction.customId === 'report_type') {
      if (interaction.guildId !== LOG_GUILD_ID) {
        await safeReply(interaction, { content: 'This panel is only available in the configured reports and ride-along server.' });
        return;
      }
      await interaction.showModal(reportFormModal(interaction.values[0]));
      return;
    }

    if (interaction.isButton() && interaction.customId === 'report_close') {
      if (interaction.guildId !== LOG_GUILD_ID) {
        await safeReply(interaction, { content: 'This ticket is only available in the configured reports and ride-along server.' });
        return;
      }
      await safeDefer(interaction, false);
      if (!(await ensureReportStaff(interaction.member))) {
        await interaction.editReply({ content: 'Reports team permission required.' });
        return;
      }
      const report = await getReportByChannel(interaction.channel.id);
      if (!report) {
        await interaction.editReply({ content: 'This is not a report ticket.' });
        return;
      }
      await dbQuery('UPDATE reports SET closedAt=? WHERE channelId=?', [now(), interaction.channel.id]);
      await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false }).catch(() => {});
      const staffRoles = await getReportStaffRoleIds(interaction.guild.id);
      for (const roleId of staffRoles) {
        await interaction.channel.permissionOverwrites.edit(roleId, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => {});
      }
      await interaction.editReply({ content: 'Ticket closed.' });
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('report_modal:')) {
      if (interaction.guildId !== LOG_GUILD_ID) {
        await safeReply(interaction, { content: 'This panel is only available in the configured reports and ride-along server.' });
        return;
      }
      await safeDefer(interaction, true);
      const [, type] = interaction.customId.split(':');
      const department = assertDepartment(interaction.fields.getTextInputValue('department'));
      if (!department) {
        await interaction.editReply({ content: 'Department must be USM, SASP, BCSO or LSPD.' });
        return;
      }
      const details = interaction.fields.getTextInputValue('details') || '';
      const channel = await createReportTicket({
        interaction,
        type,
        department,
        anonymous: false,
        dateOfIncident: interaction.fields.getTextInputValue('date'),
        gameId: interaction.fields.getTextInputValue('game_id'),
        clip: interaction.fields.getTextInputValue('clip'),
        description: details,
        context: '',
        reportedUserId: null,
      });
      await interaction.editReply({ content: channel ? `Report created: ${channel}` : 'Unable to create the report.' });
      return;
    }

    if (interaction.isChatInputCommand()) await handleCommand(interaction);
  } catch (error) {
    console.error('Interaction handling failed:', error);
    await safeReply(interaction, { content: 'The bot hit an internal error while processing that request.' });
  }
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);

  try {
    await registerCommands();
  } catch (error) {
    console.error(`GLOBAL COMMAND REGISTRATION FAILED: ${error.message}`);
  }

  async function databaseBootstrap() {
    try {
      await ensureSchema();
      dbOnline = true;
      console.log('DATABASE / DUTY TRACKING ONLINE');
      await pollDuty();
      if (!dutyPollTimer) dutyPollTimer = setInterval(() => pollDuty().catch(() => {}), DUTY_POLL_MS);
      if (dbRetryTimer) {
        clearInterval(dbRetryTimer);
        dbRetryTimer = null;
      }
    } catch (error) {
      dbOnline = false;
      console.error(`DATABASE / DUTY STARTUP ERROR: ${error.message}`);
      if (!dbRetryTimer) {
        dbRetryTimer = setInterval(async () => {
          try {
            await ensureSchema();
            dbOnline = true;
            console.log('DATABASE CONNECTION RESTORED');
            await pollDuty();
            if (!dutyPollTimer) dutyPollTimer = setInterval(() => pollDuty().catch(() => {}), DUTY_POLL_MS);
            clearInterval(dbRetryTimer);
            dbRetryTimer = null;
          } catch (retryError) {
            console.error(`DATABASE RETRY FAILED: ${retryError.message}`);
          }
        }, 30000);
      }
    }
  }

  await databaseBootstrap();
});

process.on('SIGINT', async () => {
  if (dutyPollTimer) clearInterval(dutyPollTimer);
  if (dbRetryTimer) clearInterval(dbRetryTimer);
  await pool.end().catch(() => {});
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (dutyPollTimer) clearInterval(dutyPollTimer);
  if (dbRetryTimer) clearInterval(dbRetryTimer);
  await pool.end().catch(() => {});
  process.exit(0);
});

client.login(TOKEN).catch((error) => {
  console.error(`DISCORD LOGIN FAILED: ${error.message}`);
  process.exit(1);
});
