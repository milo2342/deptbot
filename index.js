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
  Routes
} = require('discord.js');
const mysql = require('mysql2/promise');
const { DateTime } = require('luxon');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const LOG_GUILD_ID = '1499578614298181642';
const TIMEZONE = process.env.TIMEZONE || 'Europe/London';
const DUTY_POLL_MS = Math.max(2000, Number(process.env.DUTY_POLL_MS || 5000));
const DEPARTMENTS = ['USM', 'SASP', 'BCSO', 'LSPD'];
const LEO_VOICE_CHANNELS = [
  '1542399560394088538',
  '1542399564588261446',
  '1542399567234994206'
];
const ADMIN_COMMANDS = new Set([
  'admin-roles',
  'permissions',
  'report-config',
  'report-staff',
  'ridealong-permissions',
  'ridealong-config',
  'log-config',
  'officer-report-panel',
  'add_org',
  'add_org_hours',
  'rename_org'
]);
const REPORT_COMMANDS = new Set([
  'officer-report-panel',
  'anonreport',
  'addofficer',
  'reportadd',
  'report-config',
  'report-staff',
  'log-config',
  'rename',
  'close',
  'delete'
]);
const LOG_SERVER_COMMANDS = new Set([
  ...REPORT_COMMANDS,
  'ridealong',
  'ridealong-permissions',
  'ridealong-config'
]);

if (!TOKEN || !CLIENT_ID) throw new Error('Missing DISCORD_TOKEN or CLIENT_ID.');
if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) {
  throw new Error('Missing MYSQL_HOST, MYSQL_USER or MYSQL_DATABASE.');
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
  connectTimeout: 3000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const activeDuty = new Map();
const pendingVoice = new Map();

function now() { return Math.floor(Date.now() / 1000); }
function localDateTime(ts) { return DateTime.fromSeconds(Number(ts), { zone: TIMEZONE }); }
function formatDateTime(ts) { return localDateTime(ts).toFormat('cccc, dd LLLL yyyy HH:mm'); }
function formatShort(ts) { return localDateTime(ts).toFormat('dd/MM/yyyy HH:mm'); }
function formatDuration(seconds) {
  let value = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(value / 86400); value %= 86400;
  const h = Math.floor(value / 3600); value %= 3600;
  const m = Math.floor(value / 60); const s = value % 60;
  if (d) return `${d}d ${h}h ${m}m ${s}s`;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function hoursText(seconds) { return `${(Math.max(0, Number(seconds || 0)) / 3600).toFixed(2)}h`; }
function cleanName(value) {
  return String(value || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70) || 'user';
}
function parseIds(value) { return String(value || '').split(',').map(v => v.trim()).filter(Boolean); }
function deptName(code) {
  return {
    USM: 'United States Marshals',
    SASP: 'San Andreas State Police',
    BCSO: "Blaine County Sheriff's Office",
    LSPD: 'Los Santos Police Department'
  }[code] || code;
}
function isLeoVoice(channelId) { return !!channelId && LEO_VOICE_CHANNELS.includes(channelId); }
function timeframeLabel(value) {
  return {
    last_week: 'Last Week',
    this_week: 'This Week',
    this_month: 'This Month',
    last_month: 'Last Month',
    all_time: 'All Time'
  }[value] || value;
}

const DB_QUERY_TIMEOUT_MS = Math.max(750, Number(process.env.DB_QUERY_TIMEOUT_MS || 1500));
async function q(sql, params = []) {
  let timer;
  try {
    return await Promise.race([
      pool.execute(sql, params).then(([rows]) => rows),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Database query timed out after ${DB_QUERY_TIMEOUT_MS}ms`);
          error.code = 'DB_QUERY_TIMEOUT';
          reject(error);
        }, DB_QUERY_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function settingKey(guildId, key) { return guildId ? `guild:${guildId}:${key}` : key; }
async function getSetting(key, fallback = null, guildId = null) {
  const rows = await q('SELECT settingValue FROM bot_settings WHERE settingKey=? LIMIT 1', [settingKey(guildId, key)]);
  return rows[0] ? rows[0].settingValue : fallback;
}
async function setSetting(key, value, guildId = null) {
  await q(
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
async function setJsonSetting(key, value, guildId = null) { return setSetting(key, JSON.stringify(value), guildId); }

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
  for (const statement of statements) await pool.query(statement);
}

function isEnvOrDiscordAdmin(member) {
  if (!member) return false;
  const envAdmins = parseIds(process.env.BOT_ADMINS);
  if (envAdmins.includes(member.id)) return true;
  return !!member.permissions?.has(PermissionFlagsBits.Administrator);
}

async function isAdmin(member) {
  if (isEnvOrDiscordAdmin(member)) return true;
  if (!member?.guild) return false;
  try {
    const roleIds = await getJsonSetting('adminRoles', [], member.guild.id);
    return roleIds.some(id => member.roles?.cache.has(id));
  } catch {
    return false;
  }
}

async function commandAllowed(member, commandName) {
  if (!member) return false;
  if (isEnvOrDiscordAdmin(member)) return true;
  // Public data commands are available everywhere by default.
  // Only check stored permissions when a command has been explicitly configured.
  if (!member.guild) return false;
  try {
    const configured = await getJsonSetting(`cmdperm:${commandName}`, [], member.guild.id);
    if (!configured.length) return true;
    return configured.some(id => member.roles.cache.has(id));
  } catch {
    return true;
  }
}

async function roleAllowed(member, key) {
  if (!member) return false;
  if (isEnvOrDiscordAdmin(member)) return true;
  try {
    const roleIds = await getJsonSetting(key, [], member.guild.id);
    return roleIds.some(id => member.roles.cache.has(id));
  } catch {
    return false;
  }
}

async function replyInteraction(interaction, payload = {}) {
  try {
    if (interaction.deferred) {
      const next = { ...payload };
      delete next.ephemeral;
      return await interaction.editReply(next);
    }
    if (interaction.replied) {
      return await interaction.followUp(payload);
    }
    return await interaction.reply(payload);
  } catch (error) {
    console.error('Interaction reply failed:', error.message);
    return null;
  }
}

function requireGuild(interaction, ephemeral = true) {
  if (!interaction.guild) {
    replyInteraction(interaction, { content: 'This command can only be used in a server.', ephemeral });
    return false;
  }
  return true;
}

function requireLogServer(interaction, ephemeral = true) {
  if (!requireGuild(interaction, ephemeral)) return false;
  if (interaction.guild.id !== LOG_GUILD_ID) {
    replyInteraction(interaction, { content: 'This command is only available in the configured reports and ride-along server.', ephemeral });
    return false;
  }
  return true;
}

async function requireAdmin(interaction) {
  if (!requireGuild(interaction)) return false;
  if (await isAdmin(interaction.member)) return true;
  await replyInteraction(interaction, { content: 'Administrator permission required.', ephemeral: true });
  return false;
}

const ALWAYS_PUBLIC_COMMANDS = new Set(['hours','allhours','totalhours','weeklydeptours','deptofhours','tophours','leaderboard','evaluate','inactive_officers','promotions','dept_officers']);

async function requireCommandPermission(interaction) {
  if (!requireGuild(interaction)) return false;
  const name = interaction.commandName;
  if (ALWAYS_PUBLIC_COMMANDS.has(name)) return true;
  if (!(await commandAllowed(interaction.member, name))) {
    await replyInteraction(interaction, { content: 'You do not have permission to use this command.' });
    return false;
  }
  return true;
}

function getUserDisplay(user) { return user?.globalName || user?.username || user?.id || 'User'; }
async function getDiscordUser(discordId) { return client.users.fetch(String(discordId)).catch(() => null); }

async function sendDM(user, embed) {
  try { await user.send({ embeds: [embed] }); } catch (error) { console.warn(`Unable to DM ${user?.id || 'unknown'}: ${error.message}`); }
}

function dutyOnEmbed({ user, department, inTime }) {
  return new EmbedBuilder()
    .setColor(0x2f9e44)
    .setTitle('On Duty')
    .setDescription(`Thanks for your service, ${getUserDisplay(user)}.`)
    .addFields(
      { name: 'Clock In', value: formatDateTime(inTime), inline: true },
      { name: 'Department', value: `${department} — ${deptName(department)}`, inline: true }
    )
    .setFooter({ text: `WCRP Department Utilities • ${formatShort(inTime)}` });
}

function dutyOffEmbed({ user, department, outTime, inTime, session, weekly, inVoice, outVoice, coverage, reason }) {
  const embed = new EmbedBuilder()
    .setColor(0xe04f5f)
    .setTitle('Off Duty')
    .setDescription(`Thanks for your service, ${getUserDisplay(user)}.`)
    .addFields(
      { name: 'Reason', value: reason || 'Clock Out', inline: false },
      { name: 'Clock Out', value: formatDateTime(outTime), inline: true },
      { name: 'Session', value: formatDuration(session), inline: true },
      { name: 'This Week (Fri-Thu)', value: hoursText(weekly.total), inline: true },
      { name: 'Week', value: `${weekly.startLabel} - ${weekly.endLabel}`, inline: true },
      { name: 'Department', value: `${department} — ${deptName(department)}`, inline: true },
      { name: 'In Voice', value: formatDuration(inVoice), inline: true },
      { name: 'Out of Voice', value: formatDuration(outVoice), inline: true },
      { name: 'Voice Coverage', value: `${coverage.toFixed(0)}%`, inline: true }
    )
    .setFooter({ text: `WCRP Department Utilities • ${formatShort(outTime)}` });
  if (inTime) embed.addFields({ name: 'Clock In', value: formatDateTime(inTime), inline: false });
  return embed;
}

function getWeekWindow(ts = now()) {
  const current = localDateTime(ts);
  const daysSinceFriday = (current.weekday + 2) % 7;
  const start = current.minus({ days: daysSinceFriday }).startOf('day');
  const end = start.plus({ days: 7 });
  return {
    start: Math.floor(start.toSeconds()),
    end: Math.floor(end.toSeconds()),
    startLabel: start.toFormat('LLL dd'),
    endLabel: end.minus({ seconds: 1 }).toFormat('LLL dd')
  };
}

function windowFor(type, ts = now()) {
  const current = localDateTime(ts);
  const week = getWeekWindow(ts);
  if (type === 'this_week') return week;
  if (type === 'last_week') {
    const start = localDateTime(week.start).minus({ days: 7 });
    const end = localDateTime(week.start);
    return { start: Math.floor(start.toSeconds()), end: Math.floor(end.toSeconds()), startLabel: start.toFormat('LLL dd'), endLabel: end.minus({ seconds: 1 }).toFormat('LLL dd') };
  }
  if (type === 'this_month') {
    const start = current.startOf('month');
    const end = start.plus({ months: 1 });
    return { start: Math.floor(start.toSeconds()), end: Math.floor(end.toSeconds()), startLabel: start.toFormat('LLL dd'), endLabel: end.minus({ seconds: 1 }).toFormat('LLL dd') };
  }
  if (type === 'last_month') {
    const end = current.startOf('month');
    const start = end.minus({ months: 1 });
    return { start: Math.floor(start.toSeconds()), end: Math.floor(end.toSeconds()), startLabel: start.toFormat('LLL dd'), endLabel: end.minus({ seconds: 1 }).toFormat('LLL dd') };
  }
  return { start: 0, end: now() + 1, startLabel: 'All Time', endLabel: '' };
}

async function totalDutySeconds({ discordId, department, window }) {
  let sql = `SELECT inTime, COALESCE(outTime, UNIX_TIMESTAMP()) outTime FROM duty_hours WHERE inTime IS NOT NULL`;
  const params = [];
  if (discordId) { sql += ' AND discordId=?'; params.push(discordId); }
  if (department) { sql += ' AND department=?'; params.push(department); }
  if (window) {
    sql += ' AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ?';
    params.push(window.end, window.start);
  }
  const rows = await q(sql, params);
  let total = 0;
  for (const row of rows) {
    const inTime = Number(row.inTime);
    const outTime = Number(row.outTime);
    total += Math.max(0, Math.min(outTime, window?.end ?? outTime) - Math.max(inTime, window?.start ?? inTime));
  }
  return Math.floor(total);
}

async function voiceSecondsForDuty(dutyId, inTime, outTime) {
  const end = outTime || now();
  const rows = await q(
    `SELECT inTime, COALESCE(outTime, ?) outTime, isLeoVoice
     FROM duty_voice_segments
     WHERE dutyId=? AND inTime < ? AND COALESCE(outTime, ?) > ?`,
    [end, dutyId, end, end, inTime]
  );
  let voice = 0;
  for (const row of rows) {
    if (Number(row.isLeoVoice)) voice += Math.max(0, Math.min(Number(row.outTime), end) - Math.max(Number(row.inTime), inTime));
  }
  const session = Math.max(0, end - inTime);
  return {
    voice,
    outVoice: Math.max(0, session - voice),
    session,
    coverage: session ? (voice / session) * 100 : 0
  };
}

async function updateVoiceSegmentForUser(discordId, channelId, ts = now()) {
  const duty = activeDuty.get(discordId);
  if (!duty) return;
  const state = pendingVoice.get(discordId);
  if (state && state.channelId === (channelId || null)) return;
  if (state) await q('UPDATE duty_voice_segments SET outTime=? WHERE id=? AND outTime IS NULL', [ts, state.segmentId]);
  const result = await q(
    'INSERT INTO duty_voice_segments (dutyId, discordId, channelId, inTime, outTime, isLeoVoice) VALUES (?, ?, ?, ?, NULL, ?)',
    [duty.id, discordId, channelId || null, ts, isLeoVoice(channelId) ? 1 : 0]
  );
  pendingVoice.set(discordId, { segmentId: result.insertId, channelId: channelId || null });
}

async function closeVoiceForUser(discordId, ts = now()) {
  const state = pendingVoice.get(discordId);
  if (!state) return;
  await q('UPDATE duty_voice_segments SET outTime=? WHERE id=? AND outTime IS NULL', [ts, state.segmentId]);
  pendingVoice.delete(discordId);
}

async function getLogGuild() { return client.guilds.fetch(LOG_GUILD_ID).catch(() => null); }

async function startDutyTracking(row) {
  if (!row?.discordId || activeDuty.has(row.discordId)) return;
  const duty = {
    id: row.id,
    discordId: String(row.discordId),
    inTime: Number(row.inTime),
    department: String(row.department || '').toUpperCase()
  };
  activeDuty.set(duty.discordId, duty);
  const logGuild = await getLogGuild();
  const member = logGuild ? await logGuild.members.fetch(duty.discordId).catch(() => null) : null;
  if (member) await updateVoiceSegmentForUser(duty.discordId, member.voice.channelId, duty.inTime).catch(() => {});
  const user = await getDiscordUser(duty.discordId);
  if (user) await sendDM(user, dutyOnEmbed({ user, department: duty.department, inTime: duty.inTime }));
}

async function getPersonDepartmentWeek(discordId, department, window) {
  const total = await totalDutySeconds({ discordId, department, window });
  return { total, startLabel: window.startLabel, endLabel: window.endLabel };
}

async function finishDutyTracking(row) {
  const duty = activeDuty.get(String(row.discordId));
  const inTime = duty?.inTime || Number(row.inTime);
  const dutyId = duty?.id || row.id;
  const outTime = Number(row.outTime || now());
  await closeVoiceForUser(String(row.discordId), outTime).catch(() => {});
  const stats = await voiceSecondsForDuty(dutyId, inTime, outTime);
  const weeklyWindow = getWeekWindow(outTime);
  const weekly = await getPersonDepartmentWeek(String(row.discordId), String(row.department), weeklyWindow);
  const user = await getDiscordUser(row.discordId);
  if (user) {
    await sendDM(user, dutyOffEmbed({
      user,
      department: String(row.department),
      outTime,
      inTime,
      session: stats.session,
      weekly,
      inVoice: stats.voice,
      outVoice: stats.outVoice,
      coverage: stats.coverage,
      reason: row.reason || 'Clock Out'
    }));
  }
  activeDuty.delete(String(row.discordId));
}

async function pollDuty() {
  try {
    const active = await q(`SELECT * FROM duty_hours WHERE outTime IS NULL AND discordId IS NOT NULL ORDER BY id DESC`);
    const seen = new Set();
    for (const row of active) {
      const id = String(row.discordId);
      if (seen.has(id)) continue;
      seen.add(id);
      await startDutyTracking(row);
    }
    const completed = await q(`SELECT * FROM duty_hours WHERE outTime IS NOT NULL AND outTime >= ? ORDER BY outTime ASC`, [now() - 30]);
    for (const row of completed) {
      const id = String(row.discordId);
      if (activeDuty.has(id) && activeDuty.get(id).id === row.id) await finishDutyTracking(row);
    }
    for (const [id] of activeDuty) if (!seen.has(id)) {
      await closeVoiceForUser(id).catch(() => {});
      activeDuty.delete(id);
    }
  } catch (error) {
    console.error('Duty poll error:', error);
  }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  const id = String(newState.id || oldState.id);
  if (!activeDuty.has(id)) return;
  try {
    await updateVoiceSegmentForUser(id, newState.channelId);
  } catch (error) {
    console.error('Voice tracking error:', error);
  }
});

function baseCommand(name, description) {
  return new SlashCommandBuilder().setName(name).setDescription(description);
}

const commands = [
  baseCommand('officer-report-panel', 'Post the officer report panel'),
  baseCommand('anonreport', 'Create or rebuild an anonymous department report'),
  baseCommand('addofficer', 'Reports team: set the person being reported'),
  baseCommand('reportadd', 'Reports team: create a report ticket'),
  baseCommand('report-config', 'Admin: configure department report roles and category'),
  baseCommand('report-staff', 'Admin: manage report handling roles'),
  baseCommand('log-config', 'Admin: configure report, transcript and ride-along logs'),
  baseCommand('ridealong-permissions', 'Admin: manage roles allowed to use ride-along logging'),
  baseCommand('ridealong-config', 'Admin: configure ride-along and trainee roles'),
  baseCommand('permissions', 'Admin: configure which roles can use commands'),
  baseCommand('admin-roles', 'Admin: configure additional administrator roles'),
  baseCommand('ridealong', 'Log a ride-along result'),
  baseCommand('rename', 'Rename a report ticket to user-handling'),
  baseCommand('close', 'Close a report ticket'),
  baseCommand('delete', 'Delete a report ticket and save a transcript'),
  baseCommand('hours', 'Check duty hours for yourself or another user'),
  baseCommand('allhours', 'Get hours of everyone in a department'),
  baseCommand('totalhours', 'Get total hours for a department'),
  baseCommand('weeklydeptours', 'Get total department hours for the last seven days'),
  baseCommand('deptofhours', 'Get the top players in a department by hours'),
  baseCommand('tophours', 'Get the top five players with the most all-time hours'),
  baseCommand('leaderboard', 'Show a department leaderboard'),
  baseCommand('evaluate', 'Evaluate a user against the weekly department requirement'),
  baseCommand('inactive_officers', 'Report inactive department officers'),
  baseCommand('promotions', 'List promotion-eligible department officers'),
  baseCommand('leomulti', 'Start an hour multiplier'),
  baseCommand('add_org', 'Admin: add an organisation'),
  baseCommand('add_org_hours', 'Admin: add hours to an organisation total'),
  baseCommand('rename_org', 'Admin: rename an organisation'),
  baseCommand('dept_officers', 'Get department officers by activity status')
].map(c => c.setDMPermission(false));

const departmentOption = (name = 'department', required = true) => (o) =>
  o.setName(name).setDescription('Department').setRequired(required).addChoices(...DEPARTMENTS.map(value => ({ name: value, value })));
const timeframeChoices = [
  { name: 'Last Week', value: 'last_week' },
  { name: 'This Week', value: 'this_week' },
  { name: 'This Month', value: 'this_month' },
  { name: 'Last Month', value: 'last_month' },
  { name: 'All Time', value: 'all_time' }
];

commands.find(c => c.name === 'hours')
  .addStringOption(departmentOption('department', true))
  .addUserOption(o => o.setName('user').setDescription('Exact person to check').setRequired(false))
  .addStringOption(o => o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...timeframeChoices));

for (const name of ['allhours', 'totalhours', 'weeklydeptours', 'deptofhours', 'leaderboard', 'promotions', 'evaluate', 'inactive_officers', 'dept_officers']) {
  commands.find(c => c.name === name).addStringOption(departmentOption('department', true));
}
commands.find(c => c.name === 'allhours').addStringOption(o => o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...timeframeChoices));
commands.find(c => c.name === 'totalhours').addStringOption(o => o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...timeframeChoices));
commands.find(c => c.name === 'weeklydeptours').addStringOption(o => o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...timeframeChoices));
commands.find(c => c.name === 'deptofhours').addStringOption(o => o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...timeframeChoices));
commands.find(c => c.name === 'leaderboard').addStringOption(o => o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(
  { name: 'This Month', value: 'this_month' },
  { name: 'Last Month', value: 'last_month' },
  { name: 'This Week', value: 'this_week' },
  { name: 'All Time', value: 'all_time' }
));
commands.find(c => c.name === 'promotions').addIntegerOption(o => o.setName('min_hours').setDescription('Minimum hours').setRequired(false).setMinValue(0));
commands.find(c => c.name === 'evaluate').addUserOption(o => o.setName('user').setDescription('Person to evaluate').setRequired(false));
commands.find(c => c.name === 'inactive_officers').addIntegerOption(o => o.setName('weeks_back').setDescription('Inactivity threshold in weeks').setRequired(false).addChoices({ name: '2 weeks', value: 2 }, { name: '4 weeks', value: 4 }));
commands.find(c => c.name === 'dept_officers').addIntegerOption(o => o.setName('weeks_back').setDescription('Inactivity threshold in weeks').setRequired(false).addChoices({ name: '2 weeks', value: 2 }, { name: '4 weeks', value: 4 }));
commands.find(c => c.name === 'leomulti').addIntegerOption(o => o.setName('duration_minutes').setDescription('Multiplier duration in minutes').setRequired(true).setMinValue(1).setMaxValue(10080));
commands.find(c => c.name === 'leomulti').addNumberOption(o => o.setName('multiplier').setDescription('Multiplier').setRequired(false).setMinValue(1).setMaxValue(5));
commands.find(c => c.name === 'add_org').addStringOption(o => o.setName('code').setDescription('Organisation code').setRequired(true)).addStringOption(o => o.setName('name').setDescription('Organisation name').setRequired(true));
commands.find(c => c.name === 'add_org_hours').addStringOption(o => o.setName('code').setDescription('Organisation code').setRequired(true)).addNumberOption(o => o.setName('hours').setDescription('Hours to add').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false));
commands.find(c => c.name === 'rename_org').addStringOption(o => o.setName('old_code').setDescription('Current code').setRequired(true)).addStringOption(o => o.setName('new_code').setDescription('New code').setRequired(true)).addStringOption(o => o.setName('name').setDescription('New organisation name').setRequired(true));

commands.find(c => c.name === 'permissions')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addStringOption(o => o.setName('command').setDescription('Command name').setRequired(true))
  .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(false));

commands.find(c => c.name === 'admin-roles')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addRoleOption(o => o.setName('role').setDescription('Administrator role').setRequired(false));

commands.find(c => c.name === 'report-staff')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addRoleOption(o => o.setName('role').setDescription('Reports handling role').setRequired(false));

commands.find(c => c.name === 'ridealong-permissions')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addRoleOption(o => o.setName('role').setDescription('Role allowed to log ride-alongs').setRequired(false));

commands.find(c => c.name === 'report-config')
  .addStringOption(departmentOption('department', false))
  .addRoleOption(o => o.setName('role').setDescription('Role pinged for this department').setRequired(false))
  .addChannelOption(o => o.setName('category').setDescription('Report ticket category').setRequired(false).addChannelTypes(ChannelType.GuildCategory));

commands.find(c => c.name === 'log-config')
  .addStringOption(o => o.setName('type').setDescription('Log type').setRequired(true).addChoices(
    { name: 'Report Logs', value: 'report_log' },
    { name: 'Transcript Logs', value: 'transcript_log' },
    { name: 'Ride-Along Logs', value: 'ridealong_log' }
  ))
  .addChannelOption(o => o.setName('channel').setDescription('Channel to use').setRequired(false).addChannelTypes(ChannelType.GuildText));

commands.find(c => c.name === 'ridealong-config')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'Set', value: 'set' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }))
  .addRoleOption(o => o.setName('ridealong_role').setDescription('Role assigned after a ride-along is logged').setRequired(false))
  .addRoleOption(o => o.setName('trainee_role').setDescription('Role removed when a ride-along is logged').setRequired(false));

commands.find(c => c.name === 'ridealong')
  .addSubcommand(sub => sub.setName('log').setDescription('Log a ride-along result')
    .addUserOption(o => o.setName('player').setDescription('Person receiving the ride-along result').setRequired(true))
    .addStringOption(departmentOption('department', true))
    .addStringOption(o => o.setName('result').setDescription('Ride-along result').setRequired(true).addChoices({ name: 'Passed', value: 'Passed' }, { name: 'Failed', value: 'Failed' }))
    .addStringOption(o => o.setName('notes').setDescription('Optional notes').setRequired(false)));

commands.find(c => c.name === 'addofficer')
  .addUserOption(o => o.setName('user').setDescription('Reported Discord user').setRequired(false))
  .addStringOption(o => o.setName('user_id').setDescription('Reported Discord user ID').setRequired(false));

function addReportOptions(command) {
  command
    .addStringOption(departmentOption('department', true))
    .addUserOption(o => o.setName('officer').setDescription('Officer being reported').setRequired(false))
    .addStringOption(o => o.setName('date').setDescription('Date of incident').setRequired(false))
    .addStringOption(o => o.setName('game_id').setDescription('In-game ID').setRequired(false))
    .addStringOption(o => o.setName('clip').setDescription('Clip URL').setRequired(false))
    .addStringOption(o => o.setName('description').setDescription('Description').setRequired(false))
    .addStringOption(o => o.setName('context').setDescription('Additional context').setRequired(false));
}
addReportOptions(commands.find(c => c.name === 'reportadd'));
addReportOptions(commands.find(c => c.name === 'anonreport'));

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  // Discord requires required options to appear before optional options.
  // Normalize every command (and any nested subcommands) before registration.
  const normalizeOptions = (options) => {
    if (!Array.isArray(options)) return options;
    const normalized = options.map((option) => {
      if (Array.isArray(option.options)) {
        return { ...option, options: normalizeOptions(option.options) };
      }
      return option;
    });
    return normalized.sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)));
  };

  const body = commands.map(c => {
    const json = c.toJSON();
    if (Array.isArray(json.options)) json.options = normalizeOptions(json.options);
    return json;
  });

  // Validate option ordering before Discord receives anything.
  for (const command of body) {
    if (Array.isArray(command.options)) {
      const seenOptional = command.options.some((o) => !o.required);
      const invalid = command.options.some((o, i) => o.required && command.options.slice(0, i).some((x) => !x.required));
      if (invalid) throw new Error(`Invalid required/optional option order in /${command.name}`);
    }
  }

  // Register every command globally. Reports/ride-alongs are still restricted
  // at runtime to LOG_GUILD_ID, while duty/hour commands work in every guild.
  const registered = await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
  console.log(`Registered ${Array.isArray(registered) ? registered.length : body.length} global commands.`);

  // Verify the application can see the commands immediately after registration.
  try {
    const verified = await rest.get(Routes.applicationCommands(CLIENT_ID));
    console.log(`Discord reports ${Array.isArray(verified) ? verified.length : 0} global commands currently registered.`);
  } catch (verifyError) {
    console.warn('Could not verify global command registration:', verifyError.message);
  }
}

function reportPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0xb94a48)
    .setTitle('Submit a Report')
    .setDescription('Use the dropdown below to submit a report against a department member.\n\nYour ticket will be created in a private channel visible only to you and the review team.\n\nFalse or malicious reports may result in disciplinary action.')
    .addFields(
      { name: 'Officer Report', value: 'Report misconduct or rule violations by a department officer.', inline: true },
      { name: 'Higher Up Report', value: 'Report misconduct by command staff or senior leadership.', inline: true }
    )
    .setFooter({ text: 'WCRP • Anonymous reports can be created with /anonreport in a report ticket.' });
}

function reportPanelRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('report_type')
      .setPlaceholder('Select a ticket type...')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Officer Report').setDescription('Report an officer').setValue('officer'),
        new StringSelectMenuOptionBuilder().setLabel('Higher Up Report').setDescription('Report a higher-up').setValue('higher')
      )
  );
}

function reportFieldsModal(type) {
  return new ModalBuilder()
    .setCustomId(`report_modal:${type}:named`)
    .setTitle(type === 'higher' ? 'Higher Up Report' : 'Officer Report')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('department').setLabel('Department').setStyle(TextInputStyle.Short).setPlaceholder('USM / SASP / BCSO / LSPD').setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('officer').setLabel('Officer being reported (User ID)').setStyle(TextInputStyle.Short).setPlaceholder('Optional Discord user ID').setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Date of incident').setStyle(TextInputStyle.Short).setPlaceholder('Optional').setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('clip').setLabel('Clip / evidence URL').setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Description / context').setStyle(TextInputStyle.Paragraph).setRequired(false))
    );
}

function buildReportEmbed({ anonymous, type, department, dateOfIncident, gameId, reportedUserId, clip, description, context }) {
  return new EmbedBuilder()
    .setColor(type === 'higher' ? 0x6d5dfc : 0x2f80ed)
    .setTitle(anonymous ? 'Anonymous Report' : (type === 'higher' ? 'Higher Up Report' : 'Officer Report'))
    .addFields(
      { name: 'Department', value: `${department} — ${deptName(department)}` },
      { name: 'Date of incident', value: dateOfIncident || 'Not provided', inline: true },
      { name: 'In-Game ID', value: gameId || 'Not provided', inline: true },
      { name: 'Officer being reported', value: reportedUserId ? `<@${reportedUserId}> (${reportedUserId})` : 'Not provided', inline: false },
      { name: 'Clip', value: clip || 'Not provided', inline: false },
      { name: 'Description', value: description || 'Not provided', inline: false },
      { name: 'Additional context', value: context || 'Not provided', inline: false }
    )
    .setFooter({ text: `Submitted ${formatShort(now())}` });
}

async function reportConfig(guildId, department = null) {
  const values = [];
  for (const d of DEPARTMENTS) {
    const roleIds = await getJsonSetting(`reportRoles:${d}`, [], guildId);
    values.push(`${d}: ${roleIds.map(id => `<@&${id}>`).join(', ') || 'Not configured'}`);
  }
  const categoryId = await getSetting('reportCategoryId', null, guildId);
  values.push(`Category: ${categoryId ? `<#${categoryId}>` : 'Not configured'}`);
  return values.join('\n');
}

async function createReportTicket({ interaction, type, department, anonymous, dateOfIncident, gameId, clip, description, context, reportedUserId = null }) {
  if (!requireLogServer(interaction)) return null;
  const guild = interaction.guild;
  const departmentRoles = await getJsonSetting(`reportRoles:${department}`, [], guild.id);
  const staffRoles = await getJsonSetting('reportStaffRoles', [], guild.id);
  const categoryId = await getSetting('reportCategoryId', null, guild.id);
  const permissionOverwrites = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
  if (!anonymous) permissionOverwrites.push({ id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  for (const roleId of [...new Set([...departmentRoles, ...staffRoles])]) {
    if (guild.roles.cache.has(roleId)) permissionOverwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }
  const channel = await guild.channels.create({
    name: anonymous ? `anon-${department.toLowerCase()}` : `report-${department.toLowerCase()}-${cleanName(interaction.member.displayName || interaction.user.username)}`,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites
  });
  await q(
    `INSERT INTO reports (channelId,ticketType,department,reporterId,reportedUserId,dateOfIncident,gameId,clip,description,context,anonymous,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [channel.id, type, department, anonymous ? null : interaction.user.id, reportedUserId, dateOfIncident || null, gameId || null, clip || null, description || null, context || null, anonymous ? 1 : 0, now()]
  );
  if (anonymous && reportedUserId) {
    await channel.permissionOverwrites.edit(reportedUserId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
  }
  const roleMentions = departmentRoles.map(id => `<@&${id}>`).join(' ');
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report_close:${channel.id}`).setLabel('Close').setStyle(ButtonStyle.Danger)
  );
  await channel.send({
    content: roleMentions || undefined,
    embeds: [buildReportEmbed({ anonymous, type, department, dateOfIncident, gameId, reportedUserId, clip, description, context })],
    components: [buttons]
  });
  return channel;
}

async function clearChannel(channel) {
  for (let round = 0; round < 30; round++) {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages?.size) break;
    for (const message of messages.values()) await message.delete().catch(() => {});
    if (messages.size < 100) break;
  }
}

async function makeTranscript(channel) {
  const all = [];
  let before;
  for (let i = 0; i < 20; i++) {
    const messages = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!messages?.size) break;
    all.push(...messages.values());
    before = messages.last().id;
    if (messages.size < 100) break;
  }
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return all.map(m => {
    const attachmentText = m.attachments.size ? ` Attachments: ${[...m.attachments.values()].map(a => a.url).join(', ')}` : '';
    return `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content || '[embed/attachment]'}${attachmentText}`;
  }).join('\n');
}

async function ensureReportPermissions(member) { return roleAllowed(member, 'reportStaffRoles'); }

async function updateReportEmbed(channelId, changes) {
  const rows = await q('SELECT * FROM reports WHERE channelId=? LIMIT 1', [channelId]);
  const report = rows[0];
  if (!report) return false;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const reportMessage = messages ? [...messages.values()].find(m => m.embeds[0]?.title?.includes('Report')) : null;
  if (!reportMessage) return false;
  const next = { ...report, ...changes };
  const embed = buildReportEmbed({
    anonymous: Number(next.anonymous) === 1,
    type: next.ticketType,
    department: next.department,
    dateOfIncident: next.dateOfIncident,
    gameId: next.gameId,
    reportedUserId: next.reportedUserId,
    clip: next.clip,
    description: next.description,
    context: next.context
  });
  await reportMessage.edit({ embeds: [embed] });
  return true;
}

async function handleHours(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  const department = interaction.options.getString('department');
  const timeframe = interaction.options.getString('timeframe') || 'this_week';
  const window = windowFor(timeframe);
  const seconds = await totalDutySeconds({ discordId: user.id, department, window });
  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('Duty Hours')
    .addFields(
      { name: 'Member', value: `<@${user.id}>`, inline: true },
      { name: 'Department', value: `${department} — ${deptName(department)}`, inline: true },
      { name: 'Time frame', value: timeframeLabel(timeframe), inline: true },
      { name: 'Hours', value: hoursText(seconds) }
    );
  await replyInteraction(interaction, { embeds: [embed] });
}

async function handleDepartmentHours(interaction, mode) {
  const department = interaction.options.getString('department');
  const timeframe = interaction.options.getString('timeframe') || 'this_week';
  const window = windowFor(timeframe);
  const rows = await q(
    `SELECT discordId,
            SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))) seconds
     FROM duty_hours
     WHERE department=? AND inTime IS NOT NULL AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ? AND discordId IS NOT NULL
     GROUP BY discordId ORDER BY seconds DESC`,
    [window.end, window.start, department, window.end, window.start]
  );
  if (mode === 'total') {
    const total = rows.reduce((sum, row) => sum + Number(row.seconds || 0), 0);
    return replyInteraction(interaction, { embeds: [new EmbedBuilder().setColor(0x3b82f6).setTitle('Department Hours').addFields(
      { name: 'Department', value: `${department} — ${deptName(department)}` },
      { name: 'Time frame', value: timeframeLabel(timeframe), inline: true },
      { name: 'Total', value: hoursText(total), inline: true }
    )] });
  }
  const shown = rows.slice(0, mode === 'leaderboard' ? 10 : 25);
  const description = shown.length ? shown.map((r, i) => `${i + 1}. <@${r.discordId}> — ${hoursText(Number(r.seconds))}`).join('\n') : 'No recorded hours.';
  return replyInteraction(interaction, { embeds: [new EmbedBuilder().setColor(0x3b82f6).setTitle(mode === 'leaderboard' ? 'Department Leaderboard' : 'Department Hours').setDescription(description).setFooter({ text: `${department} • ${timeframeLabel(timeframe)}` })] });
}

async function handleEvaluate(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  const department = interaction.options.getString('department');
  const window = getWeekWindow();
  const requiredHours = Number(await getSetting(`requirement:${department}`, '8'));
  const total = await totalDutySeconds({ discordId: user.id, department, window });
  const requiredSeconds = requiredHours * 3600;
  const remaining = Math.max(0, requiredSeconds - total);
  return replyInteraction(interaction, { embeds: [
    new EmbedBuilder()
      .setColor(total >= requiredSeconds ? 0x2f9e44 : 0xe04f5f)
      .setTitle(`${department} Weekly Evaluation`)
      .addFields(
        { name: 'Member', value: `<@${user.id}>`, inline: true },
        { name: 'Hours Worked', value: hoursText(total), inline: true },
        { name: 'Required', value: `${requiredHours.toFixed(2)}h`, inline: true },
        { name: 'Status', value: total >= requiredSeconds ? 'Requirement Met' : 'Below Requirement', inline: true },
        { name: 'Remaining', value: hoursText(remaining), inline: true }
      )
      .setFooter({ text: 'Friday to Thursday' })
  ] });
}

function assertDepartment(value) {
  const department = String(value || '').toUpperCase();
  return DEPARTMENTS.includes(department) ? department : null;
}

async function handleCommand(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  if (ADMIN_COMMANDS.has(name)) {
    if (!await requireAdmin(interaction)) return;
  } else if (!await requireCommandPermission(interaction)) {
    return;
  }

  if (LOG_SERVER_COMMANDS.has(name) && interaction.guildId !== LOG_GUILD_ID) {
    return replyInteraction(interaction, { content: 'This command is only available in the configured reports and ride-along server.', ephemeral: true });
  }

  if (name === 'officer-report-panel') {
    await interaction.channel.send({ embeds: [reportPanelEmbed()], components: [reportPanelRow()] });
    return replyInteraction(interaction, { content: 'Report panel posted.', ephemeral: true });
  }

  if (name === 'admin-roles') {
    const action = interaction.options.getString('action');
    const role = interaction.options.getRole('role');
    let roles = await getJsonSetting('adminRoles', [], interaction.guild.id);
    if (action === 'add' && role) roles = [...new Set([...roles, role.id])];
    if (action === 'remove' && role) roles = roles.filter(id => id !== role.id);
    if (action === 'clear') roles = [];
    await setJsonSetting('adminRoles', roles, interaction.guild.id);
    return replyInteraction(interaction, { content: `Administrator roles: ${roles.length ? roles.map(id => `<@&${id}>`).join(', ') : 'None'}`, ephemeral: true });
  }

  if (name === 'permissions') {
    const action = interaction.options.getString('action');
    const command = String(interaction.options.getString('command') || '').toLowerCase().replace(/^\//, '');
    const role = interaction.options.getRole('role');
    let roles = await getJsonSetting(`cmdperm:${command}`, [], interaction.guild.id);
    if (action === 'view') return replyInteraction(interaction, { content: `${command}: ${roles.length ? roles.map(id => `<@&${id}>`).join(', ') : 'Everyone'}`, ephemeral: true });
    if (action === 'add' && role) roles = [...new Set([...roles, role.id])];
    if (action === 'remove' && role) roles = roles.filter(id => id !== role.id);
    if (action === 'clear') roles = [];
    await setJsonSetting(`cmdperm:${command}`, roles, interaction.guild.id);
    return replyInteraction(interaction, { content: `${command}: ${roles.length ? roles.map(id => `<@&${id}>`).join(', ') : 'Everyone'}`, ephemeral: true });
  }

  if (name === 'report-config') {
    const department = interaction.options.getString('department')?.toUpperCase() || null;
    const role = interaction.options.getRole('role');
    const category = interaction.options.getChannel('category');
    if (department && role) await setJsonSetting(`reportRoles:${department}`, [role.id], interaction.guild.id);
    if (category) await setSetting('reportCategoryId', category.id, interaction.guild.id);
    return replyInteraction(interaction, { content: await reportConfig(interaction.guild.id), ephemeral: true });
  }

  if (name === 'report-staff') {
    const action = interaction.options.getString('action');
    const role = interaction.options.getRole('role');
    let roles = await getJsonSetting('reportStaffRoles', [], interaction.guild.id);
    if (action === 'view') return replyInteraction(interaction, { content: `Report staff roles: ${roles.length ? roles.map(id => `<@&${id}>`).join(', ') : 'None'}`, ephemeral: true });
    if (action === 'add' && role) roles = [...new Set([...roles, role.id])];
    if (action === 'remove' && role) roles = roles.filter(id => id !== role.id);
    if (action === 'clear') roles = [];
    await setJsonSetting('reportStaffRoles', roles, interaction.guild.id);
    return replyInteraction(interaction, { content: `Report staff roles: ${roles.length ? roles.map(id => `<@&${id}>`).join(', ') : 'None'}`, ephemeral: true });
  }

  if (name === 'ridealong-permissions') {
    const action = interaction.options.getString('action');
    const role = interaction.options.getRole('role');
    let roles = await getJsonSetting('ridealongRoles', [], interaction.guild.id);
    if (action === 'view') return replyInteraction(interaction, { content: `Ride-along permission roles: ${roles.length ? roles.map(id => `<@&${id}>`).join(', ') : 'None'}`, ephemeral: true });
    if (action === 'add' && role) roles = [...new Set([...roles, role.id])];
    if (action === 'remove' && role) roles = roles.filter(id => id !== role.id);
    if (action === 'clear') roles = [];
    await setJsonSetting('ridealongRoles', roles, interaction.guild.id);
    return replyInteraction(interaction, { content: `Ride-along permission roles: ${roles.length ? roles.map(id => `<@&${id}>`).join(', ') : 'None'}`, ephemeral: true });
  }

  if (name === 'ridealong-config') {
    const action = interaction.options.getString('action');
    const rideRole = interaction.options.getRole('ridealong_role');
    const traineeRole = interaction.options.getRole('trainee_role');
    if (action === 'set') {
      if (rideRole) await setSetting('ridealongResultRoleId', rideRole.id, interaction.guild.id);
      if (traineeRole) await setSetting('traineeRoleId', traineeRole.id, interaction.guild.id);
    } else if (action === 'clear') {
      await setSetting('ridealongResultRoleId', '', interaction.guild.id);
      await setSetting('traineeRoleId', '', interaction.guild.id);
    }
    const currentRide = await getSetting('ridealongResultRoleId', null, interaction.guild.id);
    const currentTrainee = await getSetting('traineeRoleId', null, interaction.guild.id);
    return replyInteraction(interaction, { content: `Ride-along role: ${currentRide ? `<@&${currentRide}>` : 'Not configured'}\nTrainee role: ${currentTrainee ? `<@&${currentTrainee}>` : 'Not configured'}`, ephemeral: true });
  }

  if (name === 'log-config') {
    const type = interaction.options.getString('type');
    const channel = interaction.options.getChannel('channel');
    if (channel) await setSetting(type === 'report_log' ? 'reportLogChannelId' : type === 'transcript_log' ? 'transcriptChannelId' : 'ridealongLogChannelId', channel.id, interaction.guild.id);
    const key = type === 'report_log' ? 'reportLogChannelId' : type === 'transcript_log' ? 'transcriptChannelId' : 'ridealongLogChannelId';
    const value = await getSetting(key, null, interaction.guild.id);
    return replyInteraction(interaction, { content: `${type}: ${value ? `<#${value}>` : 'Not configured'}`, ephemeral: true });
  }

  if (name === 'addofficer') {
    if (!await ensureReportPermissions(interaction.member)) return replyInteraction(interaction, { content: 'Reports team permission required.', ephemeral: true });
    const user = interaction.options.getUser('user');
    const userId = interaction.options.getString('user_id')?.trim();
    const targetId = user?.id || userId?.replace(/[<@!>]/g, '');
    if (!/^\d{17,20}$/.test(String(targetId || ''))) return replyInteraction(interaction, { content: 'Provide a valid Discord user or Discord user ID.', ephemeral: true });
    const reportRows = await q('SELECT * FROM reports WHERE channelId=? LIMIT 1', [interaction.channel.id]);
    if (!reportRows[0]) return replyInteraction(interaction, { content: 'This is not a report ticket.', ephemeral: true });
    await q('UPDATE reports SET reportedUserId=? WHERE channelId=?', [targetId, interaction.channel.id]);
    await interaction.channel.permissionOverwrites.edit(targetId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
    await updateReportEmbed(interaction.channel.id, { reportedUserId: targetId });
    return replyInteraction(interaction, { content: `Officer being reported set to <@${targetId}>.` });
  }

  if (name === 'reportadd') {
    if (!await ensureReportPermissions(interaction.member)) return replyInteraction(interaction, { content: 'Reports team permission required.', ephemeral: true });
    const department = assertDepartment(interaction.options.getString('department'));
    return createReportTicket({
      interaction,
      type: 'officer',
      department,
      anonymous: false,
      reportedUserId: interaction.options.getUser('officer')?.id || null,
      dateOfIncident: interaction.options.getString('date'),
      gameId: interaction.options.getString('game_id'),
      clip: interaction.options.getString('clip'),
      description: interaction.options.getString('description'),
      context: interaction.options.getString('context')
    }).then(channel => replyInteraction(interaction, { content: channel ? `Report created: ${channel}` : 'Unable to create the report.', ephemeral: true }));
  }

  if (name === 'anonreport') {
    const currentRows = await q('SELECT * FROM reports WHERE channelId=? LIMIT 1', [interaction.channel.id]);
    const current = currentRows[0];
    const isStaff = await ensureReportPermissions(interaction.member);
    const isOwner = !!current?.reporterId && current.reporterId === interaction.user.id;
    if (!isStaff && !isOwner && !(await isAdmin(interaction.member))) return replyInteraction(interaction, { content: 'Only the report owner or reports team can make a report anonymous.' });
    const department = assertDepartment(interaction.options.getString('department'));
    if (!department) return replyInteraction(interaction, { content: 'Department must be USM, SASP, BCSO or LSPD.' });
    if (!current) {
      const channel = await createReportTicket({
        interaction,
        type: 'officer',
        department,
        anonymous: true,
        dateOfIncident: interaction.options.getString('date'),
        gameId: interaction.options.getString('game_id'),
        clip: interaction.options.getString('clip'),
        description: interaction.options.getString('description'),
        context: interaction.options.getString('context'),
        reportedUserId: interaction.options.getUser('officer')?.id || null
      });
      return replyInteraction(interaction, { content: channel ? `Anonymous report created: ${channel}` : 'Unable to create the anonymous report.' });
    }

    const reportedUserId = current.reportedUserId || interaction.options.getUser('officer')?.id || null;
    const dateOfIncident = interaction.options.getString('date') || current.dateOfIncident;
    const gameId = interaction.options.getString('game_id') || current.gameId;
    const clip = interaction.options.getString('clip') || current.clip;
    const description = interaction.options.getString('description') || current.description;
    const context = interaction.options.getString('context') || current.context;

    await clearChannel(interaction.channel);
    // Remove the reporter from the ticket. Keep the reported person, department
    // report roles and the configured report staff roles.
    if (current.reporterId) {
      await interaction.channel.permissionOverwrites.delete(current.reporterId).catch(() => {});
    }
    if (reportedUserId) {
      await interaction.channel.permissionOverwrites.edit(reportedUserId, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true
      }).catch(() => {});
    }

    const departmentRoles = await getJsonSetting(`reportRoles:${department}`, [], interaction.guild.id);
    const roleMentions = departmentRoles.map(id => `<@&${id}>`).join(' ');
    await q(
      'UPDATE reports SET department=?,dateOfIncident=?,gameId=?,clip=?,description=?,context=?,reportedUserId=?,anonymous=1 WHERE channelId=?',
      [department, dateOfIncident || null, gameId || null, clip || null, description || null, context || null, reportedUserId, interaction.channel.id]
    );
    await interaction.channel.setName(`anon-${department.toLowerCase()}`).catch(() => {});
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`report_close:${interaction.channel.id}`).setLabel('Close').setStyle(ButtonStyle.Danger)
    );
    await interaction.channel.send({
      content: roleMentions || undefined,
      embeds: [buildReportEmbed({ anonymous: true, type: current.ticketType || 'officer', department, dateOfIncident, gameId, reportedUserId, clip, description, context })],
      components: [buttons]
    });
    return replyInteraction(interaction, { content: 'Anonymous report created and the reporter has been removed from the ticket.' });
  }

  if (name === 'rename') {
    const rows = await q('SELECT reporterId FROM reports WHERE channelId=? LIMIT 1', [interaction.channel.id]);
    if (!rows[0]) return replyInteraction(interaction, { content: 'This is not a report ticket.', ephemeral: true });
    const owner = rows[0].reporterId || interaction.user.id;
    const user = await getDiscordUser(owner);
    const base = cleanName(user?.username || interaction.user.username);
    await interaction.channel.setName(`${base}-handling`);
    return replyInteraction(interaction, { content: `Channel renamed to ${base}-handling.` });
  }

  if (name === 'close') {
    if (!await ensureReportPermissions(interaction.member)) return replyInteraction(interaction, { content: 'Reports team permission required.', ephemeral: true });
    const rows = await q('SELECT reporterId FROM reports WHERE channelId=? LIMIT 1', [interaction.channel.id]);
    if (!rows[0]) return replyInteraction(interaction, { content: 'This is not a report ticket.', ephemeral: true });
    if (rows[0].reporterId) await interaction.channel.permissionOverwrites.edit(rows[0].reporterId, { ViewChannel: false, SendMessages: false }).catch(() => {});
    await q('UPDATE reports SET closedAt=? WHERE channelId=?', [now(), interaction.channel.id]);
    return replyInteraction(interaction, { content: 'Ticket closed.' });
  }

  if (name === 'delete') {
    if (!await ensureReportPermissions(interaction.member) && !(await isAdmin(interaction.member))) return replyInteraction(interaction, { content: 'Reports team permission required.', ephemeral: true });
    const reportRows = await q('SELECT * FROM reports WHERE channelId=? LIMIT 1', [interaction.channel.id]);
    if (!reportRows[0]) return replyInteraction(interaction, { content: 'This is not a report ticket.', ephemeral: true });
    const transcript = await makeTranscript(interaction.channel);
    const transcriptId = await getSetting('transcriptChannelId', null, interaction.guild.id);
    const transcriptChannel = transcriptId ? interaction.guild.channels.cache.get(transcriptId) : null;
    if (transcriptChannel) {
      await transcriptChannel.send({
        content: `Transcript for #${interaction.channel.name}`,
        files: [{ attachment: Buffer.from(transcript || 'No messages.'), name: `${interaction.channel.name}-transcript.txt` }]
      }).catch(() => {});
    }
    await replyInteraction(interaction, { content: 'Saving transcript and deleting ticket...' });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 1000);
    return;
  }

  if (name === 'ridealong') {
    if (interaction.options.getSubcommand(false) !== 'log') return replyInteraction(interaction, { content: 'Use /ridealong log.' });
    if (!await roleAllowed(interaction.member, 'ridealongRoles')) return replyInteraction(interaction, { content: 'You do not have permission to log ride-alongs.' });
    const player = interaction.options.getUser('player');
    const department = assertDepartment(interaction.options.getString('department'));
    const result = interaction.options.getString('result');
    const configuredRoleId = await getSetting('ridealongResultRoleId', null, interaction.guild.id);
    const traineeRoleId = await getSetting('traineeRoleId', null, interaction.guild.id);
    const notes = interaction.options.getString('notes');
    const roleId = configuredRoleId || null;

    const member = await interaction.guild.members.fetch(player.id).catch(() => null);
    if (member && traineeRoleId && member.roles.cache.has(traineeRoleId)) {
      await member.roles.remove(traineeRoleId, `Ride-along logged by ${interaction.user.tag}`).catch(() => {});
    }
    if (member && result === 'Passed' && roleId) {
      await member.roles.add(roleId, `Ride-along passed and logged by ${interaction.user.tag}`).catch(() => {});
    }

    await q(
      'INSERT INTO ridealongs (discordId,department,ridealongRoleId,result,notes,createdBy,createdAt) VALUES (?,?,?,?,?,?,?)',
      [player.id, department, roleId, result, notes || null, interaction.user.id, now()]
    );

    const logChannelId = await getSetting('ridealongLogChannelId', null, interaction.guild.id);
    const logChannel = logChannelId ? interaction.guild.channels.cache.get(logChannelId) : null;
    const embed = new EmbedBuilder()
      .setColor(result === 'Passed' ? 0x2f9e44 : 0xe04f5f)
      .setTitle('Ride-Along Log')
      .addFields(
        { name: 'Player', value: `<@${player.id}>`, inline: true },
        { name: 'Department', value: `${department} — ${deptName(department)}`, inline: true },
        { name: 'Result', value: result, inline: true },
        { name: 'Ride-Along Role', value: roleId ? `<@&${roleId}>` : 'Not configured', inline: true },
        { name: 'Trainee Role', value: traineeRoleId ? `<@&${traineeRoleId}> removed if present` : 'Not configured', inline: true },
        { name: 'Notes', value: notes || 'None', inline: false },
        { name: 'Logged By', value: `<@${interaction.user.id}>`, inline: true }
      )
      .setFooter({ text: `WCRP Department Utilities • ${formatShort(now())}` });
    if (logChannel) await logChannel.send({ embeds: [embed] }).catch(() => {});
    return replyInteraction(interaction, { embeds: [embed] });
  }

  if (name === 'hours') return handleHours(interaction);
  if (['allhours', 'totalhours', 'weeklydeptours', 'leaderboard'].includes(name)) return handleDepartmentHours(interaction, name === 'totalhours' ? 'total' : name);

  if (name === 'deptofhours') {
    const department = interaction.options.getString('department');
    const timeframe = interaction.options.getString('timeframe') || 'this_week';
    const window = windowFor(timeframe);
    const rows = await q(
      `SELECT discordId, SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))) seconds
       FROM duty_hours WHERE department=? AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ? AND discordId IS NOT NULL
       GROUP BY discordId ORDER BY seconds DESC LIMIT 10`,
      [window.end, window.start, department, window.end, window.start]
    );
    const description = rows.length ? rows.map((r, i) => `${i + 1}. <@${r.discordId}> — ${hoursText(Number(r.seconds))}`).join('\n') : 'No recorded hours.';
    return replyInteraction(interaction, { embeds: [new EmbedBuilder().setColor(0x3b82f6).setTitle(`Top ${department} Officers`).setDescription(description)] });
  }

  if (name === 'tophours') {
    const rows = await q(`SELECT discordId, SUM(GREATEST(0, COALESCE(outTime, UNIX_TIMESTAMP()) - inTime)) seconds FROM duty_hours WHERE discordId IS NOT NULL GROUP BY discordId ORDER BY seconds DESC LIMIT 5`);
    const description = rows.length ? rows.map((r, i) => `${i + 1}. <@${r.discordId}> — ${hoursText(Number(r.seconds))}`).join('\n') : 'No recorded hours.';
    return replyInteraction(interaction, { embeds: [new EmbedBuilder().setColor(0x3b82f6).setTitle('Top Hours').setDescription(description)] });
  }

  if (name === 'evaluate') return handleEvaluate(interaction);

  if (name === 'inactive_officers' || name === 'dept_officers') {
    const department = interaction.options.getString('department');
    const weeks = interaction.options.getInteger('weeks_back') || 2;
    const cutoff = now() - weeks * 7 * 86400;
    const rows = await q(`SELECT discordId, MAX(COALESCE(outTime, UNIX_TIMESTAMP())) lastDuty FROM duty_hours WHERE department=? AND discordId IS NOT NULL GROUP BY discordId HAVING lastDuty < ? ORDER BY lastDuty ASC`, [department, cutoff]);
    const description = rows.length ? rows.map(r => `<@${r.discordId}> — last duty ${formatShort(Number(r.lastDuty))}`).join('\n') : 'No inactive officers found.';
    return replyInteraction(interaction, { embeds: [new EmbedBuilder().setColor(0xe0a458).setTitle(`${department} Inactive Officers`).setDescription(description).setFooter({ text: `${weeks}+ weeks without duty` })] });
  }

  if (name === 'promotions') {
    const department = interaction.options.getString('department');
    const minimum = interaction.options.getInteger('min_hours') ?? 8;
    const window = getWeekWindow();
    const rows = await q(`SELECT discordId, SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))) seconds FROM duty_hours WHERE department=? AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ? AND discordId IS NOT NULL GROUP BY discordId HAVING seconds >= ? ORDER BY seconds DESC`, [window.end, window.start, department, window.end, window.start, minimum * 3600]);
    const description = rows.length ? rows.map(r => `<@${r.discordId}> — ${hoursText(Number(r.seconds))}`).join('\n') : 'No members meet the current threshold.';
    return replyInteraction(interaction, { embeds: [new EmbedBuilder().setColor(0x3b82f6).setTitle(`${department} Promotion Eligibility`).setDescription(description).setFooter({ text: `Minimum ${minimum}h this week` })] });
  }

  if (name === 'leomulti') {
    const duration = interaction.options.getInteger('duration_minutes');
    const multiplier = interaction.options.getNumber('multiplier') || 1.5;
    await setJsonSetting('leoMultiplier', { multiplier, until: now() + duration * 60 });
    return replyInteraction(interaction, { content: `LEO hour multiplier started at ${multiplier}x for ${duration} minutes.` });
  }

  if (name === 'add_org') {
    const code = interaction.options.getString('code').toUpperCase();
    const orgName = interaction.options.getString('name');
    await q('INSERT INTO department_orgs (code,name,createdBy) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [code, orgName, interaction.user.id]);
    return replyInteraction(interaction, { content: `Added organisation ${code} — ${orgName}.`, ephemeral: true });
  }

  if (name === 'add_org_hours') {
    const code = interaction.options.getString('code').toUpperCase();
    const hours = interaction.options.getNumber('hours');
    const reason = interaction.options.getString('reason');
    await q('INSERT INTO org_hours_adjustments (orgCode,hours,reason,createdBy,createdAt) VALUES (?,?,?,?,?)', [code, hours, reason || null, interaction.user.id, now()]);
    return replyInteraction(interaction, { content: `Added ${hours.toFixed(2)} hours to ${code}.`, ephemeral: true });
  }

  if (name === 'rename_org') {
    const oldCode = interaction.options.getString('old_code').toUpperCase();
    const newCode = interaction.options.getString('new_code').toUpperCase();
    const orgName = interaction.options.getString('name');
    await q('UPDATE department_orgs SET code=?,name=? WHERE code=?', [newCode, orgName, oldCode]);
    await q('UPDATE org_hours_adjustments SET orgCode=? WHERE orgCode=?', [newCode, oldCode]);
    return replyInteraction(interaction, { content: `Renamed ${oldCode} to ${newCode}.`, ephemeral: true });
  }
}

client.on('interactionCreate', async interaction => {
  try {
    // Acknowledge slow operations immediately so Discord never shows
    // "Application did not respond" while MySQL or Discord API calls run.
    if (interaction.isChatInputCommand()) {
      const privateCommands = new Set([
        'admin-roles', 'permissions', 'report-config', 'report-staff',
        'log-config', 'ridealong-permissions', 'ridealong-config',
        'officer-report-panel', 'add_org', 'add_org_hours', 'rename_org',
        'anonreport', 'addofficer', 'reportadd', 'rename', 'close', 'delete'
      ]);
      await interaction.deferReply({ ephemeral: privateCommands.has(interaction.commandName) });
    } else if (interaction.isButton()) {
      await interaction.deferReply({ ephemeral: true });
    } else if (interaction.isModalSubmit()) {
      await interaction.deferReply({ ephemeral: true });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'report_type') {
      if (!requireLogServer(interaction)) return;
      return interaction.showModal(reportFieldsModal(interaction.values[0]));
    }

    if (interaction.isButton() && interaction.customId.startsWith('report_close:')) {
      if (!requireLogServer(interaction)) return;
      if (!await ensureReportPermissions(interaction.member)) return replyInteraction(interaction, { content: 'Reports team permission required.', ephemeral: true });
      const rows = await q('SELECT reporterId FROM reports WHERE channelId=? LIMIT 1', [interaction.channel.id]);
      if (rows[0]?.reporterId) await interaction.channel.permissionOverwrites.edit(rows[0].reporterId, { ViewChannel: false, SendMessages: false }).catch(() => {});
      await q('UPDATE reports SET closedAt=? WHERE channelId=?', [now(), interaction.channel.id]);
      return replyInteraction(interaction, { content: 'Ticket closed.' });
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('report_modal:')) {
      if (!requireLogServer(interaction)) return;
      const [, type] = interaction.customId.split(':');
      const department = assertDepartment(interaction.fields.getTextInputValue('department'));
      if (!department) return replyInteraction(interaction, { content: 'Department must be USM, SASP, BCSO or LSPD.', ephemeral: true });
      const details = interaction.fields.getTextInputValue('details') || '';
      const rawOfficer = interaction.fields.getTextInputValue('officer')?.trim() || '';
      const cleanedOfficer = rawOfficer.replace(/[<@!>]/g, '');
      const reportedUserId = /^\d{17,20}$/.test(cleanedOfficer) ? cleanedOfficer : null;
      const channel = await createReportTicket({
        interaction,
        type,
        department,
        anonymous: false,
        dateOfIncident: interaction.fields.getTextInputValue('date'),
        gameId: null,
        clip: interaction.fields.getTextInputValue('clip'),
        description: details,
        context: '',
        reportedUserId
      });
      return replyInteraction(interaction, { content: channel ? `Report created: ${channel}` : 'Unable to create the report.', ephemeral: true });
    }

    return handleCommand(interaction);
  } catch (error) {
    console.error('Interaction error:', error);
    const message = error?.code === 'DB_QUERY_TIMEOUT'
      ? 'The database did not respond in time. Check the MySQL connection settings.'
      : 'An error occurred while processing that request.';
    if (interaction.deferred) await interaction.editReply({ content: message }).catch(() => {});
    else if (interaction.replied) await interaction.followUp({ content: message }).catch(() => {});
    else await interaction.reply({ content: message }).catch(() => {});
  }
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
  // Register Discord commands FIRST so a database/schema problem cannot prevent
  // slash commands from being published.
  try {
    await registerCommands();
  } catch (error) {
    console.error('GLOBAL COMMAND REGISTRATION FAILED:', error);
  }

  // Database availability must never prevent the Discord bot/commands from running.
  const startDutyTracking = async () => {
    try {
      await ensureSchema();
      await pollDuty();
      if (!globalThis.__dutyInterval) {
        globalThis.__dutyInterval = setInterval(() => pollDuty().catch((e) => console.error('Duty poll error:', e.message)), DUTY_POLL_MS);
      }
      console.log('DATABASE / DUTY TRACKING ONLINE');
    } catch (error) {
      console.error('DATABASE / DUTY STARTUP ERROR:', error.message);
      console.error('Duty tracking will retry on the next poll interval.');
      if (!globalThis.__dbRetryInterval) {
        globalThis.__dbRetryInterval = setInterval(async () => {
          try {
            await ensureSchema();
            await pollDuty();
            clearInterval(globalThis.__dbRetryInterval);
            globalThis.__dbRetryInterval = null;
            globalThis.__dutyInterval = setInterval(() => pollDuty().catch((e) => console.error('Duty poll error:', e.message)), DUTY_POLL_MS);
            console.log('DATABASE / DUTY TRACKING ONLINE');
          } catch (retryError) {
            console.error('DATABASE RETRY FAILED:', retryError.message);
          }
        }, Math.max(DUTY_POLL_MS, 30000));
      }
    }
  };
  await startDutyTracking();
});

process.on('SIGINT', async () => { await pool.end().catch(() => {}); process.exit(0); });
process.on('SIGTERM', async () => { await pool.end().catch(() => {}); process.exit(0); });

client.login(TOKEN);
