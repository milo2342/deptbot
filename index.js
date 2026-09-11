require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  MessageFlags,
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

const TOKEN = process.env.DISCORD_TOKEN || '';
const CLIENT_ID = process.env.CLIENT_ID || '';
const REPORT_GUILD_ID = '1499578614298181642';
const TIMEZONE = process.env.TIMEZONE || 'Europe/London';
const DUTY_POLL_MS = Math.max(2000, Number(process.env.DUTY_POLL_MS || 5000));
const DB_TIMEOUT_MS = Math.max(500, Number(process.env.DB_TIMEOUT_MS || 1500));
const DB_RETRY_COOLDOWN_MS = Math.max(5000, Number(process.env.DB_RETRY_COOLDOWN_MS || 15000));
const SETTINGS_CACHE_FILE = path.join(__dirname, 'settings-cache.json');

const DEFAULT_DEPARTMENTS = [
  { code: 'USM', name: 'United States Marshals' },
  { code: 'SASP', name: 'San Andreas State Police' },
  { code: 'BCSO', name: "Blaine County Sheriff's Office" },
  { code: 'LSPD', name: 'Los Santos Police Department' }
];
const departmentRegistry = new Map(DEFAULT_DEPARTMENTS.map(({ code, name }) => [code, name]));
// Kept as a mutable array for compatibility with existing report parsing/tests/exports.
const DEPARTMENTS = [...departmentRegistry.keys()];
const LEO_VOICE_CHANNELS = [
  '1542399560394088538',
  '1542399564588261446',
  '1542399567234994206'
];

const ADMIN_COMMANDS = new Set([
  'admin-roles', 'permissions', 'report-config', 'report-staff', 'higherup-config',
  'ridealong-permissions', 'ridealong-config', 'log-config', 'dept-config', 'dept',
  'officer-report-panel', 'add', 'add_org', 'add_org_hours', 'rename_org'
]);

const REPORT_COMMANDS = new Set([
  'officer-report-panel', 'anonreport', 'addofficer', 'reportadd',
  'report-config', 'report-staff', 'higherup-config', 'log-config', 'rename', 'close', 'delete',
  'dept-config', 'dept', 'approve', 'denied'
]);

const REPORT_GUILD_COMMANDS = new Set([
  ...REPORT_COMMANDS, 'ridealong', 'ridealong-permissions', 'ridealong-config'
]);

const PRIVATE_COMMANDS = new Set([
  ...ADMIN_COMMANDS, 'anonreport', 'addofficer', 'reportadd', 'rename', 'close', 'delete', 'approve', 'denied'
]);

class DatabaseUnavailableError extends Error {
  constructor(message = 'MySQL is currently unavailable.') {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

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

let pool = null;
let dbUnavailableUntil = 0;
let databaseOffline = false;
const activeDuty = new Map();
const pendingVoice = new Map();
const reportCache = new Map();
const departmentPurchaseDrafts = new Map();
const settingsCache = loadSettingsCache();
const dirtySettings = new Set();

function hydrateDepartmentsFromLocalCache() {
  const raw = settingsCache[settingKey(null, 'departments')];
  if (!raw) return;
  try {
    const stored = JSON.parse(raw);
    if (!Array.isArray(stored)) return;
    for (const entry of stored) {
      if (entry && typeof entry === 'object') registerDepartmentLocal(entry.code, entry.name);
    }
  } catch {
    // Keep the four built-in departments if a local cache entry is malformed.
  }
}

hydrateDepartmentsFromLocalCache();

function now() { return Math.floor(Date.now() / 1000); }
function localDateTime(ts) { return DateTime.fromSeconds(Number(ts), { zone: TIMEZONE }); }
function formatDateTime(ts) { return localDateTime(ts).toFormat('cccc, dd LLLL yyyy HH:mm'); }
function formatShort(ts) { return localDateTime(ts).toFormat('dd/MM/yyyy HH:mm'); }

function formatDuration(seconds) {
  let value = Math.max(0, Math.floor(Number(seconds || 0)));
  const d = Math.floor(value / 86400); value %= 86400;
  const h = Math.floor(value / 3600); value %= 3600;
  const m = Math.floor(value / 60); const s = value % 60;
  if (d) return `${d}d ${h}h ${m}m ${s}s`;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatSessionDuration(seconds) {
  let value = Math.max(0, Math.floor(Number(seconds || 0)));
  const d = Math.floor(value / 86400); value %= 86400;
  const h = Math.floor(value / 3600); value %= 3600;
  const m = Math.floor(value / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function hoursText(seconds) {
  return `${(Math.max(0, Number(seconds || 0)) / 3600).toFixed(2)}h`;
}

function promotionEligibilityText(seconds) {
  const hours = Math.max(0, Number(seconds || 0)) / 3600;
  if (hours >= 8) return 'This user is eligible for a double promotion.';
  if (hours >= 4) return 'This user is eligible for a promotion.';
  return 'This user is not yet eligible for a promotion.';
}

function cleanName(value) {
  return String(value || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70) || 'user';
}

function clamp(value, max = 1024) {
  const text = String(value ?? '').trim();
  if (!text) return 'Not provided';
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function parseIds(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function normalizeDepartmentCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{1,14}$/.test(code) ? code : null;
}

function syncDepartmentArray() {
  DEPARTMENTS.splice(0, DEPARTMENTS.length, ...departmentRegistry.keys());
}

function registerDepartmentLocal(code, name) {
  const normalized = normalizeDepartmentCode(code);
  const cleanDisplayName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!normalized || !cleanDisplayName) return false;
  departmentRegistry.set(normalized, cleanDisplayName);
  syncDepartmentArray();
  return true;
}

function departmentDefinitions() {
  return [...departmentRegistry.entries()].map(([code, name]) => ({ code, name }));
}

function deptName(code) {
  const normalized = String(code || '').trim().toUpperCase();
  return departmentRegistry.get(normalized) || normalized || 'Unknown Department';
}

function timeframeLabel(value) {
  return {
    last_week: 'Last Week',
    this_week: 'This Week',
    this_month: 'This Month',
    last_month: 'Last Month',
    all_time: 'All Time'
  }[value] || value;
}

function assertDepartment(value) {
  const department = normalizeDepartmentCode(value);
  return department && departmentRegistry.has(department) ? department : null;
}

function isLeoVoice(channelId) {
  return Boolean(channelId) && LEO_VOICE_CHANNELS.includes(String(channelId));
}

function splitEvidence(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map(v => v.trim())
    .filter(Boolean);
  return lines.length ? lines : [];
}

function splitTextChunks(value, max = 1024) {
  const text = String(value || '').trim();
  if (!text) return [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max);
    if (cut < Math.floor(max * 0.5)) cut = remaining.lastIndexOf(' ', max);
    if (cut < Math.floor(max * 0.5)) cut = max;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function loadSettingsCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_CACHE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveSettingsCache() {
  try {
    fs.writeFileSync(SETTINGS_CACHE_FILE, `${JSON.stringify(settingsCache, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn('Unable to save local settings cache:', error.message);
  }
}

function settingKey(guildId, key) {
  return guildId ? `guild:${guildId}:${key}` : key;
}

function getPool() {
  if (pool) return pool;
  if (!process.env.MYSQL_DATABASE) throw new DatabaseUnavailableError('MYSQL_DATABASE is not configured.');

  const config = {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: DB_TIMEOUT_MS,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  };
  if (process.env.MYSQL_PASSWORD) config.password = process.env.MYSQL_PASSWORD;
  pool = mysql.createPool(config);
  return pool;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DatabaseUnavailableError(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isConnectionFailure(error) {
  const code = String(error?.code || '');
  return [
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
    'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'ER_CON_COUNT_ERROR'
  ].includes(code);
}

function markDatabaseFailure(error) {
  dbUnavailableUntil = Date.now() + DB_RETRY_COOLDOWN_MS;
  const wasOffline = databaseOffline;
  databaseOffline = true;
  if (!wasOffline) {
    const message = error?.message || 'connection unavailable';
    console.warn(`MySQL unavailable: ${message}. Retrying silently in the background.`);
  }
}

function markDatabaseHealthy() {
  const wasOffline = databaseOffline;
  databaseOffline = false;
  dbUnavailableUntil = 0;
  if (wasOffline) console.log('DATABASE / DUTY TRACKING ONLINE');
}

async function q(sql, params = []) {
  if (Date.now() < dbUnavailableUntil) throw new DatabaseUnavailableError();
  try {
    const db = getPool();
    const [rows] = await withTimeout(db.execute(sql, params), DB_TIMEOUT_MS, 'MySQL query timed out.');
    markDatabaseHealthy();
    return rows;
  } catch (error) {
    if (error instanceof DatabaseUnavailableError || isConnectionFailure(error)) {
      markDatabaseFailure(error);
      if (error instanceof DatabaseUnavailableError) throw error;
      throw new DatabaseUnavailableError(error.message);
    }
    throw error;
  }
}

async function rawQuery(sql) {
  if (Date.now() < dbUnavailableUntil) throw new DatabaseUnavailableError();
  try {
    const db = getPool();
    const result = await withTimeout(db.query(sql), DB_TIMEOUT_MS, 'MySQL schema query timed out.');
    markDatabaseHealthy();
    return result;
  } catch (error) {
    if (error instanceof DatabaseUnavailableError || isConnectionFailure(error)) {
      markDatabaseFailure(error);
      if (error instanceof DatabaseUnavailableError) throw error;
      throw new DatabaseUnavailableError(error.message);
    }
    throw error;
  }
}

async function getSetting(key, fallback = null, guildId = null) {
  const fullKey = settingKey(guildId, key);
  if (Object.prototype.hasOwnProperty.call(settingsCache, fullKey)) return settingsCache[fullKey];
  try {
    const rows = await q('SELECT settingValue FROM bot_settings WHERE settingKey=? LIMIT 1', [fullKey]);
    const value = rows[0] ? rows[0].settingValue : fallback;
    settingsCache[fullKey] = value;
    saveSettingsCache();
    return value;
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) throw error;
    return fallback;
  }
}

async function setSetting(key, value, guildId = null) {
  const fullKey = settingKey(guildId, key);
  settingsCache[fullKey] = String(value);
  saveSettingsCache();
  try {
    await q(
      'INSERT INTO bot_settings (settingKey, settingValue) VALUES (?, ?) ON DUPLICATE KEY UPDATE settingValue=VALUES(settingValue)',
      [fullKey, String(value)]
    );
    dirtySettings.delete(fullKey);
    return true;
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) throw error;
    dirtySettings.add(fullKey);
    return false;
  }
}

async function getJsonSetting(key, fallback, guildId = null) {
  const raw = await getSetting(key, JSON.stringify(fallback), guildId);
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function setJsonSetting(key, value, guildId = null) {
  return setSetting(key, JSON.stringify(value), guildId);
}

async function refreshDepartmentRegistry() {
  const stored = await getJsonSetting('departments', [], null);
  if (Array.isArray(stored)) {
    for (const entry of stored) {
      if (entry && typeof entry === 'object') registerDepartmentLocal(entry.code, entry.name);
    }
  }
  return departmentDefinitions();
}

async function flushDirtySettings() {
  if (!dirtySettings.size) return;
  for (const fullKey of [...dirtySettings]) {
    try {
      await q(
        'INSERT INTO bot_settings (settingKey, settingValue) VALUES (?, ?) ON DUPLICATE KEY UPDATE settingValue=VALUES(settingValue)',
        [fullKey, String(settingsCache[fullKey] ?? '')]
      );
      dirtySettings.delete(fullKey);
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) return;
      console.warn('Unable to flush setting:', error.message);
    }
  }
}

async function ensureDutyHoursCompatibility() {
  const columns = await q(
    `SELECT COLUMN_NAME, COLUMN_KEY, EXTRA
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'duty_hours'`
  );

  if (!columns.length) throw new Error('The duty_hours table is missing.');

  const names = new Set(columns.map(column => String(column.COLUMN_NAME)));
  const required = ['discordId', 'inTime', 'outTime', 'department'];
  const missing = required.filter(column => !names.has(column));
  if (missing.length) {
    throw new Error(`Existing duty_hours table is missing required column(s): ${missing.join(', ')}`);
  }

  if (!names.has('id')) {
    const existingAutoIncrement = columns.find(column => String(column.EXTRA || '').toLowerCase().includes('auto_increment'));
    if (existingAutoIncrement) {
      throw new Error(`Existing duty_hours table has no id column and already uses AUTO_INCREMENT on ${existingAutoIncrement.COLUMN_NAME}.`);
    }

    console.log('Migrating existing duty_hours table: adding internal id column required for voice/session tracking.');
    await rawQuery(
      'ALTER TABLE `duty_hours` ADD COLUMN `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT FIRST, ADD UNIQUE KEY `uq_wcrp_duty_hours_id` (`id`)'
    );
  }
}

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
  for (const statement of statements) await rawQuery(statement);
  await ensureDutyHoursCompatibility();
  await flushDirtySettings();
}

async function isAdmin(member) {
  if (!member) return false;
  if (parseIds(process.env.BOT_ADMINS).includes(member.id)) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (!member.guild) return false;
  const roleIds = await getJsonSetting('adminRoles', [], member.guild.id);
  return roleIds.some(id => member.roles?.cache.has(id));
}

async function commandAllowed(member, commandName) {
  if (!member) return false;
  if (await isAdmin(member)) return true;
  const configured = await getJsonSetting(`cmdperm:${commandName}`, [], member.guild.id);
  if (!configured.length) return true;
  return configured.some(id => member.roles?.cache.has(id));
}

async function roleAllowed(member, key) {
  if (!member) return false;
  if (await isAdmin(member)) return true;
  const roleIds = await getJsonSetting(key, [], member.guild.id);
  return roleIds.some(id => member.roles?.cache.has(id));
}

function replyPayload(payload) {
  const copy = { ...payload };
  if (copy.ephemeral) {
    delete copy.ephemeral;
    copy.flags = MessageFlags.Ephemeral;
  }
  return copy;
}

function editPayload(payload) {
  const copy = { ...payload };
  delete copy.ephemeral;
  delete copy.flags;
  return copy;
}

async function respond(interaction, payload) {
  if (interaction.deferred) return interaction.editReply(editPayload(payload));
  if (interaction.replied) return interaction.followUp(replyPayload(payload));
  return interaction.reply(replyPayload(payload));
}

async function failInteraction(interaction, error) {
  const databaseFailure = error instanceof DatabaseUnavailableError;
  if (databaseFailure) {
    console.warn(`Database-dependent command could not run: ${error.message}`);
  } else {
    console.error(error);
  }
  const content = databaseFailure
    ? 'The duty database is currently unavailable. Discord is still online; please try the database-dependent command again when MySQL is reachable.'
    : 'An error occurred while processing that request.';
  try {
    await respond(interaction, { content, ephemeral: true });
  } catch (replyError) {
    console.error('Unable to send interaction error response:', replyError.message);
  }
}

function getUserDisplay(user) {
  return user?.globalName || user?.username || user?.id || 'User';
}

async function getDiscordUser(discordId) {
  return client.users.fetch(String(discordId)).catch(() => null);
}

async function sendDM(user, embed) {
  try {
    await user.send({ embeds: [embed] });
  } catch (error) {
    console.warn(`Unable to DM ${user?.id || 'unknown'}: ${error.message}`);
  }
}

function dutyOnEmbed({ user, department, inTime }) {
  return new EmbedBuilder()
    .setColor(0x2f9e44)
    .setTitle('On Duty')
    .setDescription(`We hope you enjoy your shift, ${getUserDisplay(user)}.`)
    .addFields(
      { name: 'Clock In', value: formatDateTime(inTime), inline: true },
      { name: 'Department', value: department, inline: true }
    )
    .setFooter({ text: `WCRP Department Utilities | ${formatShort(inTime)}` });
}

function dutyOffEmbed({ department, outTime, session, weekly, inVoice, outVoice, coverage, reason }) {
  return new EmbedBuilder()
    .setColor(0xe04f5f)
    .setTitle('Off Duty')
    .setDescription('We hope you enjoyed your shift!')
    .addFields(
      { name: 'Reason', value: reason || 'Normal Duty Clock Out', inline: false },
      { name: 'Clock Out', value: formatDateTime(outTime), inline: true },
      { name: 'Session', value: formatSessionDuration(session), inline: true },
      { name: 'This Week (Fri-Thu)', value: hoursText(weekly.total), inline: true },
      { name: 'Week', value: `${weekly.startLabel} - ${weekly.endLabel}`, inline: true },
      { name: 'Department', value: department, inline: true },
      { name: 'In Voice', value: formatDuration(inVoice), inline: true },
      { name: 'Out of Voice', value: formatDuration(outVoice), inline: true },
      { name: 'Voice Coverage', value: `${coverage.toFixed(0)}%`, inline: true }
    )
    .setFooter({ text: `WCRP Department Utilities | ${formatShort(outTime)}` });
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
  let sql = 'SELECT inTime, COALESCE(outTime, UNIX_TIMESTAMP()) outTime FROM duty_hours WHERE inTime IS NOT NULL';
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
    if (Number(row.isLeoVoice)) {
      voice += Math.max(0, Math.min(Number(row.outTime), end) - Math.max(Number(row.inTime), inTime));
    }
  }
  const session = Math.max(0, end - inTime);
  return { voice, outVoice: Math.max(0, session - voice), session, coverage: session ? (voice / session) * 100 : 0 };
}

async function updateVoiceSegmentForUser(discordId, channelId, ts = now()) {
  const duty = activeDuty.get(String(discordId));
  if (!duty) return;
  const state = pendingVoice.get(String(discordId));
  const nextChannelId = channelId || null;
  if (state && state.channelId === nextChannelId) return;
  if (state) await q('UPDATE duty_voice_segments SET outTime=? WHERE id=? AND outTime IS NULL', [ts, state.segmentId]);
  const result = await q(
    'INSERT INTO duty_voice_segments (dutyId, discordId, channelId, inTime, outTime, isLeoVoice) VALUES (?, ?, ?, ?, NULL, ?)',
    [duty.id, String(discordId), nextChannelId, ts, isLeoVoice(nextChannelId) ? 1 : 0]
  );
  pendingVoice.set(String(discordId), { segmentId: result.insertId, channelId: nextChannelId });
}

async function closeVoiceForUser(discordId, ts = now()) {
  const key = String(discordId);
  const state = pendingVoice.get(key);
  if (!state) return;
  await q('UPDATE duty_voice_segments SET outTime=? WHERE id=? AND outTime IS NULL', [ts, state.segmentId]);
  pendingVoice.delete(key);
}

async function getReportGuild() {
  return client.guilds.fetch(REPORT_GUILD_ID).catch(() => null);
}

async function startDutyTracking(row) {
  if (!row?.discordId) return;
  const discordId = String(row.discordId);
  if (activeDuty.has(discordId)) return;
  const duty = {
    id: row.id,
    discordId,
    inTime: Number(row.inTime),
    department: assertDepartment(row.department) || String(row.department || '').toUpperCase()
  };
  activeDuty.set(discordId, duty);

  const guild = await getReportGuild();
  const member = guild ? await guild.members.fetch(discordId).catch(() => null) : null;
  if (member) {
    const segmentStart = Math.max(duty.inTime, now());
    await updateVoiceSegmentForUser(discordId, member.voice.channelId, segmentStart).catch(error => console.warn('Unable to begin voice segment:', error.message));
  }

  const user = await getDiscordUser(discordId);
  if (user) await sendDM(user, dutyOnEmbed({ user, department: duty.department, inTime: duty.inTime }));
}

async function finishDutyTracking(row) {
  const discordId = String(row.discordId);
  const duty = activeDuty.get(discordId);
  if (!duty) return;
  const inTime = duty.inTime || Number(row.inTime);
  const outTime = Number(row.outTime || now());

  await closeVoiceForUser(discordId, outTime).catch(() => {});
  const stats = await voiceSecondsForDuty(duty.id, inTime, outTime);
  const weeklyWindow = getWeekWindow(outTime);
  const weekly = {
    total: await totalDutySeconds({ discordId, department: duty.department, window: weeklyWindow }),
    startLabel: weeklyWindow.startLabel,
    endLabel: weeklyWindow.endLabel
  };
  const user = await getDiscordUser(discordId);
  if (user) {
    await sendDM(user, dutyOffEmbed({
      department: duty.department,
      outTime,
      session: stats.session,
      weekly,
      inVoice: stats.voice,
      outVoice: stats.outVoice,
      coverage: stats.coverage,
      reason: row.reason || 'Normal Duty Clock Out'
    }));
  }
  activeDuty.delete(discordId);
}

let lastDutyPollErrorSignature = null;

async function pollDuty() {
  try {
    const activeRows = await q('SELECT * FROM duty_hours WHERE outTime IS NULL AND discordId IS NOT NULL ORDER BY id DESC');
    const latestByUser = new Map();
    for (const row of activeRows) {
      const id = String(row.discordId);
      if (!latestByUser.has(id)) latestByUser.set(id, row);
    }

    for (const row of latestByUser.values()) await startDutyTracking(row);

    for (const [discordId, duty] of [...activeDuty.entries()]) {
      if (latestByUser.has(discordId)) continue;
      const rows = await q('SELECT * FROM duty_hours WHERE id=? LIMIT 1', [duty.id]);
      const row = rows[0];
      if (row?.outTime) await finishDutyTracking(row);
      else {
        await closeVoiceForUser(discordId).catch(() => {});
        activeDuty.delete(discordId);
      }
    }
    lastDutyPollErrorSignature = null;
    return true;
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) return false;
    const signature = `${error?.code || 'ERR'}:${error?.message || String(error)}`;
    if (signature !== lastDutyPollErrorSignature) {
      console.error('Duty poll error:', error);
      lastDutyPollErrorSignature = signature;
    }
    return false;
  }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  const discordId = String(newState.id || oldState.id);
  if (!activeDuty.has(discordId)) return;
  try {
    await updateVoiceSegmentForUser(discordId, newState.channelId);
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) console.error('Voice tracking error:', error);
  }
});

function baseCommand(name, description) {
  return new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
}

const commands = [
  baseCommand('officer-report-panel', 'Post the WCRP report buttons'),
  baseCommand('anonreport', 'Anonymize and rebuild the current report ticket'),
  baseCommand('addofficer', 'Report handler: set the officer being reported'),
  baseCommand('reportadd', 'Report handler: create an officer report ticket'),
  baseCommand('report-config', 'Admin: configure report categories by department'),
  baseCommand('report-staff', 'Admin: configure Reports Team roles by department'),
  baseCommand('higherup-config', 'Admin: configure higher-up report coordinators by department'),
  baseCommand('log-config', 'Admin: configure log channels'),
  baseCommand('dept-config', 'Admin: configure department purchase tickets'),
  baseCommand('dept', 'Department ticket tools'),
  baseCommand('approve', 'Department Management: approve this department purchase request'),
  baseCommand('denied', 'Department Management: deny this department purchase request'),
  baseCommand('ridealong-permissions', 'Admin: configure ride-along permission roles'),
  baseCommand('ridealong-config', 'Admin: configure trainee and ride-along roles'),
  baseCommand('permissions', 'Admin: configure command permission roles'),
  baseCommand('admin-roles', 'Admin: configure bot administrator roles'),
  baseCommand('ridealong', 'Log a ride-along result'),
  baseCommand('rename', 'Report handler: rename this ticket to handler-handling'),
  baseCommand('close', 'Report handler: close this report ticket'),
  baseCommand('delete', 'Report handler: delete this report ticket with transcript'),
  baseCommand('hours', 'Check duty hours by department and timeframe'),
  baseCommand('allhours', 'Show duty hours for everyone in a department'),
  baseCommand('totalhours', 'Show total duty hours for a department'),
  baseCommand('weeklydeptours', 'Show department duty hours for a timeframe'),
  baseCommand('deptofhours', 'Show top officers in a department by hours'),
  baseCommand('tophours', 'Show the top five officers by all-time duty hours'),
  baseCommand('leaderboard', 'Show a department duty leaderboard'),
  baseCommand('evaluate', 'Evaluate an exact user in a department and timeframe'),
  baseCommand('inactive_officers', 'Show inactive officers in a department'),
  baseCommand('promotions', 'Show promotion-eligible department officers'),
  baseCommand('leomulti', 'Set a temporary LEO hour multiplier marker'),
  baseCommand('add', 'Admin: add WCRP resources'),
  baseCommand('add_org', 'Admin: add an organisation'),
  baseCommand('add_org_hours', 'Admin: add hours to an organisation total'),
  baseCommand('rename_org', 'Admin: rename an organisation'),
  baseCommand('dept_officers', 'Show department officers and activity status')
];

const departmentOption = (name = 'department', required = true) => (option) =>
  option
    .setName(name)
    .setDescription('Department')
    .setRequired(required)
    .setAutocomplete(true);

const timeframeChoices = [
  { name: 'Last Week', value: 'last_week' },
  { name: 'This Week', value: 'this_week' },
  { name: 'This Month', value: 'this_month' },
  { name: 'Last Month', value: 'last_month' },
  { name: 'All Time', value: 'all_time' }
];

commands.find(c => c.name === 'hours')
  .addStringOption(departmentOption('department', true))
  .addStringOption(o => o.setName('timeframe').setDescription('Timeframe').setRequired(true).addChoices(...timeframeChoices))
  .addUserOption(o => o.setName('user').setDescription('User to check; defaults to you').setRequired(false));

commands.find(c => c.name === 'evaluate')
  .addUserOption(o => o.setName('user').setDescription('Exact user to evaluate').setRequired(true))
  .addStringOption(departmentOption('department', true))
  .addStringOption(o => o.setName('timeframe').setDescription('Timeframe').setRequired(true).addChoices(...timeframeChoices));

for (const name of ['allhours', 'totalhours', 'weeklydeptours', 'deptofhours', 'leaderboard']) {
  commands.find(c => c.name === name)
    .addStringOption(departmentOption('department', true))
    .addStringOption(o => o.setName('timeframe').setDescription('Timeframe').setRequired(false).addChoices(...timeframeChoices));
}

for (const name of ['promotions', 'inactive_officers', 'dept_officers']) {
  commands.find(c => c.name === name).addStringOption(departmentOption('department', true));
}

commands.find(c => c.name === 'inactive_officers')
  .addIntegerOption(o => o.setName('weeks_back').setDescription('Inactivity threshold').setRequired(false).addChoices({ name: '2 weeks', value: 2 }, { name: '4 weeks', value: 4 }));
commands.find(c => c.name === 'dept_officers')
  .addIntegerOption(o => o.setName('weeks_back').setDescription('Activity threshold').setRequired(false).addChoices({ name: '2 weeks', value: 2 }, { name: '4 weeks', value: 4 }));
commands.find(c => c.name === 'leomulti')
  .addIntegerOption(o => o.setName('duration_minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(10080))
  .addNumberOption(o => o.setName('multiplier').setDescription('Multiplier').setRequired(false).setMinValue(1).setMaxValue(5));

commands.find(c => c.name === 'add')
  .addSubcommand(sub => sub
    .setName('dept')
    .setDescription('Add a department to hours, promotions and report systems')
    .addStringOption(o => o.setName('code').setDescription('Short department code, for example SAFR').setRequired(true).setMinLength(2).setMaxLength(15))
    .addStringOption(o => o.setName('name').setDescription('Full department name').setRequired(true).setMinLength(2).setMaxLength(100)));

commands.find(c => c.name === 'add_org')
  .addStringOption(o => o.setName('code').setDescription('Organisation code').setRequired(true))
  .addStringOption(o => o.setName('name').setDescription('Organisation name').setRequired(true));
commands.find(c => c.name === 'add_org_hours')
  .addStringOption(o => o.setName('code').setDescription('Organisation code').setRequired(true))
  .addNumberOption(o => o.setName('hours').setDescription('Hours to add').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false));
commands.find(c => c.name === 'rename_org')
  .addStringOption(o => o.setName('old_code').setDescription('Current code').setRequired(true))
  .addStringOption(o => o.setName('new_code').setDescription('New code').setRequired(true))
  .addStringOption(o => o.setName('name').setDescription('New organisation name').setRequired(true));

commands.find(c => c.name === 'permissions')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addStringOption(o => o.setName('command').setDescription('Slash command name without /').setRequired(true))
  .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(false));

commands.find(c => c.name === 'admin-roles')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addRoleOption(o => o.setName('role').setDescription('Bot administrator role').setRequired(false));

commands.find(c => c.name === 'report-staff')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addStringOption(departmentOption('department', true))
  .addRoleOption(o => o.setName('role').setDescription('Reports Team role for this department').setRequired(false));

commands.find(c => c.name === 'ridealong-permissions')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addRoleOption(o => o.setName('role').setDescription('Role allowed to use /ridealong').setRequired(false));

commands.find(c => c.name === 'report-config')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Set Department Ticket Category', value: 'set_category' },
    { name: 'Clear Department Ticket Category', value: 'clear_category' },
    { name: 'View', value: 'view' }
  ))
  .addStringOption(departmentOption('department', true))
  .addChannelOption(o => o.setName('category').setDescription('Ticket category for this department').setRequired(false).addChannelTypes(ChannelType.GuildCategory));

commands.find(c => c.name === 'higherup-config')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add Department Coordinator Role', value: 'add_role' },
    { name: 'Remove Department Coordinator Role', value: 'remove_role' },
    { name: 'Clear Department Coordinator Roles', value: 'clear_roles' },
    { name: 'Set Higher-Up Ticket Category', value: 'set_category' },
    { name: 'Clear Higher-Up Ticket Category', value: 'clear_category' },
    { name: 'View', value: 'view' }
  ))
  .addStringOption(departmentOption('department', true))
  .addRoleOption(o => o.setName('role').setDescription('Department coordinator role').setRequired(false))
  .addChannelOption(o => o.setName('category').setDescription('Higher-up ticket category').setRequired(false).addChannelTypes(ChannelType.GuildCategory));

commands.find(c => c.name === 'log-config')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Set', value: 'set' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addStringOption(o => o.setName('type').setDescription('Log type').setRequired(true).addChoices(
    { name: 'Report Logs', value: 'report_log' },
    { name: 'Transcript Logs', value: 'transcript_log' },
    { name: 'Ride-Along Logs', value: 'ridealong_log' }
  ))
  .addChannelOption(o => o.setName('channel').setDescription('Log channel').setRequired(false).addChannelTypes(ChannelType.GuildText));

commands.find(c => c.name === 'dept-config')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add Handler Role', value: 'add_handler' },
    { name: 'Remove Handler Role', value: 'remove_handler' },
    { name: 'Clear Handler Roles', value: 'clear_handlers' },
    { name: 'Set Ticket Category', value: 'set_category' },
    { name: 'Clear Ticket Category', value: 'clear_category' },
    { name: 'Set Log Channel', value: 'set_log' },
    { name: 'Clear Log Channel', value: 'clear_log' },
    { name: 'View', value: 'view' }
  ))
  .addRoleOption(o => o.setName('role').setDescription('Department purchase handler role').setRequired(false))
  .addChannelOption(o => o.setName('category').setDescription('Department purchase ticket category').setRequired(false).addChannelTypes(ChannelType.GuildCategory))
  .addChannelOption(o => o.setName('channel').setDescription('Department purchase log channel').setRequired(false).addChannelTypes(ChannelType.GuildText));

commands.find(c => c.name === 'dept')
  .addSubcommand(sub => sub.setName('ticket').setDescription('Post the Purchase Department ticket panel'));

for (const name of ['approve', 'denied']) {
  commands.find(c => c.name === name)
    .addStringOption(o => o.setName('reason').setDescription('Optional decision reason').setRequired(false).setMaxLength(1000));
}

commands.find(c => c.name === 'ridealong-config')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Set', value: 'set' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addRoleOption(o => o.setName('ridealong_role').setDescription('Role assigned after a passed ride-along').setRequired(false))
  .addRoleOption(o => o.setName('trainee_role').setDescription('Trainee role removed when a ride-along is logged').setRequired(false));

commands.find(c => c.name === 'ridealong')
  .addUserOption(o => o.setName('player').setDescription('Trainee receiving the ride-along result').setRequired(true))
  .addStringOption(departmentOption('department', true))
  .addStringOption(o => o.setName('result').setDescription('Ride-along result').setRequired(true).addChoices(
    { name: 'Passed', value: 'Passed' }, { name: 'Failed', value: 'Failed' }
  ))
  .addRoleOption(o => o.setName('ridealong_role').setDescription('Optional role to assign on a pass').setRequired(false))
  .addStringOption(o => o.setName('notes').setDescription('Optional notes').setRequired(false));

commands.find(c => c.name === 'addofficer')
  .addUserOption(o => o.setName('user').setDescription('Reported Discord user').setRequired(false))
  .addStringOption(o => o.setName('user_id').setDescription('Exact reported Discord user ID').setRequired(false));

function addReportOptions(command) {
  command
    .addStringOption(departmentOption('department', true))
    .addUserOption(o => o.setName('officer').setDescription('Officer being reported').setRequired(false))
    .addStringOption(o => o.setName('date').setDescription('Date of incident').setRequired(false))
    .addStringOption(o => o.setName('game_id').setDescription('In-game ID').setRequired(false))
    .addStringOption(o => o.setName('evidence').setDescription('Evidence or clip links').setRequired(false))
    .addStringOption(o => o.setName('description').setDescription('Description').setRequired(false))
    .addStringOption(o => o.setName('context').setDescription('Additional context').setRequired(false));
}
addReportOptions(commands.find(c => c.name === 'reportadd'));

function buildCommandsJson() {
  const normalizeOptions = (options) => {
    if (!Array.isArray(options)) return options;
    return options
      .map(option => Array.isArray(option.options) ? { ...option, options: normalizeOptions(option.options) } : option)
      .sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)));
  };

  return commands.map(command => {
    const json = command.toJSON();
    if (Array.isArray(json.options)) json.options = normalizeOptions(json.options);
    return json;
  });
}

async function registerCommands() {
  if (!TOKEN || !CLIENT_ID) throw new Error('Missing DISCORD_TOKEN or CLIENT_ID.');
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = buildCommandsJson();
  const registered = await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
  console.log(`Registered ${Array.isArray(registered) ? registered.length : body.length} global commands.`);
}

function reportPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('report_start:officer')
      .setLabel('Officer Report')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('report_start:higher')
      .setLabel('Higher Up Report')
      .setStyle(ButtonStyle.Secondary)
  );
}

function reportDepartmentSelect(type, userId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`report_department:${type}:${userId}`)
      .setPlaceholder('Select the department...')
      .addOptions(...departmentDefinitions().slice(0, 25).map(({ code, name }) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${code} - ${name}`.slice(0, 100))
          .setValue(code)
      ))
  );
}

function reportFieldsModal(type = 'officer', department = 'USM') {
  return new ModalBuilder()
    .setCustomId(`report_modal:${type}:${department}`)
    .setTitle(type === 'higher' ? `${department} Higher Up Report` : `${department} Officer Report`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('date')
          .setLabel('Date of incident')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('DD/MM/YYYY')
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('game_id')
          .setLabel('In-game ID of who you are reporting')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('evidence')
          .setLabel('Clips / evidence')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Paste one evidence link per line')
          .setRequired(true)
          .setMaxLength(2000)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Describe what is in the clip')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(2000)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('context')
          .setLabel('All necessary context')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(2000)
      )
    );
}

function buildReportEmbed(report) {
  const evidence = splitEvidence(report.clip);
  const fields = [
    { name: 'Department', value: `${report.department} - ${deptName(report.department)}`, inline: false },
    { name: 'Date of incident', value: clamp(report.dateOfIncident), inline: false },
    { name: 'In Game ID of who you are reporting', value: clamp(report.gameId), inline: true },
    {
      name: 'Suspected Discord',
      value: report.reportedUserId ? `<@${report.reportedUserId}>` : 'Not found - use /addofficer when the exact Discord user is known.',
      inline: true
    }
  ];

  if (evidence.length) {
    evidence.slice(0, 8).forEach((item, index) => {
      splitTextChunks(item).forEach((chunk, chunkIndex) => fields.push({
        name: chunkIndex === 0 ? (index === 0 ? 'Clip' : `Clip ${index + 1}`) : `Clip ${index + 1} Continued`,
        value: chunk,
        inline: false
      }));
    });
  } else {
    fields.push({ name: 'Clip', value: 'Not provided', inline: false });
  }

  splitTextChunks(report.description || 'Not provided').forEach((chunk, index) => fields.push({
    name: index === 0 ? 'Describe in detail what is in the clip' : `Clip description ${index + 1}`,
    value: chunk,
    inline: false
  }));
  splitTextChunks(report.context || 'Not provided').forEach((chunk, index) => fields.push({
    name: index === 0 ? 'Provide all necessary context for the clip' : `Additional context ${index + 1}`,
    value: chunk,
    inline: false
  }));

  const submitter = Number(report.anonymous) === 1
    ? 'Submitted anonymously'
    : `Submitted by ${report.reporterName || 'User'}${report.reporterId ? ` (${report.reporterId})` : ''}`;

  return new EmbedBuilder()
    .setColor(report.ticketType === 'higher' ? 0x6d5dfc : 0x5865f2)
    .setTitle(report.ticketType === 'higher' ? 'Higher Up Report' : 'Officer Report')
    .addFields(fields.slice(0, 25))
    .setFooter({ text: `${submitter} | ${formatShort(report.createdAt || now())}` });
}

function reportCloseButton(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`report_close:${channelId}`)
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
  );
}

function reportDeleteButton(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`report_delete:${channelId}`)
      .setLabel('Delete Ticket')
      .setStyle(ButtonStyle.Danger)
  );
}

function ticketClosedEmbed(report, closedById) {
  return new EmbedBuilder()
    .setColor(0x5b6470)
    .setTitle('Ticket Closed')
    .setDescription('This report has been closed and automatically logged.')
    .addFields(
      { name: 'Department', value: report.department, inline: true },
      { name: 'Closed By', value: `<@${closedById}>`, inline: true }
    )
    .setFooter({ text: `WCRP Reports | ${formatShort(now())}` });
}

function deleteTicketEmbed() {
  return new EmbedBuilder()
    .setColor(0xd13c3c)
    .setTitle('Delete Ticket')
    .setDescription('The report is closed. A report handler can permanently delete this channel using the button below.');
}

async function getStandardReportTeamRoles(department, guildId) {
  const current = await getJsonSetting(`reportStaffRoles:${department}`, [], guildId);
  return [...new Set(current || [])];
}

async function getReportHandlerRoles(report, guildId) {
  if (report.ticketType === 'higher') {
    return getJsonSetting(`higherUpRoles:${report.department}`, [], guildId);
  }
  return getStandardReportTeamRoles(report.department, guildId);
}

async function getReportCategoryId(report, guildId) {
  if (report.ticketType === 'higher') {
    const higherCategory = await getSetting(`higherUpCategoryId:${report.department}`, null, guildId);
    if (higherCategory) return higherCategory;
  }
  const departmentCategory = await getSetting(`reportCategoryId:${report.department}`, null, guildId);
  if (departmentCategory) return departmentCategory;
  return getSetting('reportCategoryId', null, guildId);
}

function normalReportPermissions(guild, reporterId, handlerRoleIds) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
  ];
  if (guild.members.me) {
    overwrites.push({
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages
      ]
    });
  }
  if (reporterId) {
    overwrites.push({
      id: reporterId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
  }
  for (const roleId of [...new Set(handlerRoleIds || [])]) {
    if (!guild.roles.cache.has(roleId)) continue;
    overwrites.push({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
  }
  return overwrites;
}

async function anonymousReportPermissions(guild, report, handlerRoleIds) {
  const overwrites = normalReportPermissions(guild, null, handlerRoleIds);
  if (report.reportedUserId && report.reportedUserId !== report.reporterId) {
    const member = await guild.members.fetch(report.reportedUserId).catch(() => null);
    if (member) {
      overwrites.push({
        id: member.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [PermissionFlagsBits.SendMessages]
      });
    }
  }
  return overwrites;
}

async function persistReport(report) {
  reportCache.set(String(report.channelId), { ...report });
  try {
    await q(
      `INSERT INTO reports
       (channelId,ticketType,department,reporterId,reportedUserId,dateOfIncident,gameId,clip,description,context,anonymous,createdAt,closedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         ticketType=VALUES(ticketType), department=VALUES(department), reporterId=VALUES(reporterId),
         reportedUserId=VALUES(reportedUserId), dateOfIncident=VALUES(dateOfIncident), gameId=VALUES(gameId),
         clip=VALUES(clip), description=VALUES(description), context=VALUES(context), anonymous=VALUES(anonymous),
         createdAt=VALUES(createdAt), closedAt=VALUES(closedAt)`,
      [
        report.channelId, report.ticketType || 'officer', report.department, report.reporterId || null,
        report.reportedUserId || null, report.dateOfIncident || null, report.gameId || null,
        report.clip || null, report.description || null, report.context || null,
        Number(report.anonymous) ? 1 : 0, Number(report.createdAt || now()), report.closedAt || null
      ]
    );
    return true;
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) throw error;
    return false;
  }
}

function parseMentionId(value) {
  return String(value || '').match(/\d{17,20}/)?.[0] || null;
}

function embedFieldValue(embed, name) {
  const field = embed?.fields?.find(f => String(f.name).toLowerCase() === String(name).toLowerCase());
  return field?.value || null;
}

function parseReportTopic(topic) {
  const values = {};
  for (const part of String(topic || '').split('|')) {
    const [key, ...rest] = part.split('=');
    if (key && rest.length) values[key.trim()] = rest.join('=').trim();
  }
  return values;
}

async function inferReportFromChannel(channel) {
  if (!channel?.isTextBased()) return null;
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages?.size) return null;
  const message = [...messages.values()].find(m => /Officer Report|Higher Up Report/i.test(m.embeds?.[0]?.title || ''));
  if (!message) return null;
  const embed = message.embeds[0];
  const departmentText = embedFieldValue(embed, 'Department') || '';
  const department = DEPARTMENTS.find(d => departmentText.toUpperCase().includes(d)) || null;
  if (!department) return null;
  const topic = parseReportTopic(channel.topic);
  const clipFields = (embed.fields || [])
    .filter(f => /^Clip(?: \d+)?$/i.test(f.name) || /Evidence/i.test(f.name))
    .map(f => f.value)
    .filter(v => v && v !== 'Not provided');

  return {
    channelId: channel.id,
    ticketType: /Higher Up/i.test(embed.title || '') ? 'higher' : 'officer',
    department,
    reporterId: parseMentionId(topic.reporter) || null,
    reporterName: topic.reporterName || null,
    reportedUserId: parseMentionId(embedFieldValue(embed, 'Suspected Discord')),
    dateOfIncident: embedFieldValue(embed, 'Date of incident'),
    gameId: embedFieldValue(embed, 'In Game ID of who you are reporting'),
    clip: clipFields.join('\n') || null,
    description: embedFieldValue(embed, 'Describe in detail what is in the clip') || null,
    context: embedFieldValue(embed, 'Provide all necessary context for the clip') || null,
    anonymous: /^anon-/i.test(channel.name) ? 1 : 0,
    createdAt: Math.floor(message.createdTimestamp / 1000),
    closedAt: null
  };
}

async function getReport(channelId, channel = null) {
  const key = String(channelId);
  if (reportCache.has(key)) return { ...reportCache.get(key) };
  try {
    const rows = await q('SELECT * FROM reports WHERE channelId=? LIMIT 1', [key]);
    if (rows[0]) {
      const topic = channel ? parseReportTopic(channel.topic) : {};
      const report = { ...rows[0], reporterName: topic.reporterName || null };
      reportCache.set(key, report);
      return { ...report };
    }
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) throw error;
  }
  const inferred = await inferReportFromChannel(channel);
  if (inferred) {
    reportCache.set(key, inferred);
    return { ...inferred };
  }
  return null;
}

async function sendReportPost(channel, report, { pingHandlers = false, pingReported = false } = {}) {
  const handlerRoles = await getReportHandlerRoles(report, channel.guild.id);
  const validRoles = handlerRoles.filter(id => channel.guild.roles.cache.has(id));

  const main = await channel.send({
    embeds: [buildReportEmbed(report)],
    components: [reportCloseButton(channel.id)],
    allowedMentions: { parse: [] }
  });

  const evidence = splitEvidence(report.clip).filter(item => /^https?:\/\//i.test(item));
  if (evidence.length) {
    const chunks = splitTextChunks(evidence.join('\n'), 1900);
    for (const chunk of chunks) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  }

  const mentions = [];
  const allowedMentions = { parse: [], roles: [], users: [] };
  if (pingHandlers && validRoles.length) {
    mentions.push(...validRoles.map(id => `<@&${id}>`));
    allowedMentions.roles = validRoles;
  }
  if (pingReported && report.reportedUserId) {
    mentions.push(`<@${report.reportedUserId}>`);
    allowedMentions.users = [report.reportedUserId];
  }
  if (mentions.length) {
    await channel.send({ content: mentions.join(' '), allowedMentions });
  }
  return main;
}

async function replaceReportPost(channel, report, options = {}) {
  const evidence = new Set(splitEvidence(report.clip));
  const messages = await channel.messages.fetch({ limit: 75 }).catch(() => null);
  if (messages?.size) {
    const deletions = [];
    for (const message of messages.values()) {
      if (message.author.id !== client.user?.id) continue;
      const title = message.embeds?.[0]?.title || '';
      const contentLines = String(message.content || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
      const isEvidencePost = contentLines.length && contentLines.every(line => evidence.has(line));
      const isMentionPost = Boolean(message.content) && /^(?:<@&?\d{17,20}>|<@!\d{17,20}>)(?:\s+(?:<@&?\d{17,20}>|<@!\d{17,20}>))*$/.test(message.content.trim());
      if (/Officer Report|Higher Up Report/i.test(title) || isEvidencePost || isMentionPost) deletions.push(message.delete().catch(() => {}));
    }
    await Promise.allSettled(deletions);
  }
  return sendReportPost(channel, report, options);
}

async function clearChannelFast(channel) {
  for (let round = 0; round < 10; round++) {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages?.size) break;
    await channel.bulkDelete(messages, true).catch(() => {});
    const remaining = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!remaining?.size) break;
    const oldMessages = [...remaining.values()].filter(m => Date.now() - m.createdTimestamp >= 13.5 * 24 * 60 * 60 * 1000);
    if (oldMessages.length) await Promise.allSettled(oldMessages.map(m => m.delete().catch(() => {})));
    if (remaining.size < 100 && !oldMessages.length) break;
  }
}

async function createReportTicket({ interaction, type = 'officer', department, dateOfIncident, gameId = null, clip = null, description = null, context = null, reportedUserId = null }) {
  const guild = interaction.guild;
  if (!guild || guild.id !== REPORT_GUILD_ID || !department) return null;

  const reportTemplate = { ticketType: type, department };
  const handlerRoles = await getReportHandlerRoles(reportTemplate, guild.id);
  const categoryId = await getReportCategoryId(reportTemplate, guild.id);
  const parent = categoryId && guild.channels.cache.get(categoryId)?.type === ChannelType.GuildCategory ? categoryId : undefined;
  const reporterName = cleanName(interaction.user.username).slice(0, 32);

  const channel = await guild.channels.create({
    name: `${type === 'higher' ? 'higher' : 'report'}-${department.toLowerCase()}-${cleanName(interaction.user.username)}`,
    type: ChannelType.GuildText,
    parent,
    topic: `WCRP_REPORT|type=${type}|department=${department}|reporter=${interaction.user.id}|reporterName=${reporterName}`,
    permissionOverwrites: normalReportPermissions(guild, interaction.user.id, handlerRoles)
  });

  const report = {
    channelId: channel.id,
    ticketType: type,
    department,
    reporterId: interaction.user.id,
    reporterName: interaction.user.username,
    reportedUserId,
    dateOfIncident: dateOfIncident || null,
    gameId: gameId || null,
    clip: clip || null,
    description: description || null,
    context: context || null,
    anonymous: 0,
    createdAt: now(),
    closedAt: null
  };

  await persistReport(report);
  await sendReportPost(channel, report, { pingHandlers: true });
  return channel;
}

function transcriptEmbedText(embed) {
  const parts = [];
  if (embed.title) parts.push(`Embed Title: ${embed.title}`);
  if (embed.description) parts.push(`Embed Description: ${embed.description}`);
  for (const field of embed.fields || []) parts.push(`${field.name}: ${field.value}`);
  if (embed.footer?.text) parts.push(`Embed Footer: ${embed.footer.text}`);
  return parts.join(' | ');
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
  return all.map(message => {
    const pieces = [];
    if (message.content) pieces.push(message.content);
    for (const embed of message.embeds || []) {
      const rendered = transcriptEmbedText(embed);
      if (rendered) pieces.push(rendered);
    }
    if (message.attachments.size) pieces.push(`Attachments: ${[...message.attachments.values()].map(a => a.url).join(', ')}`);
    if (!pieces.length) pieces.push('[no text content]');
    return `[${new Date(message.createdTimestamp).toISOString()}] ${message.author.tag} (${message.author.id}): ${pieces.join(' | ')}`;
  }).join('\n');
}

async function archiveReportTranscript(channel, report, label = 'closed') {
  const transcript = await makeTranscript(channel);
  const transcriptId = await getSetting('transcriptChannelId', null, channel.guild.id);
  const reportLogId = await getSetting('reportLogChannelId', null, channel.guild.id);
  const target = (transcriptId && channel.guild.channels.cache.get(transcriptId)) ||
    (reportLogId && channel.guild.channels.cache.get(reportLogId));
  if (!target?.isTextBased()) return false;
  const safeName = cleanName(channel.name);
  await target.send({
    content: `Automatic ${label} transcript for ${channel.name} (${channel.id})`,
    files: [{ attachment: Buffer.from(transcript || 'No messages.'), name: `${safeName}-${label}-transcript.txt` }],
    allowedMentions: { parse: [] }
  }).catch(() => {});
  return true;
}

async function ensureReportPermissions(member, report) {
  if (!member || !report) return false;
  if (await isAdmin(member)) return true;
  const roleIds = await getReportHandlerRoles(report, member.guild.id);
  return roleIds.some(id => member.roles?.cache.has(id));
}

async function reportConfigText(guildId, department) {
  const teamRoles = await getStandardReportTeamRoles(department, guildId);
  const categoryId = await getSetting(`reportCategoryId:${department}`, null, guildId);
  return [
    `Department: ${department}`,
    `Reports Team: ${teamRoles.length ? teamRoles.map(id => `<@&${id}>`).join(', ') : 'None'}`,
    `Ticket Category: ${categoryId ? `<#${categoryId}>` : 'Not configured'}`
  ].join('\n');
}

async function higherUpConfigText(guildId, department) {
  const roleIds = await getJsonSetting(`higherUpRoles:${department}`, [], guildId);
  const categoryId = await getSetting(`higherUpCategoryId:${department}`, null, guildId);
  const standardCategory = await getSetting(`reportCategoryId:${department}`, null, guildId);
  return [
    `Department: ${department}`,
    `Department Coordinators: ${roleIds.length ? roleIds.map(id => `<@&${id}>`).join(', ') : 'None'}`,
    `Higher-Up Category: ${categoryId ? `<#${categoryId}>` : standardCategory ? `Using report category <#${standardCategory}>` : 'Not configured'}`
  ].join('\n');
}

async function sendReportLog(guild, title, report, extraFields = [], pingHandlers = false) {
  const channelId = await getSetting('reportLogChannelId', null, guild.id);
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  if (!channel?.isTextBased()) return;
  const ticketChannel = guild.channels.cache.get(report.channelId);
  const handlerRoles = pingHandlers ? await getReportHandlerRoles(report, guild.id) : [];
  const validRoles = handlerRoles.filter(id => guild.roles.cache.has(id));
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .addFields(
      { name: 'Department', value: report.department, inline: true },
      { name: 'Type', value: report.ticketType === 'higher' ? 'Higher Up Report' : 'Officer Report', inline: true },
      { name: 'Channel', value: ticketChannel ? `${ticketChannel} (${report.channelId})` : report.channelId, inline: false },
      ...extraFields
    )
    .setFooter({ text: `WCRP Department Utilities | ${formatShort(now())}` });
  await channel.send({
    content: validRoles.length ? validRoles.map(id => `<@&${id}>`).join(' ') : undefined,
    embeds: [embed],
    allowedMentions: { parse: [], roles: validRoles, users: [] }
  }).catch(() => {});
}

function departmentPurchasePanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Department Establishment Request')
    .setDescription('Use the button below to submit a formal request to establish a new department within WCRP. Please provide complete and accurate information. All application questions are required and will be reviewed by Department Management.')
    .setFooter({ text: 'WCRP Department Management' });
}

function departmentPurchasePanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('dept_purchase:start')
      .setLabel('Submit Department Request')
      .setStyle(ButtonStyle.Primary)
  );
}

function departmentPurchaseStepOneModal() {
  return new ModalBuilder()
    .setCustomId('dept_purchase_modal:step1')
    .setTitle('Department Request - 1 of 2')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('department_name').setLabel('Proposed Department Name').setStyle(TextInputStyle.Short).setPlaceholder('Enter the full proposed department name').setRequired(true).setMaxLength(100)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('reason').setLabel('Purpose of the Department').setStyle(TextInputStyle.Paragraph).setPlaceholder("Explain the department's purpose, responsibilities, and why it is needed within WCRP").setRequired(true).setMaxLength(1000)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('jurisdiction').setLabel('Jurisdiction Level').setStyle(TextInputStyle.Short).setPlaceholder('Local / State / Federal').setRequired(true).setMaxLength(20)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('assets_ready').setLabel('Are EUP & Vehicles Ready?').setStyle(TextInputStyle.Short).setPlaceholder('Yes / No - briefly describe their current readiness').setRequired(true).setMaxLength(300)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('high_command_ready').setLabel('Is High Command Assembled?').setStyle(TextInputStyle.Short).setPlaceholder('Yes / No - briefly describe the proposed leadership team').setRequired(true).setMaxLength(300))
    );
}

function departmentPurchaseStepTwoModal() {
  return new ModalBuilder()
    .setCustomId('dept_purchase_modal:step2')
    .setTitle('Department Request - 2 of 2')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('discord_ready').setLabel('Is a Department Discord Ready?').setStyle(TextInputStyle.Short).setPlaceholder('Yes / No - briefly describe its current status').setRequired(true).setMaxLength(300)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('why_allow').setLabel('Why Should WCRP Approve This?').setStyle(TextInputStyle.Paragraph).setPlaceholder('Explain the value this department would bring to WCRP and why it should be approved').setRequired(true).setMaxLength(2000))
    );
}

function departmentPurchaseContinueRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dept_purchase:continue:${userId}`)
      .setLabel('Continue to Final Step')
      .setStyle(ButtonStyle.Primary)
  );
}

function buildDepartmentPurchaseEmbed(application) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Department Establishment Application')
    .setDescription('A formal request to establish a new WCRP department has been submitted for review by Department Management.')
    .addFields(
      { name: 'Applicant', value: `<@${application.userId}>`, inline: true },
      { name: 'Proposed Department', value: clamp(application.departmentName), inline: true },
      { name: 'Jurisdiction Classification', value: clamp(application.jurisdiction), inline: true },
      { name: 'Purpose and Need', value: clamp(application.reason), inline: false },
      { name: 'EUP and Vehicle Readiness', value: clamp(application.assetsReady), inline: false },
      { name: 'High Command Readiness', value: clamp(application.highCommandReady), inline: false },
      { name: 'Department Discord Readiness', value: clamp(application.discordReady), inline: false },
      { name: 'Case for Approval', value: clamp(application.whyAllow), inline: false }
    )
    .setFooter({ text: `WCRP Department Management | Submitted ${formatShort(application.createdAt || now())}` });
}

function departmentPurchasePermissions(guild, userId, handlerRoleIds) {
  return normalReportPermissions(guild, userId, handlerRoleIds);
}

function isDepartmentPurchaseChannel(channel) {
  return Boolean(channel?.topic?.startsWith('WCRP_DEPARTMENT_PURCHASE|'));
}

function parseDepartmentPurchaseTopic(channel) {
  if (!isDepartmentPurchaseChannel(channel)) return null;
  const values = {};
  for (const piece of String(channel.topic || '').split('|').slice(1)) {
    const [key, ...rest] = piece.split('=');
    if (key) values[key] = rest.join('=');
  }
  return values;
}

async function departmentPurchaseConfigText(guildId) {
  const roles = await getJsonSetting('departmentPurchaseRoles', [], guildId);
  const categoryId = await getSetting('departmentPurchaseCategoryId', null, guildId);
  const logId = await getSetting('departmentPurchaseLogChannelId', null, guildId);
  const transcriptId = await getSetting('transcriptChannelId', null, guildId);
  return [
    `Handler Roles: ${roles.length ? roles.map(id => `<@&${id}>`).join(', ') : 'None'}`,
    `Ticket Category: ${categoryId ? `<#${categoryId}>` : 'Not configured'}`,
    `Decision Log Channel: ${logId ? `<#${logId}>` : 'Not configured'}`,
    `Transcript Channel: ${transcriptId ? `<#${transcriptId}>` : 'Not configured - use /log-config type:Transcript Logs'}`
  ].join('\n');
}

async function persistDepartmentPurchase(application, channelId) {
  try {
    await q(
      `INSERT INTO department_purchase_tickets
       (channelId, applicantId, departmentName, reason, jurisdiction, assetsReady, highCommandReady, discordReady, whyAllow, createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [channelId, application.userId, application.departmentName, application.reason, application.jurisdiction,
        application.assetsReady, application.highCommandReady, application.discordReady, application.whyAllow, application.createdAt]
    );
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) throw error;
  }
}

async function ensureDepartmentPurchasePermissions(member) {
  if (!member) return false;
  if (await isAdmin(member)) return true;
  const roles = await getJsonSetting('departmentPurchaseRoles', [], member.guild.id);
  return roles.some(id => member.roles?.cache.has(id));
}

function departmentPurchaseActionRow(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dept_purchase:close:${channelId}`).setLabel('Close').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`dept_purchase:delete:${channelId}`).setLabel('Delete').setStyle(ButtonStyle.Secondary)
  );
}

function departmentPurchaseDeleteRow(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dept_purchase:delete:${channelId}`).setLabel('Delete').setStyle(ButtonStyle.Danger)
  );
}

async function disableDepartmentPurchaseCloseButton(channel) {
  const messages = await channel.messages.fetch({ limit: 75 }).catch(() => null);
  if (!messages?.size) return;
  for (const message of messages.values()) {
    if (message.author.id !== client.user?.id) continue;
    const hasPurchaseClose = message.components?.some(row => row.components?.some(component => String(component.customId || '').startsWith('dept_purchase:close:')));
    if (!hasPurchaseClose) continue;
    await message.edit({ components: [departmentPurchaseDeleteRow(channel.id)] }).catch(() => {});
  }
}

function departmentPurchaseClosedEmbed(closedById) {
  return new EmbedBuilder()
    .setColor(0x6b7280)
    .setTitle('Department Purchase Ticket Closed')
    .setDescription('This department purchase ticket has been closed and its transcript was archived.')
    .addFields({ name: 'Closed By', value: `<@${closedById}>`, inline: true })
    .setFooter({ text: `WCRP Department Utilities | ${formatShort(now())}` });
}

function departmentPurchaseDecisionEmbed(status, interaction, reason, topicData) {
  const approved = status === 'approved';
  return new EmbedBuilder()
    .setColor(approved ? 0x2f9e44 : 0xe04f5f)
    .setTitle(approved ? 'Department Request Approved' : 'Department Request Denied')
    .setDescription(approved ? 'This department purchase request has been approved.' : 'This department purchase request has been denied.')
    .addFields(
      { name: 'Applicant', value: topicData?.applicant ? `<@${topicData.applicant}>` : 'Unknown', inline: true },
      { name: approved ? 'Approved By' : 'Denied By', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Ticket', value: `${interaction.channel} (${interaction.channel.id})`, inline: false },
      { name: 'Reason', value: reason || 'No reason provided.', inline: false }
    )
    .setFooter({ text: `WCRP Department Utilities | ${formatShort(now())}` });
}

async function sendDepartmentPurchaseLog(guild, embed, handlerRoleIds = []) {
  const logId = await getSetting('departmentPurchaseLogChannelId', null, guild.id);
  const logChannel = logId ? guild.channels.cache.get(logId) : null;
  if (!logChannel?.isTextBased()) return false;
  const validRoles = handlerRoleIds.filter(id => guild.roles.cache.has(id));
  await logChannel.send({
    content: validRoles.length ? validRoles.map(id => `<@&${id}>`).join(' ') : undefined,
    embeds: [embed],
    allowedMentions: { parse: [], roles: validRoles, users: [] }
  }).catch(() => {});
  return true;
}

async function archiveDepartmentPurchaseTranscript(channel, label = 'closed') {
  const transcript = await makeTranscript(channel);
  const transcriptId = await getSetting('transcriptChannelId', null, channel.guild.id);
  const fallbackId = await getSetting('departmentPurchaseLogChannelId', null, channel.guild.id);
  const target = (transcriptId && channel.guild.channels.cache.get(transcriptId)) ||
    (fallbackId && channel.guild.channels.cache.get(fallbackId));
  if (!target?.isTextBased()) return false;
  const safeName = cleanName(channel.name);
  await target.send({
    content: `Department purchase ${label} transcript for ${channel.name} (${channel.id})`,
    files: [{ attachment: Buffer.from(transcript || 'No messages.'), name: `${safeName}-${label}-transcript.txt` }],
    allowedMentions: { parse: [] }
  }).catch(() => {});
  return true;
}

async function createDepartmentPurchaseTicket(interaction, application) {
  const guild = interaction.guild;
  const roles = await getJsonSetting('departmentPurchaseRoles', [], guild.id);
  const validRoles = roles.filter(id => guild.roles.cache.has(id));
  const categoryId = await getSetting('departmentPurchaseCategoryId', null, guild.id);
  const parent = categoryId && guild.channels.cache.get(categoryId)?.type === ChannelType.GuildCategory ? categoryId : undefined;
  const channel = await guild.channels.create({
    name: `dept-${cleanName(application.departmentName)}-${cleanName(interaction.user.username)}`.slice(0, 95),
    type: ChannelType.GuildText,
    parent,
    topic: `WCRP_DEPARTMENT_PURCHASE|applicant=${application.userId}|status=pending`,
    permissionOverwrites: departmentPurchasePermissions(guild, application.userId, validRoles)
  });

  await channel.send({
    content: validRoles.length ? validRoles.map(id => `<@&${id}>`).join(' ') : undefined,
    embeds: [buildDepartmentPurchaseEmbed(application)],
    components: [departmentPurchaseActionRow(channel.id)],
    allowedMentions: { parse: [], roles: validRoles, users: [] }
  });
  await persistDepartmentPurchase(application, channel.id);
  return channel;
}

async function handleDepartmentPurchaseDecision(interaction, status) {
  if (!isDepartmentPurchaseChannel(interaction.channel)) {
    return respond(interaction, { content: 'This command can only be used inside a department purchase ticket.' });
  }
  if (!await ensureDepartmentPurchasePermissions(interaction.member)) {
    return respond(interaction, { content: 'Department purchase handler permission required.' });
  }
  const topicData = parseDepartmentPurchaseTopic(interaction.channel) || {};
  if (topicData.closed === '1') return respond(interaction, { content: 'This department purchase ticket is already closed.' });
  if (topicData.status === 'approved' || topicData.status === 'denied') {
    return respond(interaction, { content: `This request has already been ${topicData.status}.` });
  }
  const reason = interaction.options.getString('reason') || null;
  const embed = departmentPurchaseDecisionEmbed(status, interaction, reason, topicData);
  const roles = await getJsonSetting('departmentPurchaseRoles', [], interaction.guild.id);
  const validRoles = roles.filter(id => interaction.guild.roles.cache.has(id));
  const applicantId = topicData.applicant || null;
  await interaction.channel.send({
    content: applicantId ? `<@${applicantId}>` : undefined,
    embeds: [embed],
    allowedMentions: { parse: [], roles: [], users: applicantId ? [applicantId] : [] }
  });
  await sendDepartmentPurchaseLog(interaction.guild, embed, validRoles);
  await interaction.channel.setTopic(`WCRP_DEPARTMENT_PURCHASE|applicant=${applicantId || 'unknown'}|status=${status}|decidedBy=${interaction.user.id}|closed=0`).catch(() => {});
  return respond(interaction, { content: status === 'approved' ? 'Department request approved and logged.' : 'Department request denied and logged.' });
}

async function handleDepartmentPurchaseClose(interaction) {
  if (!isDepartmentPurchaseChannel(interaction.channel)) {
    return respond(interaction, { content: 'This is not a department purchase ticket.' });
  }
  if (!await ensureDepartmentPurchasePermissions(interaction.member)) {
    return respond(interaction, { content: 'Department purchase handler permission required.' });
  }
  const topicData = parseDepartmentPurchaseTopic(interaction.channel) || {};
  if (topicData.closed === '1') return respond(interaction, { content: 'This department purchase ticket is already closed.' });
  await archiveDepartmentPurchaseTranscript(interaction.channel, 'closed');
  const applicantId = topicData.applicant;
  if (applicantId && applicantId !== 'unknown') await interaction.channel.permissionOverwrites.delete(applicantId).catch(() => {});
  await interaction.channel.setTopic(`WCRP_DEPARTMENT_PURCHASE|applicant=${applicantId || 'unknown'}|status=${topicData.status || 'pending'}|closed=1`).catch(() => {});
  await disableDepartmentPurchaseCloseButton(interaction.channel);
  const closedEmbed = departmentPurchaseClosedEmbed(interaction.user.id);
  await interaction.channel.send({ embeds: [closedEmbed], components: [departmentPurchaseDeleteRow(interaction.channel.id)] });
  const roles = await getJsonSetting('departmentPurchaseRoles', [], interaction.guild.id);
  await sendDepartmentPurchaseLog(interaction.guild, closedEmbed, roles);
  return respond(interaction, { content: 'Department purchase ticket closed, transcript archived, and delete control left available.' });
}

async function handleDepartmentPurchaseDelete(interaction) {
  if (!isDepartmentPurchaseChannel(interaction.channel)) {
    return respond(interaction, { content: 'This is not a department purchase ticket.' });
  }
  if (!await ensureDepartmentPurchasePermissions(interaction.member)) {
    return respond(interaction, { content: 'Department purchase handler permission required.' });
  }
  const topicData = parseDepartmentPurchaseTopic(interaction.channel) || {};
  if (topicData.closed !== '1') await archiveDepartmentPurchaseTranscript(interaction.channel, 'deleted');
  const deleteEmbed = new EmbedBuilder()
    .setColor(0xe04f5f)
    .setTitle('Department Purchase Ticket Deleted')
    .addFields(
      { name: 'Ticket', value: `${interaction.channel.name} (${interaction.channel.id})`, inline: false },
      { name: 'Deleted By', value: `<@${interaction.user.id}>`, inline: true }
    )
    .setFooter({ text: `WCRP Department Utilities | ${formatShort(now())}` });
  const roles = await getJsonSetting('departmentPurchaseRoles', [], interaction.guild.id);
  await sendDepartmentPurchaseLog(interaction.guild, deleteEmbed, roles);
  await respond(interaction, { content: 'Department purchase ticket transcript saved. Deleting this channel.' });
  setTimeout(() => interaction.channel.delete().catch(() => {}), 750);
}

async function handleAddDepartment(interaction) {
  const code = normalizeDepartmentCode(interaction.options.getString('code', true));
  const name = String(interaction.options.getString('name', true) || '').trim().replace(/\s+/g, ' ');
  if (!code) {
    return respond(interaction, { content: 'Department codes must be 2-15 characters and may only use letters, numbers, hyphens, or underscores.' });
  }
  if (!name) return respond(interaction, { content: 'Enter a full department name.' });

  const existed = departmentRegistry.has(code);
  if (!existed && departmentRegistry.size >= 25) {
    return respond(interaction, { content: 'The report department menu supports a maximum of 25 departments.' });
  }

  registerDepartmentLocal(code, name);
  await setJsonSetting('departments', departmentDefinitions(), null);

  return respond(interaction, {
    content: `${existed ? 'Updated' : 'Added'} department ${code} - ${name}. It is now available in hours, evaluations, promotions, officer reports, higher-up reports, ride-alongs, and department report configuration.`
  });
}

async function handleHours(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  const department = assertDepartment(interaction.options.getString('department'));
  if (!department) return respond(interaction, { content: 'Select a configured WCRP department.' });
  const timeframe = interaction.options.getString('timeframe');
  const window = windowFor(timeframe);
  const seconds = await totalDutySeconds({ discordId: user.id, department, window });
  const thisWeekSeconds = timeframe === 'this_week'
    ? seconds
    : await totalDutySeconds({ discordId: user.id, department, window: getWeekWindow() });

  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('Duty Hours')
    .setDescription(`<@${user.id}> - ${hoursText(seconds)}`)
    .addFields(
      { name: 'Department', value: department, inline: true },
      { name: 'Timeframe', value: timeframeLabel(timeframe), inline: true },
      { name: 'Promotion Eligibility', value: `${promotionEligibilityText(thisWeekSeconds)}\nThis week: ${hoursText(thisWeekSeconds)}`, inline: false }
    )
    .setFooter({ text: '4h = promotion | 8h = double promotion | WCRP Department Utilities' });
  return respond(interaction, { embeds: [embed] });
}

async function departmentHourRows(department, timeframe) {
  const window = windowFor(timeframe);
  return q(
    `SELECT discordId,
            SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))) seconds
     FROM duty_hours
     WHERE department=? AND inTime IS NOT NULL AND inTime < ?
       AND COALESCE(outTime, UNIX_TIMESTAMP()) > ? AND discordId IS NOT NULL
     GROUP BY discordId ORDER BY seconds DESC`,
    [window.end, window.start, department, window.end, window.start]
  );
}

async function handleDepartmentHours(interaction, mode) {
  const department = assertDepartment(interaction.options.getString('department'));
  if (!department) return respond(interaction, { content: 'Select a configured WCRP department.' });
  const timeframe = interaction.options.getString('timeframe') || 'this_week';
  const rows = await departmentHourRows(department, timeframe);

  if (mode === 'total') {
    const total = rows.reduce((sum, row) => sum + Number(row.seconds || 0), 0);
    return respond(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle('Department Hours')
        .addFields(
          { name: 'Department', value: department, inline: true },
          { name: 'Timeframe', value: timeframeLabel(timeframe), inline: true },
          { name: 'Total', value: hoursText(total), inline: false }
        )
        .setFooter({ text: '4h = promotion | 8h = double promotion | WCRP Department Utilities' })]
    });
  }

  const limit = mode === 'leaderboard' ? 10 : 25;
  const shown = rows.slice(0, limit);
  const description = shown.length
    ? shown.map((row, i) => `${i + 1}. <@${row.discordId}> - ${hoursText(Number(row.seconds))}`).join('\n')
    : 'No recorded hours.';

  return respond(interaction, {
    embeds: [new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle(mode === 'leaderboard' ? 'Department Leaderboard' : 'Department Hours')
      .setDescription(description)
      .setFooter({ text: `${department} | ${timeframeLabel(timeframe)} | WCRP` })]
  });
}

async function handleEvaluate(interaction) {
  const user = interaction.options.getUser('user', true);
  const department = assertDepartment(interaction.options.getString('department'));
  if (!department) return respond(interaction, { content: 'Select a configured WCRP department.' });
  const timeframe = interaction.options.getString('timeframe');
  const window = windowFor(timeframe);
  const requiredHours = Number(await getSetting(`requirement:${department}`, '4', interaction.guild.id));
  const total = await totalDutySeconds({ discordId: user.id, department, window });
  const requiredSeconds = Math.max(0, requiredHours * 3600);
  const remaining = Math.max(0, requiredSeconds - total);

  return respond(interaction, {
    embeds: [new EmbedBuilder()
      .setColor(total >= requiredSeconds ? 0x2f9e44 : 0xe04f5f)
      .setTitle(`${department} Evaluation`)
      .addFields(
        { name: 'Member', value: `<@${user.id}>`, inline: true },
        { name: 'Department', value: department, inline: true },
        { name: 'Timeframe', value: timeframeLabel(timeframe), inline: true },
        { name: 'Hours Worked', value: hoursText(total), inline: true },
        { name: 'Requirement', value: `${requiredHours.toFixed(2)}h`, inline: true },
        { name: 'Status', value: total >= 8 * 3600 ? 'Eligible for Double Promotion' : total >= requiredSeconds ? 'Eligible for Promotion' : 'Below Promotion Requirement', inline: true },
        { name: 'Remaining', value: hoursText(remaining), inline: false }
      )
      .setFooter({ text: '4h = promotion | 8h = double promotion | WCRP Department Utilities' })]
  });
}

async function handleAdminRoleList(interaction, key, label) {
  const action = interaction.options.getString('action', true);
  const role = interaction.options.getRole('role');
  let roles = await getJsonSetting(key, [], interaction.guild.id);

  if (action === 'add') {
    if (!role) return respond(interaction, { content: 'Select a role to add.' });
    roles = [...new Set([...roles, role.id])];
    await setJsonSetting(key, roles, interaction.guild.id);
  } else if (action === 'remove') {
    if (!role) return respond(interaction, { content: 'Select a role to remove.' });
    roles = roles.filter(id => id !== role.id);
    await setJsonSetting(key, roles, interaction.guild.id);
  } else if (action === 'clear') {
    roles = [];
    await setJsonSetting(key, roles, interaction.guild.id);
  }

  return respond(interaction, {
    content: `${label}: ${roles.length ? roles.map(id => `<@&${id}>`).join(', ') : 'None'}`
  });
}

async function handleReportStaff(interaction) {
  const action = interaction.options.getString('action', true);
  const department = assertDepartment(interaction.options.getString('department'));
  if (!department) return respond(interaction, { content: 'Select a configured WCRP department.' });
  const role = interaction.options.getRole('role');
  const key = `reportStaffRoles:${department}`;
  let roles = await getJsonSetting(key, [], interaction.guild.id);

  if (action === 'add') {
    if (!role) return respond(interaction, { content: 'Select the Reports Team role to add.' });
    roles = [...new Set([...roles, role.id])];
    await setJsonSetting(key, roles, interaction.guild.id);
  } else if (action === 'remove') {
    if (!role) return respond(interaction, { content: 'Select the Reports Team role to remove.' });
    roles = roles.filter(id => id !== role.id);
    await setJsonSetting(key, roles, interaction.guild.id);
  } else if (action === 'clear') {
    roles = [];
    await setJsonSetting(key, roles, interaction.guild.id);
  }

  return respond(interaction, { content: await reportConfigText(interaction.guild.id, department) });
}

async function handleReportConfig(interaction) {
  const action = interaction.options.getString('action', true);
  const department = assertDepartment(interaction.options.getString('department'));
  if (!department) return respond(interaction, { content: 'Select a configured WCRP department.' });
  const category = interaction.options.getChannel('category');
  const key = `reportCategoryId:${department}`;

  if (action === 'set_category') {
    if (!category) return respond(interaction, { content: 'Select the ticket category for this department.' });
    await setSetting(key, category.id, interaction.guild.id);
  } else if (action === 'clear_category') {
    await setSetting(key, '', interaction.guild.id);
  }
  return respond(interaction, { content: await reportConfigText(interaction.guild.id, department) });
}

async function handleHigherUpConfig(interaction) {
  const action = interaction.options.getString('action', true);
  const department = assertDepartment(interaction.options.getString('department'));
  if (!department) return respond(interaction, { content: 'Select a configured WCRP department.' });
  const role = interaction.options.getRole('role');
  const category = interaction.options.getChannel('category');
  const roleKey = `higherUpRoles:${department}`;
  const categoryKey = `higherUpCategoryId:${department}`;
  let roles = await getJsonSetting(roleKey, [], interaction.guild.id);

  if (action === 'add_role') {
    if (!role) return respond(interaction, { content: 'Select the department coordinator role to add.' });
    roles = [...new Set([...roles, role.id])];
    await setJsonSetting(roleKey, roles, interaction.guild.id);
  } else if (action === 'remove_role') {
    if (!role) return respond(interaction, { content: 'Select the department coordinator role to remove.' });
    roles = roles.filter(id => id !== role.id);
    await setJsonSetting(roleKey, roles, interaction.guild.id);
  } else if (action === 'clear_roles') {
    await setJsonSetting(roleKey, [], interaction.guild.id);
  } else if (action === 'set_category') {
    if (!category) return respond(interaction, { content: 'Select the higher-up ticket category.' });
    await setSetting(categoryKey, category.id, interaction.guild.id);
  } else if (action === 'clear_category') {
    await setSetting(categoryKey, '', interaction.guild.id);
  }
  return respond(interaction, { content: await higherUpConfigText(interaction.guild.id, department) });
}

async function handleDeptConfig(interaction) {
  const action = interaction.options.getString('action', true);
  const role = interaction.options.getRole('role');
  const category = interaction.options.getChannel('category');
  const channel = interaction.options.getChannel('channel');
  let roles = await getJsonSetting('departmentPurchaseRoles', [], interaction.guild.id);

  if (action === 'add_handler') {
    if (!role) return respond(interaction, { content: 'Select a department purchase handler role.' });
    roles = [...new Set([...roles, role.id])];
    await setJsonSetting('departmentPurchaseRoles', roles, interaction.guild.id);
  } else if (action === 'remove_handler') {
    if (!role) return respond(interaction, { content: 'Select the handler role to remove.' });
    roles = roles.filter(id => id !== role.id);
    await setJsonSetting('departmentPurchaseRoles', roles, interaction.guild.id);
  } else if (action === 'clear_handlers') {
    await setJsonSetting('departmentPurchaseRoles', [], interaction.guild.id);
  } else if (action === 'set_category') {
    if (!category) return respond(interaction, { content: 'Select the department purchase ticket category.' });
    await setSetting('departmentPurchaseCategoryId', category.id, interaction.guild.id);
  } else if (action === 'clear_category') {
    await setSetting('departmentPurchaseCategoryId', '', interaction.guild.id);
  } else if (action === 'set_log') {
    if (!channel) return respond(interaction, { content: 'Select the department purchase log channel.' });
    await setSetting('departmentPurchaseLogChannelId', channel.id, interaction.guild.id);
  } else if (action === 'clear_log') {
    await setSetting('departmentPurchaseLogChannelId', '', interaction.guild.id);
  }

  return respond(interaction, { content: await departmentPurchaseConfigText(interaction.guild.id) });
}

async function handleLogConfig(interaction) {
  const action = interaction.options.getString('action', true);
  const type = interaction.options.getString('type', true);
  const channel = interaction.options.getChannel('channel');
  const key = type === 'report_log'
    ? 'reportLogChannelId'
    : type === 'transcript_log'
      ? 'transcriptChannelId'
      : 'ridealongLogChannelId';

  if (action === 'set') {
    if (!channel) return respond(interaction, { content: 'Select a log channel.' });
    await setSetting(key, channel.id, interaction.guild.id);
  } else if (action === 'clear') {
    await setSetting(key, '', interaction.guild.id);
  }

  const value = await getSetting(key, null, interaction.guild.id);
  return respond(interaction, { content: `${type}: ${value ? `<#${value}>` : 'Not configured'}` });
}

async function handleAddOfficer(interaction) {
  const report = await getReport(interaction.channel.id, interaction.channel);
  if (!report) return respond(interaction, { content: 'This is not a report ticket.' });
  if (!await ensureReportPermissions(interaction.member, report)) {
    return respond(interaction, { content: report.ticketType === 'higher' ? 'Department coordinator permission required.' : 'Reports Team permission required.' });
  }

  const selected = interaction.options.getUser('user');
  const rawId = interaction.options.getString('user_id')?.trim();
  const targetId = selected?.id || rawId;
  if (!/^\d{17,20}$/.test(String(targetId || ''))) {
    return respond(interaction, { content: 'Provide a Discord user or an exact Discord user ID.' });
  }

  const member = await interaction.guild.members.fetch(targetId).catch(() => null);
  if (!member) return respond(interaction, { content: 'That Discord user is not a member of this server.' });

  const oldTargetId = report.reportedUserId;
  report.reportedUserId = targetId;
  await persistReport(report);

  if (Number(report.anonymous) === 1) {
    if (oldTargetId && oldTargetId !== targetId) await interaction.channel.permissionOverwrites.delete(oldTargetId).catch(() => {});
    const handlerRoles = await getReportHandlerRoles(report, interaction.guild.id);
    await interaction.channel.permissionOverwrites.set(await anonymousReportPermissions(interaction.guild, report, handlerRoles));
    await replaceReportPost(interaction.channel, report, { pingHandlers: true, pingReported: true });
  } else {
    await replaceReportPost(interaction.channel, report, { pingHandlers: true });
  }

  return respond(interaction, {
    content: Number(report.anonymous) === 1
      ? `Officer set to <@${targetId}>. They now have read-only access and the complete report plus evidence was resubmitted.`
      : `Officer set to <@${targetId}>. The full ticket embed was refreshed.`
  });
}

async function handleAnonReport(interaction) {
  const report = await getReport(interaction.channel.id, interaction.channel);
  if (!report) return respond(interaction, { content: 'This is not a report ticket.' });

  const isReporter = report.reporterId === interaction.user.id;
  const isHandler = await ensureReportPermissions(interaction.member, report);
  if (!isReporter && !isHandler) {
    return respond(interaction, { content: 'Only the report opener or the configured handler role for this department can anonymize this ticket.' });
  }

  report.anonymous = 1;
  await persistReport(report);
  const handlerRoles = await getReportHandlerRoles(report, interaction.guild.id);
  const overwrites = await anonymousReportPermissions(interaction.guild, report, handlerRoles);
  await interaction.channel.permissionOverwrites.set(overwrites);
  await interaction.channel.setName(`anon-${report.department.toLowerCase()}`).catch(() => {});
  await clearChannelFast(interaction.channel);
  await sendReportPost(interaction.channel, report, { pingHandlers: true, pingReported: Boolean(report.reportedUserId) });
  await sendReportLog(interaction.guild, 'Report Anonymized', report, [
    { name: 'Reported Officer', value: report.reportedUserId ? `<@${report.reportedUserId}>` : 'Not set', inline: true }
  ], true);

  return respond(interaction, {
    content: report.reportedUserId
      ? 'The ticket is anonymous. The opener was removed; only the configured department handlers, the bot, and the reported officer retain access.'
      : 'The ticket is anonymous. The opener was removed; only the configured department handlers and the bot retain access until /addofficer is used.'
  });
}

async function handleRename(interaction) {
  const report = await getReport(interaction.channel.id, interaction.channel);
  if (!report) return respond(interaction, { content: 'This is not a report ticket.' });
  if (!await ensureReportPermissions(interaction.member, report)) {
    return respond(interaction, { content: 'Configured report handler permission required.' });
  }
  const base = cleanName(interaction.user.username);
  await interaction.channel.setName(`${base}-handling`);
  return respond(interaction, { content: `Channel renamed to ${base}-handling.` });
}

async function disableReportCloseButtons(channel) {
  const messages = await channel.messages.fetch({ limit: 75 }).catch(() => null);
  if (!messages?.size) return;
  for (const message of messages.values()) {
    if (message.author.id !== client.user?.id) continue;
    if (!message.components?.some(row => row.components?.some(component => String(component.customId || '').startsWith('report_close:')))) continue;
    await message.edit({ components: [] }).catch(() => {});
  }
}

async function handleClose(interaction) {
  if (isDepartmentPurchaseChannel(interaction.channel)) return handleDepartmentPurchaseClose(interaction);
  const report = await getReport(interaction.channel.id, interaction.channel);
  if (!report) return respond(interaction, { content: 'This is not a report ticket.' });
  if (!await ensureReportPermissions(interaction.member, report)) {
    return respond(interaction, { content: 'Configured report handler permission required.' });
  }
  if (report.closedAt) return respond(interaction, { content: 'This ticket is already closed.' });

  report.closedAt = now();
  await persistReport(report);
  await archiveReportTranscript(interaction.channel, report, 'closed');

  if (report.reporterId) await interaction.channel.permissionOverwrites.delete(report.reporterId).catch(() => {});
  if (report.reportedUserId) await interaction.channel.permissionOverwrites.delete(report.reportedUserId).catch(() => {});
  await disableReportCloseButtons(interaction.channel);

  const handlerRoles = await getReportHandlerRoles(report, interaction.guild.id);
  const validRoles = handlerRoles.filter(id => interaction.guild.roles.cache.has(id));
  const content = validRoles.length ? validRoles.map(id => `<@&${id}>`).join(' ') : undefined;
  const allowedMentions = { parse: [], roles: validRoles, users: [] };

  await interaction.channel.send({ content, embeds: [ticketClosedEmbed(report, interaction.user.id)], allowedMentions });
  await interaction.channel.send({ embeds: [deleteTicketEmbed()], components: [reportDeleteButton(interaction.channel.id)] });
  await sendReportLog(interaction.guild, 'Report Closed', report, [
    { name: 'Closed By', value: `<@${interaction.user.id}>`, inline: true }
  ], true);
  return respond(interaction, { content: 'Ticket closed, logged, handler role pinged, and the delete control was added.' });
}

async function handleDelete(interaction) {
  if (isDepartmentPurchaseChannel(interaction.channel)) return handleDepartmentPurchaseDelete(interaction);
  const report = await getReport(interaction.channel.id, interaction.channel);
  if (!report) return respond(interaction, { content: 'This is not a report ticket.' });
  if (!await ensureReportPermissions(interaction.member, report) && !(await isAdmin(interaction.member))) {
    return respond(interaction, { content: 'Configured report handler permission required.' });
  }

  if (!report.closedAt) await archiveReportTranscript(interaction.channel, report, 'deleted');
  await sendReportLog(interaction.guild, 'Report Deleted', report, [
    { name: 'Deleted By', value: `<@${interaction.user.id}>`, inline: true }
  ], false);
  await respond(interaction, { content: 'Ticket log saved. Deleting this channel.' });
  setTimeout(() => interaction.channel.delete().catch(() => {}), 750);
}

async function handleRideAlong(interaction) {
  if (!await roleAllowed(interaction.member, 'ridealongRoles')) {
    return respond(interaction, { content: 'You do not have permission to log ride-alongs.' });
  }

  const player = interaction.options.getUser('player', true);
  const department = assertDepartment(interaction.options.getString('department'));
  if (!department) return respond(interaction, { content: 'Select a configured WCRP department.' });
  const result = interaction.options.getString('result', true);
  const selectedRole = interaction.options.getRole('ridealong_role');
  const configuredRoleId = await getSetting('ridealongResultRoleId', null, interaction.guild.id);
  const traineeRoleId = await getSetting('traineeRoleId', null, interaction.guild.id);
  const notes = interaction.options.getString('notes');
  const roleId = selectedRole?.id || configuredRoleId || null;

  const member = await interaction.guild.members.fetch(player.id).catch(() => null);
  let traineeRemoved = false;
  let resultRoleAdded = false;
  if (member && traineeRoleId && member.roles.cache.has(traineeRoleId)) {
    traineeRemoved = await member.roles.remove(traineeRoleId, `Ride-along logged by ${interaction.user.tag}`).then(() => true).catch(() => false);
  }
  if (member && result === 'Passed' && roleId && !member.roles.cache.has(roleId)) {
    resultRoleAdded = await member.roles.add(roleId, `Ride-along passed and logged by ${interaction.user.tag}`).then(() => true).catch(() => false);
  }

  let databaseRecorded = true;
  try {
    await q(
      'INSERT INTO ridealongs (discordId,department,ridealongRoleId,result,notes,createdBy,createdAt) VALUES (?,?,?,?,?,?,?)',
      [player.id, department, roleId, result, notes || null, interaction.user.id, now()]
    );
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) databaseRecorded = false;
    else throw error;
  }

  const embed = new EmbedBuilder()
    .setColor(result === 'Passed' ? 0x2f9e44 : 0xe04f5f)
    .setTitle('Ride-Along Log')
    .addFields(
      { name: 'Player', value: `<@${player.id}>`, inline: true },
      { name: 'Department', value: department, inline: true },
      { name: 'Result', value: result, inline: true },
      { name: 'Trainee Role Removed', value: traineeRemoved ? 'Yes' : 'No', inline: true },
      { name: 'Ride-Along Role Added', value: resultRoleAdded ? 'Yes' : 'No', inline: true },
      { name: 'Database Record', value: databaseRecorded ? 'Saved' : 'MySQL offline; Discord role changes still completed', inline: false },
      { name: 'Notes', value: notes || 'None', inline: false },
      { name: 'Logged By', value: `<@${interaction.user.id}>`, inline: true }
    )
    .setFooter({ text: `WCRP Department Utilities | ${formatShort(now())}` });

  const logChannelId = await getSetting('ridealongLogChannelId', null, interaction.guild.id);
  const logChannel = logChannelId ? interaction.guild.channels.cache.get(logChannelId) : null;
  if (logChannel?.isTextBased()) await logChannel.send({ embeds: [embed] }).catch(() => {});
  return respond(interaction, { embeds: [embed] });
}

async function handleCommand(interaction) {
  const name = interaction.commandName;

  if (!interaction.guild) {
    return respond(interaction, { content: 'This command can only be used in a server.' });
  }

  if (REPORT_GUILD_COMMANDS.has(name) && interaction.guild.id !== REPORT_GUILD_ID) {
    return respond(interaction, { content: `Reports and ride-alongs are only available in server ${REPORT_GUILD_ID}.` });
  }

  if (!(await commandAllowed(interaction.member, name))) {
    return respond(interaction, { content: 'You do not have permission to use this command.' });
  }

  if (ADMIN_COMMANDS.has(name) && !(await isAdmin(interaction.member))) {
    return respond(interaction, { content: 'Administrator permission required.' });
  }

  if (name === 'officer-report-panel') {
    await interaction.channel.send({ content: 'WCRP Reports', components: [reportPanelRow()], allowedMentions: { parse: [] } });
    return respond(interaction, { content: 'WCRP report buttons posted.' });
  }

  if (name === 'admin-roles') {
    return handleAdminRoleList(interaction, 'adminRoles', 'Bot administrator roles');
  }

  if (name === 'permissions') {
    const action = interaction.options.getString('action', true);
    const commandName = String(interaction.options.getString('command', true)).toLowerCase().replace(/^\//, '').trim();
    const role = interaction.options.getRole('role');
    if (!commands.some(command => command.name === commandName)) {
      return respond(interaction, { content: `Unknown command: /${commandName}` });
    }
    let roles = await getJsonSetting(`cmdperm:${commandName}`, [], interaction.guild.id);
    if (action === 'add') {
      if (!role) return respond(interaction, { content: 'Select a role to add.' });
      roles = [...new Set([...roles, role.id])];
      await setJsonSetting(`cmdperm:${commandName}`, roles, interaction.guild.id);
    } else if (action === 'remove') {
      if (!role) return respond(interaction, { content: 'Select a role to remove.' });
      roles = roles.filter(id => id !== role.id);
      await setJsonSetting(`cmdperm:${commandName}`, roles, interaction.guild.id);
    } else if (action === 'clear') {
      roles = [];
      await setJsonSetting(`cmdperm:${commandName}`, roles, interaction.guild.id);
    }
    return respond(interaction, {
      content: `/${commandName}: ${roles.length ? roles.map(id => `<@&${id}>`).join(', ') : 'Everyone'}`
    });
  }

  if (name === 'report-config') return handleReportConfig(interaction);
  if (name === 'report-staff') return handleReportStaff(interaction);
  if (name === 'higherup-config') return handleHigherUpConfig(interaction);
  if (name === 'dept-config') return handleDeptConfig(interaction);
  if (name === 'dept') {
    if (interaction.options.getSubcommand() === 'ticket') {
      await interaction.channel.send({ embeds: [departmentPurchasePanelEmbed()], components: [departmentPurchasePanelRow()] });
      return respond(interaction, { content: 'Department purchase ticket panel posted.' });
    }
  }
  if (name === 'approve') return handleDepartmentPurchaseDecision(interaction, 'approved');
  if (name === 'denied') return handleDepartmentPurchaseDecision(interaction, 'denied');
  if (name === 'ridealong-permissions') return handleAdminRoleList(interaction, 'ridealongRoles', 'Ride-along permission roles');
  if (name === 'log-config') return handleLogConfig(interaction);

  if (name === 'ridealong-config') {
    const action = interaction.options.getString('action', true);
    const rideRole = interaction.options.getRole('ridealong_role');
    const traineeRole = interaction.options.getRole('trainee_role');
    if (action === 'set') {
      if (rideRole) await setSetting('ridealongResultRoleId', rideRole.id, interaction.guild.id);
      if (traineeRole) await setSetting('traineeRoleId', traineeRole.id, interaction.guild.id);
      if (!rideRole && !traineeRole) {
        return respond(interaction, { content: 'Select a ride-along role, trainee role, or both.' });
      }
    } else if (action === 'clear') {
      await setSetting('ridealongResultRoleId', '', interaction.guild.id);
      await setSetting('traineeRoleId', '', interaction.guild.id);
    }
    const currentRide = await getSetting('ridealongResultRoleId', null, interaction.guild.id);
    const currentTrainee = await getSetting('traineeRoleId', null, interaction.guild.id);
    return respond(interaction, {
      content: `Ride-along role: ${currentRide ? `<@&${currentRide}>` : 'Not configured'}\nTrainee role: ${currentTrainee ? `<@&${currentTrainee}>` : 'Not configured'}`
    });
  }

  if (name === 'addofficer') return handleAddOfficer(interaction);

  if (name === 'reportadd') {
    const department = assertDepartment(interaction.options.getString('department'));
    if (!department) return respond(interaction, { content: 'Select a configured WCRP department.' });
    if (!await ensureReportPermissions(interaction.member, { ticketType: 'officer', department })) {
      return respond(interaction, { content: `Reports Team permission for ${department} required.` });
    }
    const channel = await createReportTicket({
      interaction,
      type: 'officer',
      department,
      reportedUserId: interaction.options.getUser('officer')?.id || null,
      dateOfIncident: interaction.options.getString('date'),
      gameId: interaction.options.getString('game_id'),
      clip: interaction.options.getString('evidence'),
      description: interaction.options.getString('description'),
      context: interaction.options.getString('context')
    });
    if (channel) {
      const report = await getReport(channel.id, channel);
      if (report) await sendReportLog(interaction.guild, 'Report Created', report, [], true);
    }
    return respond(interaction, { content: channel ? `Report created: ${channel}` : 'Unable to create the report.' });
  }

  if (name === 'anonreport') return handleAnonReport(interaction);
  if (name === 'rename') return handleRename(interaction);
  if (name === 'close') return handleClose(interaction);
  if (name === 'delete') return handleDelete(interaction);
  if (name === 'ridealong') return handleRideAlong(interaction);
  if (name === 'add' && interaction.options.getSubcommand() === 'dept') return handleAddDepartment(interaction);
  if (name === 'hours') return handleHours(interaction);
  if (name === 'evaluate') return handleEvaluate(interaction);

  if (['allhours', 'totalhours', 'weeklydeptours', 'leaderboard'].includes(name)) {
    return handleDepartmentHours(interaction, name === 'totalhours' ? 'total' : name);
  }

  if (name === 'deptofhours') {
    const department = assertDepartment(interaction.options.getString('department'));
    if (!department) return respond(interaction, { content: 'Select a configured WCRP department.' });
    const timeframe = interaction.options.getString('timeframe') || 'this_week';
    const rows = (await departmentHourRows(department, timeframe)).slice(0, 10);
    const description = rows.length
      ? rows.map((row, i) => `${i + 1}. <@${row.discordId}> - ${hoursText(Number(row.seconds))}`).join('\n')
      : 'No recorded hours.';
    return respond(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle(`Top ${department} Officers`)
        .setDescription(description)
        .setFooter({ text: `${timeframeLabel(timeframe)} | WCRP Department Utilities` })]
    });
  }

  if (name === 'tophours') {
    const rows = await q(
      'SELECT discordId, SUM(GREATEST(0, COALESCE(outTime, UNIX_TIMESTAMP()) - inTime)) seconds FROM duty_hours WHERE discordId IS NOT NULL GROUP BY discordId ORDER BY seconds DESC LIMIT 5'
    );
    const description = rows.length
      ? rows.map((row, i) => `${i + 1}. <@${row.discordId}> - ${hoursText(Number(row.seconds))}`).join('\n')
      : 'No recorded hours.';
    return respond(interaction, {
      embeds: [new EmbedBuilder().setColor(0x3b82f6).setTitle('Top Hours').setDescription(description).setFooter({ text: 'WCRP Department Utilities' })]
    });
  }

  if (name === 'inactive_officers') {
    const department = assertDepartment(interaction.options.getString('department'));
    if (!department) return respond(interaction, { content: 'Select a configured WCRP department.' });
    const weeks = interaction.options.getInteger('weeks_back') || 2;
    const cutoff = now() - weeks * 7 * 86400;
    const rows = await q(
      'SELECT discordId, MAX(COALESCE(outTime, UNIX_TIMESTAMP())) lastDuty FROM duty_hours WHERE department=? AND discordId IS NOT NULL GROUP BY discordId HAVING lastDuty < ? ORDER BY lastDuty ASC',
      [department, cutoff]
    );
    const description = rows.length
      ? rows.map(row => `<@${row.discordId}> - last duty ${formatShort(Number(row.lastDuty))}`).join('\n')
      : 'No inactive officers found.';
    return respond(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0xe0a458)
        .setTitle(`${department} Inactive Officers`)
        .setDescription(description)
        .setFooter({ text: `${weeks}+ weeks without duty | WCRP` })]
    });
  }

  if (name === 'dept_officers') {
    const department = assertDepartment(interaction.options.getString('department'));
    if (!department) return respond(interaction, { content: 'Select a configured WCRP department.' });
    const weeks = interaction.options.getInteger('weeks_back') || 2;
    const cutoff = now() - weeks * 7 * 86400;
    const rows = await q(
      'SELECT discordId, MAX(COALESCE(outTime, UNIX_TIMESTAMP())) lastDuty, SUM(GREATEST(0, COALESCE(outTime, UNIX_TIMESTAMP()) - inTime)) seconds FROM duty_hours WHERE department=? AND discordId IS NOT NULL GROUP BY discordId ORDER BY lastDuty DESC',
      [department]
    );
    const shown = rows.slice(0, 25);
    const description = shown.length
      ? shown.map(row => `<@${row.discordId}> - ${hoursText(Number(row.seconds))} - ${Number(row.lastDuty) >= cutoff ? 'Active' : 'Inactive'} - ${formatShort(Number(row.lastDuty))}`).join('\n')
      : 'No officers found.';
    return respond(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle(`${department} Officers`)
        .setDescription(description)
        .setFooter({ text: `Active means duty within ${weeks} weeks | WCRP` })]
    });
  }

  if (name === 'promotions') {
    const department = assertDepartment(interaction.options.getString('department'));
    if (!department) return respond(interaction, { content: 'Select a configured WCRP department.' });
    const minimum = 4;
    const window = getWeekWindow();
    const rows = await q(
      `SELECT discordId,
              SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))) seconds
       FROM duty_hours
       WHERE department=? AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ? AND discordId IS NOT NULL
       GROUP BY discordId HAVING seconds >= ? ORDER BY seconds DESC`,
      [window.end, window.start, department, window.end, window.start, minimum * 3600]
    );
    const description = rows.length
      ? rows.map(row => `<@${row.discordId}> - ${hoursText(Number(row.seconds))} - ${Number(row.seconds) >= 8 * 3600 ? 'Eligible for Double Promotion' : 'Eligible for Promotion'}`).join('\n')
      : 'No members meet the current threshold.';
    return respond(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle(`${department} Promotion Eligibility`)
        .setDescription(description)
        .setFooter({ text: `Promotion: ${minimum}h minimum | Double promotion: 8h | WCRP` })]
    });
  }

  if (name === 'leomulti') {
    const duration = interaction.options.getInteger('duration_minutes', true);
    const multiplier = interaction.options.getNumber('multiplier') || 1.5;
    await setJsonSetting('leoMultiplier', { multiplier, until: now() + duration * 60 }, interaction.guild.id);
    return respond(interaction, { content: `LEO hour multiplier marker set to ${multiplier}x for ${duration} minutes.` });
  }

  if (name === 'add_org') {
    const code = interaction.options.getString('code', true).toUpperCase();
    const orgName = interaction.options.getString('name', true);
    await q('INSERT INTO department_orgs (code,name,createdBy) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [code, orgName, interaction.user.id]);
    return respond(interaction, { content: `Added organisation ${code} - ${orgName}.` });
  }

  if (name === 'add_org_hours') {
    const code = interaction.options.getString('code', true).toUpperCase();
    const hours = interaction.options.getNumber('hours', true);
    const reason = interaction.options.getString('reason');
    await q('INSERT INTO org_hours_adjustments (orgCode,hours,reason,createdBy,createdAt) VALUES (?,?,?,?,?)', [code, hours, reason || null, interaction.user.id, now()]);
    return respond(interaction, { content: `Added ${hours.toFixed(2)} hours to ${code}.` });
  }

  if (name === 'rename_org') {
    const oldCode = interaction.options.getString('old_code', true).toUpperCase();
    const newCode = interaction.options.getString('new_code', true).toUpperCase();
    const orgName = interaction.options.getString('name', true);
    await q('UPDATE department_orgs SET code=?,name=? WHERE code=?', [newCode, orgName, oldCode]);
    await q('UPDATE org_hours_adjustments SET orgCode=? WHERE orgCode=?', [newCode, oldCode]);
    return respond(interaction, { content: `Renamed ${oldCode} to ${newCode}.` });
  }

  return respond(interaction, { content: 'Command handler not implemented.' });
}

async function handleReportStartButton(interaction) {
  if (!interaction.guild || interaction.guild.id !== REPORT_GUILD_ID) {
    return interaction.reply({ content: `Reports are only available in server ${REPORT_GUILD_ID}.`, flags: MessageFlags.Ephemeral });
  }
  const type = interaction.customId.split(':')[1] === 'higher' ? 'higher' : 'officer';
  return interaction.reply({
    content: type === 'higher'
      ? 'Select the department. Only the configured department coordinator role will receive and handle this ticket.'
      : 'Select the department. Only that department\'s configured Reports Team role will receive and handle this ticket.',
    components: [reportDepartmentSelect(type, interaction.user.id)],
    flags: MessageFlags.Ephemeral
  });
}

async function handleReportDepartmentSelect(interaction) {
  if (!interaction.guild || interaction.guild.id !== REPORT_GUILD_ID) {
    return interaction.reply({ content: `Reports are only available in server ${REPORT_GUILD_ID}.`, flags: MessageFlags.Ephemeral });
  }
  const [, typeRaw, ownerId] = interaction.customId.split(':');
  if (ownerId && ownerId !== interaction.user.id) {
    return interaction.reply({ content: 'This department selector belongs to another user.', flags: MessageFlags.Ephemeral });
  }
  const type = typeRaw === 'higher' ? 'higher' : 'officer';
  const department = assertDepartment(interaction.values[0]);
  if (!department) {
    return interaction.reply({ content: 'Select a valid WCRP department.', flags: MessageFlags.Ephemeral });
  }
  return interaction.showModal(reportFieldsModal(type, department));
}

async function handleReportModal(interaction) {
  const [, typeRaw = 'officer', departmentRaw = ''] = interaction.customId.split(':');
  const type = typeRaw === 'higher' ? 'higher' : 'officer';
  const department = assertDepartment(departmentRaw);
  if (!department) return respond(interaction, { content: 'The selected department is invalid.' });

  const channel = await createReportTicket({
    interaction,
    type,
    department,
    reportedUserId: null,
    dateOfIncident: interaction.fields.getTextInputValue('date'),
    gameId: interaction.fields.getTextInputValue('game_id'),
    clip: interaction.fields.getTextInputValue('evidence'),
    description: interaction.fields.getTextInputValue('description'),
    context: interaction.fields.getTextInputValue('context')
  });

  if (channel) {
    const report = await getReport(channel.id, channel);
    if (report) await sendReportLog(interaction.guild, 'Report Created', report, [], true);
  }
  return respond(interaction, { content: channel ? `Your report ticket has been created: ${channel}` : 'Unable to create the report ticket.' });
}

async function handleReportCloseButton(interaction) {
  if (!interaction.guild || interaction.guild.id !== REPORT_GUILD_ID) {
    return respond(interaction, { content: `Reports are only available in server ${REPORT_GUILD_ID}.` });
  }
  return handleClose(interaction);
}

async function handleReportDeleteButton(interaction) {
  if (!interaction.guild || interaction.guild.id !== REPORT_GUILD_ID) {
    return respond(interaction, { content: `Reports are only available in server ${REPORT_GUILD_ID}.` });
  }
  return handleDelete(interaction);
}

async function handleDepartmentPurchaseStart(interaction) {
  if (!interaction.guild || interaction.guild.id !== REPORT_GUILD_ID) {
    return interaction.reply({ content: `Department tickets are only available in server ${REPORT_GUILD_ID}.`, flags: MessageFlags.Ephemeral });
  }
  return interaction.showModal(departmentPurchaseStepOneModal());
}

async function handleDepartmentPurchaseStepOne(interaction) {
  const key = `${interaction.guild.id}:${interaction.user.id}`;
  departmentPurchaseDrafts.set(key, {
    userId: interaction.user.id,
    departmentName: interaction.fields.getTextInputValue('department_name'),
    reason: interaction.fields.getTextInputValue('reason'),
    jurisdiction: interaction.fields.getTextInputValue('jurisdiction'),
    assetsReady: interaction.fields.getTextInputValue('assets_ready'),
    highCommandReady: interaction.fields.getTextInputValue('high_command_ready'),
    startedAt: now()
  });
  return respond(interaction, {
    content: 'Step 1 saved. Continue to finish the required department application questions.',
    components: [departmentPurchaseContinueRow(interaction.user.id)]
  });
}

async function handleDepartmentPurchaseContinue(interaction) {
  const [, action, ownerId] = interaction.customId.split(':');
  if (action !== 'continue' || ownerId !== interaction.user.id) {
    return interaction.reply({ content: 'This application button belongs to another user.', flags: MessageFlags.Ephemeral });
  }
  const key = `${interaction.guild.id}:${interaction.user.id}`;
  const draft = departmentPurchaseDrafts.get(key);
  if (!draft || now() - draft.startedAt > 900) {
    departmentPurchaseDrafts.delete(key);
    return interaction.reply({ content: 'That application expired. Press Purchase Department again to restart.', flags: MessageFlags.Ephemeral });
  }
  return interaction.showModal(departmentPurchaseStepTwoModal());
}

async function handleDepartmentPurchaseStepTwo(interaction) {
  const key = `${interaction.guild.id}:${interaction.user.id}`;
  const draft = departmentPurchaseDrafts.get(key);
  if (!draft || now() - draft.startedAt > 900) {
    departmentPurchaseDrafts.delete(key);
    return respond(interaction, { content: 'That application expired. Press Purchase Department again to restart.' });
  }
  const application = {
    ...draft,
    discordReady: interaction.fields.getTextInputValue('discord_ready'),
    whyAllow: interaction.fields.getTextInputValue('why_allow'),
    createdAt: now()
  };
  const channel = await createDepartmentPurchaseTicket(interaction, application);
  departmentPurchaseDrafts.delete(key);
  return respond(interaction, { content: channel ? `Your department request ticket has been created: ${channel}` : 'Unable to create the department request ticket.' });
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'department') return interaction.respond([]);
  const query = String(focused.value || '').trim().toLowerCase();
  const choices = departmentDefinitions()
    .filter(({ code, name }) => !query || code.toLowerCase().includes(query) || name.toLowerCase().includes(query))
    .slice(0, 25)
    .map(({ code, name }) => ({ name: `${code} - ${name}`.slice(0, 100), value: code }));
  return interaction.respond(choices);
}

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isAutocomplete()) {
      return await handleAutocomplete(interaction);
    }

    if (interaction.isChatInputCommand()) {
      const privateReply = PRIVATE_COMMANDS.has(interaction.commandName);
      await interaction.deferReply(privateReply ? { flags: MessageFlags.Ephemeral } : {});
      return await handleCommand(interaction);
    }

    if (interaction.isButton() && interaction.customId.startsWith('report_start:')) {
      return await handleReportStartButton(interaction);
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('report_department:')) {
      return await handleReportDepartmentSelect(interaction);
    }

    if (interaction.isButton() && interaction.customId.startsWith('report_close:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return await handleReportCloseButton(interaction);
    }

    if (interaction.isButton() && interaction.customId.startsWith('report_delete:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return await handleReportDeleteButton(interaction);
    }

    if (interaction.isButton() && interaction.customId === 'dept_purchase:start') {
      return await handleDepartmentPurchaseStart(interaction);
    }

    if (interaction.isButton() && interaction.customId.startsWith('dept_purchase:continue:')) {
      return await handleDepartmentPurchaseContinue(interaction);
    }

    if (interaction.isButton() && interaction.customId.startsWith('dept_purchase:close:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return await handleDepartmentPurchaseClose(interaction);
    }

    if (interaction.isButton() && interaction.customId.startsWith('dept_purchase:delete:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return await handleDepartmentPurchaseDelete(interaction);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('report_modal:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!interaction.guild || interaction.guild.id !== REPORT_GUILD_ID) {
        return respond(interaction, { content: `Reports are only available in server ${REPORT_GUILD_ID}.` });
      }
      return await handleReportModal(interaction);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'dept_purchase_modal:step1') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!interaction.guild || interaction.guild.id !== REPORT_GUILD_ID) {
        return respond(interaction, { content: `Department tickets are only available in server ${REPORT_GUILD_ID}.` });
      }
      return await handleDepartmentPurchaseStepOne(interaction);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'dept_purchase_modal:step2') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!interaction.guild || interaction.guild.id !== REPORT_GUILD_ID) {
        return respond(interaction, { content: `Department tickets are only available in server ${REPORT_GUILD_ID}.` });
      }
      return await handleDepartmentPurchaseStepTwo(interaction);
    }
  } catch (error) {
    return failInteraction(interaction, error);
  }
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);

  try {
    await registerCommands();
  } catch (error) {
    console.error('GLOBAL COMMAND REGISTRATION FAILED:', error);
  }

  const initializeDatabase = async () => {
    try {
      await ensureSchema();
      await refreshDepartmentRegistry();
      const dutyReady = await pollDuty();
      if (dutyReady) console.log('DATABASE / DUTY TRACKING ONLINE');
      else console.warn('DATABASE ONLINE, BUT DUTY TRACKING COULD NOT INITIALIZE.');
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) {
        console.warn('DATABASE / DUTY TRACKING OFFLINE. Discord commands remain online.');
      } else {
        console.error('DATABASE STARTUP ERROR:', error);
      }
    }
  };

  await initializeDatabase();

  if (!globalThis.__dutyInterval) {
    globalThis.__dutyInterval = setInterval(async () => {
      await pollDuty();
      if (Date.now() >= dbUnavailableUntil) {
        await ensureSchema().catch(() => {});
        await flushDirtySettings().catch(() => {});
      }
    }, DUTY_POLL_MS);
  }
});

async function shutdown() {
  if (globalThis.__dutyInterval) clearInterval(globalThis.__dutyInterval);
  if (pool) await pool.end().catch(() => {});
}

process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });

async function start() {
  if (!TOKEN || !CLIENT_ID) throw new Error('Missing DISCORD_TOKEN or CLIENT_ID.');
  await client.login(TOKEN);
}

if (require.main === module) {
  start().catch(error => {
    console.error('BOT STARTUP FAILED:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  REPORT_GUILD_ID,
  DEPARTMENTS,
  DEFAULT_DEPARTMENTS,
  LEO_VOICE_CHANNELS,
  buildCommandsJson,
  reportFieldsModal,
  buildReportEmbed,
  splitEvidence,
  assertDepartment,
  normalizeDepartmentCode,
  departmentDefinitions,
  timeframeLabel,
  getWeekWindow,
  windowFor,
  formatDuration,
  formatSessionDuration,
  hoursText
};
