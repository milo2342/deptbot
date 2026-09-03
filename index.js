require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
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
  MessageFlags
} = require('discord.js');
const mysql = require('mysql2/promise');
const { DateTime } = require('luxon');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const REPORT_GUILD_ID = process.env.LOG_GUILD_ID || '1499578614298181642';
const TIMEZONE = process.env.TIMEZONE || 'Europe/London';
const DUTY_POLL_MS = Math.max(5000, Number(process.env.DUTY_POLL_MS || 10000));
const DB_TIMEOUT_MS = Math.max(1000, Number(process.env.MYSQL_QUERY_TIMEOUT_MS || 4000));
const DEPARTMENTS = ['USM', 'SASP', 'BCSO', 'LSPD'];
const LEO_VOICE_CHANNELS = [
  '1542399560394088538',
  '1542399564588261446',
  '1542399567234994206'
];
const BLUE = 0x2F80ED;
const REPORT_COMMANDS = new Set(['officer-report-panel','anonreport','addofficer','reportadd','report-config','report-staff','log-config','rename','close','delete','ridealong','ridealong-permissions']);
const ADMIN_COMMANDS = new Set(['officer-report-panel','report-config','report-staff','log-config','ridealong-permissions','permissions','admin-roles','add_org','add_org_hours','rename_org']);
const ALL_COMMANDS = [
  'officer-report-panel','anonreport','addofficer','reportadd','report-config','report-staff','log-config','ridealong-permissions','ridealong',
  'permissions','admin-roles','rename','close','delete','hours','allhours','totalhours','weeklydeptours','deptofhours','tophours','leaderboard',
  'evaluate','inactive_officers','promotions','leomulti','add_org','add_org_hours','rename_org','dept_officers'
];

if (!TOKEN || !CLIENT_ID) throw new Error('Missing DISCORD_TOKEN or CLIENT_ID.');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 0,
  connectTimeout: DB_TIMEOUT_MS,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
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

let dbOnline = false;
let dbRetryTimer = null;
let dutyTimer = null;
const activeDuty = new Map();
const currentVoice = new Map();

const now = () => Math.floor(Date.now() / 1000);
const dt = ts => DateTime.fromSeconds(Number(ts), { zone: TIMEZONE });
const formatDateTime = ts => dt(ts).toFormat('cccc, dd LLLL yyyy HH:mm');
const formatShort = ts => dt(ts).toFormat('dd/MM/yyyy HH:mm');
function formatDuration(seconds) {
  let s = Math.max(0, Math.floor(Number(seconds || 0)));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); const sec = s % 60;
  if (d) return `${d}d ${h}h ${m}m ${sec}s`;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
const hoursText = seconds => `${(Math.max(0, Number(seconds || 0)) / 3600).toFixed(2)}h`;
const deptName = d => ({ USM:'United States Marshals', SASP:'San Andreas State Police', BCSO:"Blaine County Sheriff's Office", LSPD:'Los Santos Police Department' }[d] || d);
const clean = v => String(v || 'user').toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,70) || 'user';
const dept = v => { const x = String(v || '').toUpperCase(); return DEPARTMENTS.includes(x) ? x : null; };
const isLeoVoice = id => !!id && LEO_VOICE_CHANNELS.includes(id);
const parseIds = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const tfLabel = x => ({last_week:'Last Week',this_week:'This Week',this_month:'This Month',last_month:'Last Month',all_time:'All Time'}[x] || x);

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label || 'Operation timed out')), ms); })
  ]);
}
async function dbQuery(sql, params = []) {
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) throw new Error('Database configuration is incomplete.');
  const result = await withTimeout(pool.execute(sql, params), DB_TIMEOUT_MS, 'Database operation timed out.');
  dbOnline = true;
  return result[0];
}
async function dbTry(sql, params = []) {
  try { return await dbQuery(sql, params); }
  catch (e) { dbOnline = false; throw e; }
}
async function dbReply(interaction) {
  if (dbOnline) return true;
  await safeEdit(interaction, { content: 'The database is currently unavailable. The Discord bot is online, but this feature requires the MySQL database connection.' });
  return false;
}

function guildSettingKey(guildId, key) { return `guild:${guildId}:${key}`; }
async function getSetting(key, fallback = null, guildId = REPORT_GUILD_ID) {
  try {
    const rows = await dbTry('SELECT settingValue FROM bot_settings WHERE settingKey=? LIMIT 1', [guildSettingKey(guildId, key)]);
    return rows[0]?.settingValue ?? fallback;
  } catch { return fallback; }
}
async function setSetting(key, value, guildId = REPORT_GUILD_ID) {
  await dbTry('INSERT INTO bot_settings(settingKey,settingValue) VALUES(?,?) ON DUPLICATE KEY UPDATE settingValue=VALUES(settingValue)', [guildSettingKey(guildId,key), String(value)]);
}
async function getJson(key, fallback, guildId = REPORT_GUILD_ID) {
  const raw = await getSetting(key, JSON.stringify(fallback), guildId);
  try { return JSON.parse(raw); } catch { return fallback; }
}
async function setJson(key, value, guildId = REPORT_GUILD_ID) { await setSetting(key, JSON.stringify(value), guildId); }

async function ensureSchema() {
  const file = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(file)) return;
  const sql = fs.readFileSync(file, 'utf8');
  const statements = sql.split(/;\s*(?=\n|$)/).map(s => s.trim()).filter(Boolean);
  for (const s of statements) await dbTry(s);
  dbOnline = true;
}

async function isAdmin(member) {
  if (!member) return false;
  if (parseIds(process.env.BOT_ADMINS).includes(member.id)) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  const ids = await getJson('adminRoles', [], member.guild?.id || REPORT_GUILD_ID);
  return ids.some(id => member.roles.cache.has(id));
}
async function permissionAllowed(member, command) {
  if (await isAdmin(member)) return true;
  const ids = await getJson(`cmdperm:${command}`, [], member.guild.id);
  if (!ids.length) return true;
  return ids.some(id => member.roles.cache.has(id));
}
async function reportStaffAllowed(member) {
  if (await isAdmin(member)) return true;
  const ids = await getJson('reportStaffRoles', [], member.guild.id);
  return ids.some(id => member.roles.cache.has(id));
}
async function ridealongAllowed(member) {
  if (await isAdmin(member)) return true;
  const ids = await getJson('ridealongRoles', [], member.guild.id);
  return ids.some(id => member.roles.cache.has(id));
}

async function safeEdit(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    return await interaction.reply(payload);
  } catch (e) {
    console.error('Reply/edit error:', e.message);
    return null;
  }
}
async function safeDefer(interaction, flags = MessageFlags.Ephemeral) {
  if (interaction.deferred || interaction.replied) return true;
  try { await interaction.deferReply({ flags }); return true; }
  catch (e) { console.error('Defer error:', e.message); return false; }
}

function timeWindow(kind, ts = now()) {
  const cur = dt(ts);
  const week = (() => {
    const daysSinceFriday = (cur.weekday + 2) % 7;
    const start = cur.minus({ days: daysSinceFriday }).startOf('day');
    const end = start.plus({ days: 7 });
    return { start:Math.floor(start.toSeconds()), end:Math.floor(end.toSeconds()), startLabel:start.toFormat('LLL dd'), endLabel:end.minus({seconds:1}).toFormat('LLL dd') };
  })();
  if (kind === 'this_week') return week;
  if (kind === 'last_week') { const end=dt(week.start); const start=end.minus({days:7}); return {start:Math.floor(start.toSeconds()),end:Math.floor(end.toSeconds()),startLabel:start.toFormat('LLL dd'),endLabel:end.minus({seconds:1}).toFormat('LLL dd')}; }
  if (kind === 'this_month') { const start=cur.startOf('month'); const end=start.plus({months:1}); return {start:Math.floor(start.toSeconds()),end:Math.floor(end.toSeconds()),startLabel:start.toFormat('LLL dd'),endLabel:end.minus({seconds:1}).toFormat('LLL dd')}; }
  if (kind === 'last_month') { const end=cur.startOf('month'); const start=end.minus({months:1}); return {start:Math.floor(start.toSeconds()),end:Math.floor(end.toSeconds()),startLabel:start.toFormat('LLL dd'),endLabel:end.minus({seconds:1}).toFormat('LLL dd')}; }
  return {start:0,end:now()+1,startLabel:'All Time',endLabel:''};
}
function weekWindow(ts = now()) { return timeWindow('this_week', ts); }

async function dutyTotal(discordId, department, window) {
  const clauses = ['inTime IS NOT NULL','inTime < ?','COALESCE(outTime,UNIX_TIMESTAMP()) > ?'];
  const params = [window.end, window.start];
  if (discordId) { clauses.splice(1, 0, 'discordId=?'); params.unshift(discordId); }
  if (department) { const idx = discordId ? 1 : 0; clauses.splice(idx, 0, 'department=?'); params.splice(idx, 0, department); }
  const rows = await dbTry(`SELECT inTime,COALESCE(outTime,UNIX_TIMESTAMP()) outTime FROM duty_hours WHERE ${clauses.join(' AND ')}`, params);
  return rows.reduce((sum,r) => sum + Math.max(0, Math.min(Number(r.outTime),window.end)-Math.max(Number(r.inTime),window.start)), 0);
}

function onDutyEmbed(user, department, inTime) {
  return new EmbedBuilder().setColor(BLUE).setTitle('On Duty')
    .setDescription(`Thanks for your service, ${user.globalName || user.username}.`)
    .addFields(
      {name:'Clock In', value:formatDateTime(inTime), inline:true},
      {name:'Department', value:`${department} — ${deptName(department)}`, inline:true}
    ).setFooter({text:`WCRP Department Utilities • ${formatShort(inTime)}`});
}
function offDutyEmbed(user, row, stats, weekly) {
  return new EmbedBuilder().setColor(BLUE).setTitle('Off Duty')
    .setDescription(`Thanks for your service, ${user.globalName || user.username}.`)
    .addFields(
      {name:'Reason',value:row.reason || 'Clock Out',inline:false},
      {name:'Clock Out',value:formatDateTime(row.outTime),inline:true},
      {name:'Session',value:formatDuration(stats.session),inline:true},
      {name:'This Week (Fri-Thu)',value:hoursText(weekly.total),inline:true},
      {name:'Week',value:`${weekly.startLabel} - ${weekly.endLabel}`,inline:true},
      {name:'Department',value:`${row.department} — ${deptName(row.department)}`,inline:true},
      {name:'In Voice',value:formatDuration(stats.voice),inline:true},
      {name:'Out of Voice',value:formatDuration(stats.outVoice),inline:true},
      {name:'Voice Coverage',value:`${stats.coverage.toFixed(0)}%`,inline:true}
    ).setFooter({text:`WCRP Department Utilities • ${formatShort(row.outTime)}`});
}
async function dmUser(userId, embed) {
  const user = await client.users.fetch(String(userId)).catch(() => null);
  if (user) await user.send({embeds:[embed]}).catch(() => {});
}

async function openVoiceSegment(discordId, channelId, timestamp) {
  const duty = activeDuty.get(String(discordId));
  if (!duty || !dbOnline) return;
  const old = currentVoice.get(String(discordId));
  if (old && old.channelId === (channelId || null)) return;
  if (old) await dbTry('UPDATE duty_voice_segments SET outTime=? WHERE id=? AND outTime IS NULL',[timestamp,old.id]).catch(()=>{});
  const result = await dbTry('INSERT INTO duty_voice_segments(dutyId,discordId,channelId,inTime,outTime,isLeoVoice) VALUES(?,?,?,?,NULL,?)',[duty.id,String(discordId),channelId||null,timestamp,isLeoVoice(channelId)?1:0]);
  currentVoice.set(String(discordId), {id:result.insertId,channelId:channelId||null});
}
async function closeVoiceSegment(discordId, timestamp) {
  const old = currentVoice.get(String(discordId));
  if (!old || !dbOnline) return;
  await dbTry('UPDATE duty_voice_segments SET outTime=? WHERE id=? AND outTime IS NULL',[timestamp,old.id]).catch(()=>{});
  currentVoice.delete(String(discordId));
}
async function voiceStats(dutyId, inTime, outTime) {
  const rows = await dbTry('SELECT inTime,COALESCE(outTime,?) outTime,isLeoVoice FROM duty_voice_segments WHERE dutyId=? AND inTime < ? AND COALESCE(outTime,?) > ?',[outTime,dutyId,outTime,outTime,inTime]);
  let voice = 0;
  for (const r of rows) if (Number(r.isLeoVoice)) voice += Math.max(0, Math.min(Number(r.outTime),outTime)-Math.max(Number(r.inTime),inTime));
  const session = Math.max(0, outTime-inTime);
  return {session, voice, outVoice:Math.max(0,session-voice), coverage:session ? voice/session*100 : 0};
}
async function startDuty(row) {
  const id = String(row.discordId);
  if (activeDuty.has(id)) return;
  activeDuty.set(id,{id:row.id,discordId:id,inTime:Number(row.inTime),department:String(row.department||'').toUpperCase()});
  const guild = client.guilds.cache.get(REPORT_GUILD_ID);
  const member = guild ? await guild.members.fetch(id).catch(()=>null) : null;
  await openVoiceSegment(id, member?.voice?.channelId || null, Number(row.inTime)).catch(()=>{});
  await dmUser(id, onDutyEmbed(await client.users.fetch(id).catch(()=>({username:'Member'})), String(row.department||'').toUpperCase(), Number(row.inTime)));
}
async function finishDuty(row) {
  const id=String(row.discordId); const duty=activeDuty.get(id);
  const inTime=duty?.inTime||Number(row.inTime); const dutyId=duty?.id||row.id; const outTime=Number(row.outTime||now());
  await closeVoiceSegment(id,outTime);
  const stats=await voiceStats(dutyId,inTime,outTime).catch(()=>({session:Math.max(0,outTime-inTime),voice:0,outVoice:Math.max(0,outTime-inTime),coverage:0}));
  const w=weekWindow(outTime); const weekly={total:await dutyTotal(id,String(row.department),w),startLabel:w.startLabel,endLabel:w.endLabel};
  await dmUser(id, offDutyEmbed(await client.users.fetch(id).catch(()=>({username:'Member'})), {...row,outTime,inTime}, stats, weekly));
  activeDuty.delete(id);
}
async function pollDuty() {
  if (!dbOnline) return;
  try {
    const active = await dbTry('SELECT * FROM duty_hours WHERE outTime IS NULL AND discordId IS NOT NULL ORDER BY id DESC');
    const seen=new Set();
    for(const row of active){const id=String(row.discordId);if(seen.has(id))continue;seen.add(id);await startDuty(row);}
    const completed=await dbTry('SELECT * FROM duty_hours WHERE outTime IS NOT NULL AND outTime>=? ORDER BY outTime ASC',[now()-180]);
    for(const row of completed){const id=String(row.discordId);if(activeDuty.has(id)&&activeDuty.get(id).id===row.id)await finishDuty(row);}
    for(const [id] of activeDuty){if(!seen.has(id)){await closeVoiceSegment(id,now());activeDuty.delete(id);}}
  } catch(e) { dbOnline=false; console.error('Duty poll error:',e.message); }
}
client.on('voiceStateUpdate', async (oldState,newState) => {
  const id=String(newState.id||oldState.id); if(!activeDuty.has(id)||!dbOnline)return;
  await openVoiceSegment(id,newState.channelId||null,now()).catch(e=>console.error('Voice tracking error:',e.message));
});

function base(name,desc){return new SlashCommandBuilder().setName(name).setDescription(desc);}
const commands = [
  base('officer-report-panel','Post the officer report panel'),base('anonreport','Create or convert an anonymous report'),base('addofficer','Set the officer being reported'),base('reportadd','Create a report ticket as staff'),base('report-config','Configure department report roles and ticket category'),base('report-staff','Configure report handling roles'),base('log-config','Configure report, transcript and ride-along logs'),base('ridealong-permissions','Configure roles allowed to log ride-alongs'),
  base('ridealong','Log a ride-along or configure ride-along roles'),base('permissions','Configure roles allowed to use commands'),base('admin-roles','Configure bot administrator roles'),base('rename','Rename the current report ticket'),base('close','Close the current report ticket'),base('delete','Transcript and delete the current report ticket'),
  base('hours','View duty hours'),base('allhours','View officer hours in a department'),base('totalhours','View total department hours'),base('weeklydeptours','View department hours for a timeframe'),base('deptofhours','Rank officers by hours'),base('tophours','View the highest hour totals'),base('leaderboard','View a department leaderboard'),base('evaluate','Evaluate weekly hour requirements'),base('inactive_officers','Find inactive officers'),base('promotions','Show promotion-eligible officers'),base('leomulti','Apply a temporary hour multiplier'),base('add_org','Add an organisation'),base('add_org_hours','Add adjusted organisation hours'),base('rename_org','Rename an organisation'),base('dept_officers','View department officers by activity')
];
const choiceDepartments=DEPARTMENTS.map(x=>({name:x,value:x}));
const tfChoices=[{name:'Last Week',value:'last_week'},{name:'This Week',value:'this_week'},{name:'This Month',value:'this_month'},{name:'Last Month',value:'last_month'},{name:'All Time',value:'all_time'}];
const depOpt=(name='department',required=true)=>(o)=>o.setName(name).setDescription('Department').setRequired(required).addChoices(...choiceDepartments);
function reportFields(cmd){return cmd.addStringOption(depOpt('department',true)).addStringOption(o=>o.setName('officer').setDescription('Officer being reported').setRequired(false)).addStringOption(o=>o.setName('date').setDescription('Date of incident').setRequired(false)).addStringOption(o=>o.setName('game_id').setDescription('In-game ID').setRequired(false)).addStringOption(o=>o.setName('clip').setDescription('Clip or evidence URL').setRequired(false)).addStringOption(o=>o.setName('description').setDescription('What happened').setRequired(false)).addStringOption(o=>o.setName('context').setDescription('Additional context').setRequired(false));}
reportFields(commands.find(c=>c.name==='anonreport'));
commands.find(c=>c.name==='reportadd').addStringOption(depOpt('department',true)).addUserOption(o=>o.setName('officer').setDescription('Officer being reported').setRequired(false)).addStringOption(o=>o.setName('date').setDescription('Date of incident').setRequired(false)).addStringOption(o=>o.setName('game_id').setDescription('In-game ID').setRequired(false)).addStringOption(o=>o.setName('clip').setDescription('Clip or evidence URL').setRequired(false)).addStringOption(o=>o.setName('description').setDescription('What happened').setRequired(false)).addStringOption(o=>o.setName('context').setDescription('Additional context').setRequired(false));
commands.find(c=>c.name==='addofficer').addUserOption(o=>o.setName('user').setDescription('Discord user').setRequired(false)).addStringOption(o=>o.setName('user_id').setDescription('Exact Discord user ID').setRequired(false));
commands.find(c=>c.name==='report-config').addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Set',value:'set'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addStringOption(depOpt('department',false)).addRoleOption(o=>o.setName('role').setDescription('Department report role').setRequired(false)).addChannelOption(o=>o.setName('category').setDescription('Report ticket category').setRequired(false).addChannelTypes(ChannelType.GuildCategory));
commands.find(c=>c.name==='report-staff').addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addRoleOption(o=>o.setName('role').setDescription('Report handling role').setRequired(false));
commands.find(c=>c.name==='ridealong-permissions').addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addRoleOption(o=>o.setName('role').setDescription('Role allowed to log ride-alongs').setRequired(false));
commands.find(c=>c.name==='log-config').addStringOption(o=>o.setName('type').setDescription('Log type').setRequired(true).addChoices({name:'Report Logs',value:'report_log'},{name:'Transcript Logs',value:'transcript_log'},{name:'Ride-Along Logs',value:'ridealong_log'})).addChannelOption(o=>o.setName('channel').setDescription('Log channel').setRequired(false).addChannelTypes(ChannelType.GuildText));
commands.find(c=>c.name==='ridealong').addSubcommand(s=>s.setName('log').setDescription('Log a ride-along').addUserOption(o=>o.setName('player').setDescription('Trainee').setRequired(true)).addStringOption(depOpt('department',true)).addStringOption(o=>o.setName('result').setDescription('Result').setRequired(true).addChoices({name:'Passed',value:'Passed'},{name:'Failed',value:'Failed'})).addStringOption(o=>o.setName('notes').setDescription('Notes').setRequired(false))).addSubcommand(s=>s.setName('role').setDescription('Configure ride-along and trainee roles').addRoleOption(o=>o.setName('ridealong_role').setDescription('Ride-along role').setRequired(true)).addRoleOption(o=>o.setName('trainee_role').setDescription('Trainee role to remove').setRequired(true)));
commands.find(c=>c.name==='permissions').addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addStringOption(o=>o.setName('command').setDescription('Command name').setRequired(true).setAutocomplete(true));
commands.find(c=>c.name==='permissions').addRoleOption(o=>o.setName('role').setDescription('Allowed role').setRequired(false));
commands.find(c=>c.name==='admin-roles').addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addRoleOption(o=>o.setName('role').setDescription('Administrator role').setRequired(false));
commands.find(c=>c.name==='rename').setDescription('Rename the current report ticket to user-handling');
const hoursCmd=commands.find(c=>c.name==='hours');hoursCmd.addStringOption(depOpt('department',true)).addStringOption(o=>o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...tfChoices)).addUserOption(o=>o.setName('user').setDescription('Exact person').setRequired(false));
for(const n of ['allhours','totalhours','weeklydeptours','deptofhours','leaderboard','evaluate','inactive_officers','promotions','dept_officers'])commands.find(c=>c.name===n).addStringOption(depOpt('department',true));
for(const n of ['allhours','totalhours','weeklydeptours','deptofhours','leaderboard'])commands.find(c=>c.name===n).addStringOption(o=>o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...tfChoices));
commands.find(c=>c.name==='evaluate').addUserOption(o=>o.setName('user').setDescription('Exact person').setRequired(false));
for(const n of ['inactive_officers','dept_officers'])commands.find(c=>c.name===n).addIntegerOption(o=>o.setName('weeks_back').setDescription('Weeks without duty').setRequired(false).addChoices({name:'2 weeks',value:2},{name:'4 weeks',value:4}));
commands.find(c=>c.name==='promotions').addIntegerOption(o=>o.setName('min_hours').setDescription('Minimum weekly hours').setRequired(false).setMinValue(0));
commands.find(c=>c.name==='leomulti').addIntegerOption(o=>o.setName('duration_minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(10080)).addNumberOption(o=>o.setName('multiplier').setDescription('Multiplier').setRequired(false).setMinValue(1).setMaxValue(5));
commands.find(c=>c.name==='add_org').addStringOption(o=>o.setName('code').setDescription('Organisation code').setRequired(true)).addStringOption(o=>o.setName('name').setDescription('Organisation name').setRequired(true));
commands.find(c=>c.name==='add_org_hours').addStringOption(o=>o.setName('code').setDescription('Organisation code').setRequired(true)).addNumberOption(o=>o.setName('hours').setDescription('Hours').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false));
commands.find(c=>c.name==='rename_org').addStringOption(o=>o.setName('old_code').setDescription('Current code').setRequired(true)).addStringOption(o=>o.setName('new_code').setDescription('New code').setRequired(true)).addStringOption(o=>o.setName('name').setDescription('Organisation name').setRequired(true));
for(const c of commands)c.setDMPermission(false);

function normalizeOptions(obj){
  if(!obj||typeof obj!=='object')return obj;
  if(Array.isArray(obj.options)){
    obj.options=obj.options.map(normalizeOptions);
    const required=obj.options.filter(x=>x.type!==1&&x.type!==2&&x.required);
    const optional=obj.options.filter(x=>x.type!==1&&x.type!==2&&!x.required);
    const sub=obj.options.filter(x=>x.type===1||x.type===2);
    obj.options=[...sub,...required,...optional];
  }
  return obj;
}
function validateCommands(body){
  for(const cmd of body){
    const walk=(options,pathName)=>{let optionalSeen=false;for(const o of options||[]){if(o.type===1||o.type===2){walk(o.options,`${pathName}.${o.name}`);continue;}if(o.required&&optionalSeen)throw new Error(`Invalid required option order at ${pathName}.${o.name}`);if(!o.required)optionalSeen=true;}};
    walk(cmd.options,`/${cmd.name}`);
  }
}
async function registerCommands(){
  const body=commands.map(c=>normalizeOptions(c.toJSON()));validateCommands(body);
  const rest=new REST({version:'10'}).setToken(TOKEN);
  const result=await rest.put(Routes.applicationCommands(CLIENT_ID),{body});
  console.log(`GLOBAL COMMANDS REGISTERED: ${Array.isArray(result)?result.length:body.length}`);
}

function panelEmbed(){return new EmbedBuilder().setColor(BLUE).setTitle('Department Reports').setDescription('Select the type of report you want to submit. A private report channel will be created automatically.').addFields({name:'Officer Report',value:'Report an officer or department member.',inline:true},{name:'Higher Up Report',value:'Report a supervisor, command member or senior leadership.',inline:true}).setFooter({text:'WCRP Department Utilities'});}
function panelRow(){return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('report_panel_type').setPlaceholder('Select report type').addOptions(new StringSelectMenuOptionBuilder().setLabel('Officer Report').setDescription('Report an officer').setValue('officer'),new StringSelectMenuOptionBuilder().setLabel('Higher Up Report').setDescription('Report higher-up staff').setValue('higher')));}
function reportModal(type){return new ModalBuilder().setCustomId(`report_form:${type}`).setTitle(type==='higher'?'Higher Up Report':'Officer Report').addComponents(
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('department').setLabel('Department').setPlaceholder('USM / SASP / BCSO / LSPD').setStyle(TextInputStyle.Short).setRequired(true)),
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('officer').setLabel('Officer Being Reported').setPlaceholder('Discord ID (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Date of Incident').setPlaceholder('Date and time').setStyle(TextInputStyle.Short).setRequired(false)),
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('clip').setLabel('Clips / Evidence').setPlaceholder('Clip URL or evidence link').setStyle(TextInputStyle.Paragraph).setRequired(false)),
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Context / Description').setPlaceholder('Explain what happened and add any context.').setStyle(TextInputStyle.Paragraph).setRequired(false))
);}
function reportEmbed(report){return new EmbedBuilder().setColor(BLUE).setTitle(report.anonymous?'Anonymous Report':report.ticketType==='higher'?'Higher Up Report':'Officer Report').addFields(
  {name:'Department',value:`${report.department} — ${deptName(report.department)}`,inline:true},
  {name:'Date of Incident',value:report.dateOfIncident||'Not provided',inline:true},
  {name:'In-Game ID',value:report.gameId||'Not provided',inline:true},
  {name:'Officer Being Reported',value:report.reportedUserId?`<@${report.reportedUserId}> (${report.reportedUserId})`:'Not provided',inline:false},
  {name:'Clips / Evidence',value:report.clip||'Not provided',inline:false},
  {name:'Description',value:report.description||'Not provided',inline:false},
  {name:'Additional Context',value:report.context||'Not provided',inline:false}
).setFooter({text:`WCRP Department Utilities • ${formatShort(report.createdAt||now())}`});}
function ticketButtons(closed=false){if(closed)return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_transcript').setLabel('Transcript').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('ticket_delete').setLabel('Delete').setStyle(ButtonStyle.Danger));return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Secondary));}
async function reportRoles(guildId,department){return getJson(`reportRoles:${department}`,[],guildId);}
async function reportCategory(guildId){return getSetting('reportCategoryId',null,guildId);}
async function fetchReport(channelId){const rows=await dbTry('SELECT * FROM reports WHERE channelId=? LIMIT 1',[channelId]);return rows[0]||null;}
async function applyTicketPermissions(channel,report){
  const overwrites=new Map(); overwrites.set(channel.guild.roles.everyone.id,{ViewChannel:false});
  if(report.reporterId)overwrites.set(report.reporterId,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
  if(report.reportedUserId)overwrites.set(report.reportedUserId,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
  const staff=await getJson('reportStaffRoles',[],channel.guild.id); for(const roleId of staff)overwrites.set(roleId,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
  if(client.user)overwrites.set(client.user.id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true,ManageChannels:true,ManageMessages:true});
  for(const [id,perms] of overwrites)await channel.permissionOverwrites.edit(id,perms).catch(()=>{});
}
async function createReportTicket({interaction,type,department,anonymous,reporterId,reportedUserId,dateOfIncident,gameId,clip,description,context}){
  const categoryId=await reportCategory(interaction.guild.id); const roles=await reportRoles(interaction.guild.id,department);
  const channel=await interaction.guild.channels.create({name:`${anonymous?'anon': 'report'}-${department.toLowerCase()}-${clean(interaction.user.username)}`.slice(0,95),type:ChannelType.GuildText,parent:categoryId||undefined,reason:'WCRP department report'});
  const report={channelId:channel.id,ticketType:type,department,reporterId:anonymous?null:reporterId||null,reportedUserId:reportedUserId||null,dateOfIncident:dateOfIncident||null,gameId:gameId||null,clip:clip||null,description:description||null,context:context||null,anonymous:anonymous?1:0,createdAt:now()};
  await dbTry('INSERT INTO reports(channelId,ticketType,department,reporterId,reportedUserId,dateOfIncident,gameId,clip,description,context,anonymous,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[report.channelId,report.ticketType,report.department,report.reporterId,report.reportedUserId,report.dateOfIncident,report.gameId,report.clip,report.description,report.context,report.anonymous,report.createdAt]);
  await applyTicketPermissions(channel,report);
  await channel.send({content:roles.map(id=>`<@&${id}>`).join(' ')||undefined,embeds:[reportEmbed(report)],components:[ticketButtons(false)]});
  return channel;
}
async function clearChannel(channel){for(let i=0;i<20;i++){const msgs=await channel.messages.fetch({limit:100}).catch(()=>null);if(!msgs?.size)break;for(const m of msgs.values())await m.delete().catch(()=>{});if(msgs.size<100)break;}}
async function transcript(channel){const all=[];let before;for(let i=0;i<20;i++){const msgs=await channel.messages.fetch({limit:100,before}).catch(()=>null);if(!msgs?.size)break;all.push(...msgs.values());before=msgs.last().id;if(msgs.size<100)break;}all.sort((a,b)=>a.createdTimestamp-b.createdTimestamp);return all.map(m=>{const attachments=[...m.attachments.values()].map(a=>a.url);return `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content||'[embed / attachment]'}${attachments.length?` | Attachments: ${attachments.join(', ')}`:''}`;}).join('\n');}
async function sendLog(guild,key,payload){const id=await getSetting(key,null,guild.id);const ch=id?guild.channels.cache.get(id):null;if(ch?.isTextBased())await ch.send(payload).catch(()=>{});}

async function handleCommand(interaction){
  const name=interaction.commandName;
  const ack=await safeDefer(interaction,MessageFlags.Ephemeral); if(!ack)return;
  try{
    if(REPORT_COMMANDS.has(name)&&interaction.guildId!==REPORT_GUILD_ID)return safeEdit(interaction,'This command is only available in the configured WCRP reports and ride-along server.');
    if(ADMIN_COMMANDS.has(name)&&!(await isAdmin(interaction.member)))return safeEdit(interaction,'Administrator permission required.');
    if(!(await permissionAllowed(interaction.member,name)))return safeEdit(interaction,'You do not have permission to use this command.');

    if(name==='officer-report-panel'){await interaction.channel.send({embeds:[panelEmbed()],components:[panelRow()]});return safeEdit(interaction,'Report panel posted.');}
    if(name==='admin-roles'){
      const action=interaction.options.getString('action');const role=interaction.options.getRole('role');let ids=await getJson('adminRoles',[],interaction.guild.id);if(action==='view')return safeEdit(interaction,ids.length?`Administrator roles: ${ids.map(x=>`<@&${x}>`).join(', ')}`:'No administrator roles configured.');if(action==='clear')ids=[];if(role&&action==='add')ids=[...new Set([...ids,role.id])];if(role&&action==='remove')ids=ids.filter(x=>x!==role.id);await setJson('adminRoles',ids,interaction.guild.id);return safeEdit(interaction,ids.length?`Administrator roles: ${ids.map(x=>`<@&${x}>`).join(', ')}`:'No administrator roles configured.');
    }
    if(name==='permissions'){
      const action=interaction.options.getString('action'),command=String(interaction.options.getString('command')||'').toLowerCase().replace(/^\//,''),role=interaction.options.getRole('role');let ids=await getJson(`cmdperm:${command}`,[],interaction.guild.id);if(action==='view')return safeEdit(interaction,`${command}: ${ids.length?ids.map(x=>`<@&${x}>`).join(', '):'Everyone'}`);if(action==='clear')ids=[];if(role&&action==='add')ids=[...new Set([...ids,role.id])];if(role&&action==='remove')ids=ids.filter(x=>x!==role.id);await setJson(`cmdperm:${command}`,ids,interaction.guild.id);return safeEdit(interaction,`${command}: ${ids.length?ids.map(x=>`<@&${x}>`).join(', '):'Everyone'}`);
    }
    if(name==='report-staff'||name==='ridealong-permissions'){
      const action=interaction.options.getString('action'),role=interaction.options.getRole('role'),key=name==='report-staff'?'reportStaffRoles':'ridealongRoles';let ids=await getJson(key,[],interaction.guild.id);if(action==='view')return safeEdit(interaction,`${name==='report-staff'?'Report staff':'Ride-along'} roles: ${ids.length?ids.map(x=>`<@&${x}>`).join(', '):'None'}`);if(action==='clear')ids=[];if(role&&action==='add')ids=[...new Set([...ids,role.id])];if(role&&action==='remove')ids=ids.filter(x=>x!==role.id);await setJson(key,ids,interaction.guild.id);return safeEdit(interaction,`${name==='report-staff'?'Report staff':'Ride-along'} roles: ${ids.length?ids.map(x=>`<@&${x}>`).join(', '):'None'}`);
    }
    if(name==='report-config'){
      const action=interaction.options.getString('action'),d=dept(interaction.options.getString('department')),role=interaction.options.getRole('role'),cat=interaction.options.getChannel('category');
      if(action==='view'){const lines=[];for(const x of DEPARTMENTS){const ids=await reportRoles(interaction.guild.id,x);lines.push(`${x}: ${ids.length?ids.map(id=>`<@&${id}>`).join(', '):'Not configured'}`);}const c=await reportCategory(interaction.guild.id);lines.push(`Category: ${c?`<#${c}>`:'Not configured'}`);return safeEdit(interaction,lines.join('\n'));}
      if(!d)return safeEdit(interaction,'Select a department.');
      if(action==='set'&&role)await setJson(`reportRoles:${d}`,[role.id],interaction.guild.id);if(action==='clear')await setJson(`reportRoles:${d}`,[],interaction.guild.id);if(cat)await setSetting('reportCategoryId',cat.id,interaction.guild.id);return safeEdit(interaction,`Report configuration updated for ${d}.`);
    }
    if(name==='log-config'){
      const type=interaction.options.getString('type'),ch=interaction.options.getChannel('channel');const key=type==='report_log'?'reportLogChannelId':type==='transcript_log'?'transcriptLogChannelId':'ridealongLogChannelId';if(ch)await setSetting(key,ch.id,interaction.guild.id);const v=await getSetting(key,null,interaction.guild.id);return safeEdit(interaction,`${type}: ${v?`<#${v}>`:'Not configured'}`);
    }
    if(name==='ridealong'){
      const sub=interaction.options.getSubcommand();
      if(sub==='role'){if(!(await isAdmin(interaction.member)))return safeEdit(interaction,'Administrator permission required.');const ride=interaction.options.getRole('ridealong_role'),trainee=interaction.options.getRole('trainee_role');await setSetting('ridealongResultRoleId',ride.id,interaction.guild.id);await setSetting('traineeRoleId',trainee.id,interaction.guild.id);return safeEdit(interaction,`Ride-along role: <@&${ride.id}>\nTrainee role removed on log: <@&${trainee.id}>`);}
      if(!(await ridealongAllowed(interaction.member)))return safeEdit(interaction,'You do not have permission to log ride-alongs.');
      const player=interaction.options.getUser('player'),d=dept(interaction.options.getString('department')),result=interaction.options.getString('result'),notes=interaction.options.getString('notes');if(!d)return safeEdit(interaction,'Select a valid department.');
      const guildMember=await interaction.guild.members.fetch(player.id).catch(()=>null);const trainee=await getSetting('traineeRoleId',null,interaction.guild.id);const rideRole=await getSetting('ridealongResultRoleId',null,interaction.guild.id);
      if(guildMember&&trainee&&guildMember.roles.cache.has(trainee))await guildMember.roles.remove(trainee,'Ride-along logged').catch(()=>{});if(guildMember&&result==='Passed'&&rideRole)await guildMember.roles.add(rideRole,'Ride-along passed').catch(()=>{});
      if(await dbReply(interaction))await dbTry('INSERT INTO ridealongs(discordId,department,ridealongRoleId,result,notes,createdBy,createdAt) VALUES(?,?,?,?,?,?,?)',[player.id,d,rideRole,result,notes||null,interaction.user.id,now()]);
      await sendLog(interaction.guild,'ridealongLogChannelId',{embeds:[new EmbedBuilder().setColor(BLUE).setTitle('Ride-Along Log').addFields({name:'Officer',value:`<@${player.id}>`,inline:true},{name:'Department',value:d,inline:true},{name:'Result',value:result,inline:true},{name:'Notes',value:notes||'None',inline:false},{name:'Logged By',value:`<@${interaction.user.id}>`,inline:true}).setFooter({text:`WCRP Department Utilities • ${formatShort(now())}`})]});
      return safeEdit(interaction,`Ride-along logged for <@${player.id}>.`);
    }
    if(name==='addofficer'){
      if(!(await reportStaffAllowed(interaction.member)))return safeEdit(interaction,'Reports team permission required.');
      const user=interaction.options.getUser('user');const userId=interaction.options.getString('user_id')?.trim();const target=user?.id||userId;if(!/^\d{17,20}$/.test(String(target||'')))return safeEdit(interaction,'Provide a Discord user or exact Discord user ID.');
      const report=await fetchReport(interaction.channel.id);if(!report)return safeEdit(interaction,'This is not a report ticket.');await dbTry('UPDATE reports SET reportedUserId=? WHERE channelId=?',[target,interaction.channel.id]);report.reportedUserId=target;await applyTicketPermissions(interaction.channel,report);await updateReportMessage(report);return safeEdit(interaction,`Officer being reported set to <@${target}>.`);
    }
    if(name==='reportadd'){
      if(!(await reportStaffAllowed(interaction.member)))return safeEdit(interaction,'Reports team permission required.');const d=dept(interaction.options.getString('department'));if(!d)return safeEdit(interaction,'Select a valid department.');
      const ch=await createReportTicket({interaction,type:'officer',department:d,anonymous:false,reporterId:interaction.user.id,reportedUserId:interaction.options.getUser('officer')?.id,dateOfIncident:interaction.options.getString('date'),gameId:interaction.options.getString('game_id'),clip:interaction.options.getString('clip'),description:interaction.options.getString('description'),context:interaction.options.getString('context')});return safeEdit(interaction,`Report created: ${ch}`);
    }
    if(name==='anonreport'){
      const d=dept(interaction.options.getString('department'));if(!d)return safeEdit(interaction,'Select a valid department.');
      const existing=await fetchReport(interaction.channel.id);const selected=interaction.options.getString('officer');let reportedUserId=/^\d{17,20}$/.test(selected||'')?selected:null;
      reportedUserId=reportedUserId||existing?.reportedUserId||null;if(!reportedUserId){return safeEdit(interaction,'Select the officer Discord ID in the command or use /addofficer first.');}
      const patch={department:d,reportedUserId,dateOfIncident:interaction.options.getString('date')||existing?.dateOfIncident||null,gameId:interaction.options.getString('game_id')||existing?.gameId||null,clip:interaction.options.getString('clip')||existing?.clip||null,description:interaction.options.getString('description')||existing?.description||null,context:interaction.options.getString('context')||existing?.context||null,anonymous:1};
      if(!existing){const ch=await createReportTicket({interaction,type:'officer',department:d,anonymous:true,reporterId:null,...patch});return safeEdit(interaction,`Anonymous report created: ${ch}`);}
      await dbTry('UPDATE reports SET department=?,reportedUserId=?,dateOfIncident=?,gameId=?,clip=?,description=?,context=?,anonymous=1 WHERE channelId=?',[patch.department,patch.reportedUserId,patch.dateOfIncident,patch.gameId,patch.clip,patch.description,patch.context,interaction.channel.id]);
      const report={...existing,...patch,reporterId:null};
      await interaction.channel.permissionOverwrites.delete(existing.reporterId).catch(()=>{});
      await applyTicketPermissions(interaction.channel,report);
      await clearChannel(interaction.channel);
      await interaction.channel.setName(`anon-${d.toLowerCase()}`).catch(()=>{});
      const roles=await reportRoles(interaction.guild.id,d);
      await interaction.channel.send({content:roles.length?roles.map(id=>`<@&${id}>`).join(' '):undefined,embeds:[reportEmbed(report)],components:[ticketButtons(false)]});
      return safeEdit(interaction,'Anonymous report rebuilt. The reporter has been removed from the ticket.');
    }
    if(name==='rename'){
      const report=await fetchReport(interaction.channel.id);if(!report)return safeEdit(interaction,'This is not a report ticket.');const owner=report.reporterId||report.reportedUserId||interaction.user.id;const user=await client.users.fetch(owner).catch(()=>null);const newName=`${clean(user?.username||interaction.user.username)}-handling`;await interaction.channel.setName(newName);return safeEdit(interaction,`Channel renamed to ${newName}.`);
    }
    if(name==='close'){
      if(!(await reportStaffAllowed(interaction.member)))return safeEdit(interaction,'Reports team permission required.');const report=await fetchReport(interaction.channel.id);if(!report)return safeEdit(interaction,'This is not a report ticket.');await dbTry('UPDATE reports SET closedAt=? WHERE channelId=?',[now(),interaction.channel.id]);if(report.reporterId)await interaction.channel.permissionOverwrites.edit(report.reporterId,{ViewChannel:false,SendMessages:false}).catch(()=>{});return safeEdit(interaction,{content:'Ticket closed.',components:[ticketButtons(true)]});
    }
    if(name==='delete'){
      if(!(await reportStaffAllowed(interaction.member)))return safeEdit(interaction,'Reports team permission required.');const report=await fetchReport(interaction.channel.id);if(!report)return safeEdit(interaction,'This is not a report ticket.');const text=await transcript(interaction.channel);await sendLog(interaction.guild,'transcriptLogChannelId',{content:`Transcript for #${interaction.channel.name}`,files:[{attachment:Buffer.from(text||'No messages.'),name:`${interaction.channel.name}-transcript.txt`}]});await safeEdit(interaction,'Transcript saved. Deleting ticket...');setTimeout(()=>interaction.channel.delete('Report ticket deleted').catch(()=>{}),800);return;
    }
    if(name==='hours'){
      if(!(await dbReply(interaction)))return;const u=interaction.options.getUser('user')||interaction.user;const d=dept(interaction.options.getString('department'));const tf=interaction.options.getString('timeframe')||'this_week';const total=await dutyTotal(u.id,d,timeWindow(tf));return safeEdit(interaction,{embeds:[new EmbedBuilder().setColor(BLUE).setTitle('Duty Hours').addFields({name:'Member',value:`<@${u.id}>`,inline:true},{name:'Department',value:d,inline:true},{name:'Time Frame',value:tfLabel(tf),inline:true},{name:'Hours',value:hoursText(total),inline:true}).setFooter({text:'WCRP Department Utilities'})]});
    }
    if(['evaluate','allhours','totalhours','weeklydeptours','deptofhours','leaderboard','tophours','inactive_officers','dept_officers','promotions'].includes(name)){
      if(!(await dbReply(interaction)))return;
      const d=dept(interaction.options.getString('department'));if(!d)return safeEdit(interaction,'Select a valid department.');
      if(name==='evaluate'){const u=interaction.options.getUser('user')||interaction.user;const w=weekWindow();const req=Number(await getSetting(`requirement:${d}`,'8',interaction.guild.id)||8);const total=await dutyTotal(u.id,d,w);const remain=Math.max(0,req*3600-total);return safeEdit(interaction,{embeds:[new EmbedBuilder().setColor(BLUE).setTitle(`${d} Weekly Evaluation`).addFields({name:'Member',value:`<@${u.id}>`,inline:true},{name:'Hours Worked',value:hoursText(total),inline:true},{name:'Required',value:`${req.toFixed(2)}h`,inline:true},{name:'Status',value:total>=req*3600?'Requirement Met':'Below Requirement',inline:true},{name:'Remaining',value:hoursText(remain),inline:true}).setFooter({text:'Friday to Thursday'})]});}
      const tf=interaction.options.getString('timeframe')||'this_week';const w=timeWindow(tf);const rows=await dbTry('SELECT discordId,SUM(GREATEST(0,LEAST(COALESCE(outTime,UNIX_TIMESTAMP()),?)-GREATEST(inTime,?))) seconds FROM duty_hours WHERE department=? AND inTime IS NOT NULL AND inTime<? AND COALESCE(outTime,UNIX_TIMESTAMP())>? AND discordId IS NOT NULL GROUP BY discordId ORDER BY seconds DESC',[w.end,w.start,d,w.end,w.start]);
      if(name==='totalhours'||name==='weeklydeptours'){const total=rows.reduce((s,r)=>s+Number(r.seconds||0),0);return safeEdit(interaction,{embeds:[new EmbedBuilder().setColor(BLUE).setTitle(`${d} Department Hours`).addFields({name:'Time Frame',value:tfLabel(tf),inline:true},{name:'Total',value:hoursText(total),inline:true})]});}
      if(name==='tophours'){return safeEdit(interaction,{embeds:[new EmbedBuilder().setColor(BLUE).setTitle('Top Hours').setDescription(rows.slice(0,5).map((r,i)=>`${i+1}. <@${r.discordId}> — ${hoursText(r.seconds)}`).join('\n')||'No recorded hours.')]});}
      if(name==='inactive_officers'||name==='dept_officers'){const weeks=interaction.options.getInteger('weeks_back')||2;const cutoff=now()-weeks*7*86400;const inactive=await dbTry('SELECT discordId,MAX(COALESCE(outTime,UNIX_TIMESTAMP())) lastDuty FROM duty_hours WHERE department=? AND discordId IS NOT NULL GROUP BY discordId HAVING lastDuty<? ORDER BY lastDuty ASC',[d,cutoff]);return safeEdit(interaction,{embeds:[new EmbedBuilder().setColor(BLUE).setTitle(`${d} Inactive Officers`).setDescription(inactive.length?inactive.map(r=>`<@${r.discordId}> — last duty ${formatShort(r.lastDuty)}`).join('\n'):'No inactive officers found.')]});}
      const title=name==='leaderboard'?`${d} Leaderboard`:`${d} Hours`;return safeEdit(interaction,{embeds:[new EmbedBuilder().setColor(BLUE).setTitle(title).setDescription(rows.slice(0,25).map((r,i)=>`${i+1}. <@${r.discordId}> — ${hoursText(r.seconds)}`).join('\n')||'No recorded hours.').setFooter({text:tfLabel(tf)})]});
    }
    if(name==='leomulti'){if(!(await dbReply(interaction)))return;const mins=interaction.options.getInteger('duration_minutes'),mult=interaction.options.getNumber('multiplier')||1.5;await setJson('leoMultiplier',{multiplier:mult,until:now()+mins*60},interaction.guild.id);return safeEdit(interaction,`LEO hour multiplier started at ${mult}x for ${mins} minutes.`);}
    if(name==='add_org'){if(!(await dbReply(interaction)))return;const code=interaction.options.getString('code').toUpperCase(),orgName=interaction.options.getString('name');await dbTry('INSERT INTO department_orgs(code,name,createdBy) VALUES(?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)',[code,orgName,interaction.user.id]);return safeEdit(interaction,`Added ${code} — ${orgName}.`);}
    if(name==='add_org_hours'){if(!(await dbReply(interaction)))return;const code=interaction.options.getString('code').toUpperCase(),hrs=interaction.options.getNumber('hours'),reason=interaction.options.getString('reason');await dbTry('INSERT INTO org_hours_adjustments(orgCode,hours,reason,createdBy,createdAt) VALUES(?,?,?,?,?)',[code,hrs,reason||null,interaction.user.id,now()]);return safeEdit(interaction,`Added ${hrs.toFixed(2)} hours to ${code}.`);}
    if(name==='rename_org'){if(!(await dbReply(interaction)))return;const oldC=interaction.options.getString('old_code').toUpperCase(),newC=interaction.options.getString('new_code').toUpperCase(),orgName=interaction.options.getString('name');await dbTry('UPDATE department_orgs SET code=?,name=? WHERE code=?',[newC,orgName,oldC]);await dbTry('UPDATE org_hours_adjustments SET orgCode=? WHERE orgCode=?',[newC,oldC]);return safeEdit(interaction,`Renamed ${oldC} to ${newC}.`);}
    return safeEdit(interaction,'Command received.');
  }catch(e){console.error(`/${name} ERROR:`,e.stack||e.message);return safeEdit(interaction,`The command could not be completed: ${e.message?.slice(0,250)||'Unknown error'}`);}
}

client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    try {
      if (interaction.commandName === 'permissions' && interaction.options.getFocused(true).name === 'command') {
        const q = String(interaction.options.getFocused() || '').toLowerCase().replace(/^\//,'');
        const choices = ALL_COMMANDS.filter(n => n.includes(q)).slice(0,25).map(n => ({ name:`/${n}`.slice(0,100), value:n }));
        return interaction.respond(choices);
      }
      return interaction.respond([]);
    } catch { return interaction.respond([]).catch(()=>{}); }
  }
  try {
    if (interaction.isChatInputCommand()) return handleCommand(interaction);
    if (interaction.isStringSelectMenu() && interaction.customId === 'report_panel_type') {
      if (interaction.guildId !== REPORT_GUILD_ID) return interaction.reply({content:'This panel is only available in the configured WCRP reports server.',flags:MessageFlags.Ephemeral});
      return interaction.showModal(reportModal(interaction.values[0]));
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('report_form:')) {
      if (!(await safeDefer(interaction,MessageFlags.Ephemeral))) return;
      if (interaction.guildId !== REPORT_GUILD_ID) return safeEdit(interaction,'Reports are only available in the configured WCRP reports server.');
      if (!(await dbReply(interaction))) return;
      const [,type]=interaction.customId.split(':');const d=dept(interaction.fields.getTextInputValue('department'));if(!d)return safeEdit(interaction,'Department must be USM, SASP, BCSO or LSPD.');
      const officer=interaction.fields.getTextInputValue('officer')?.trim()||null;if(officer&&!/^\d{17,20}$/.test(officer))return safeEdit(interaction,'Officer Discord ID is invalid.');
      const details=interaction.fields.getTextInputValue('details')||'';const channel=await createReportTicket({interaction,type,department:d,anonymous:false,reporterId:interaction.user.id,reportedUserId:officer,dateOfIncident:interaction.fields.getTextInputValue('date'),gameId:null,clip:interaction.fields.getTextInputValue('clip'),description:details,context:details});
      await sendLog(interaction.guild,'reportLogChannelId',{embeds:[new EmbedBuilder().setColor(BLUE).setTitle('Report Created').addFields({name:'Department',value:d,inline:true},{name:'Channel',value:`${channel}`,inline:true},{name:'Reporter',value:`<@${interaction.user.id}>`,inline:true}).setFooter({text:`WCRP Department Utilities • ${formatShort(now())}`})]});
      return safeEdit(interaction,`Report created: ${channel}`);
    }
    if (interaction.isButton()) {
      if (interaction.guildId !== REPORT_GUILD_ID) return interaction.reply({content:'This control is only available in the configured WCRP reports server.',flags:MessageFlags.Ephemeral});
      if (!(await safeDefer(interaction,MessageFlags.Ephemeral))) return;
      if (!(await dbReply(interaction))) return;
      const report=await fetchReport(interaction.channel.id);if(!report)return safeEdit(interaction,'This is not a report ticket.');
      if(interaction.customId==='ticket_close'){if(!(await reportStaffAllowed(interaction.member)))return safeEdit(interaction,'Reports team permission required.');await dbTry('UPDATE reports SET closedAt=? WHERE channelId=?',[now(),interaction.channel.id]);if(report.reporterId)await interaction.channel.permissionOverwrites.edit(report.reporterId,{ViewChannel:false,SendMessages:false}).catch(()=>{});return safeEdit(interaction,{content:'Ticket closed.',components:[ticketButtons(true)]});}
      if(interaction.customId==='ticket_transcript'){if(!(await reportStaffAllowed(interaction.member)))return safeEdit(interaction,'Reports team permission required.');const text=await transcript(interaction.channel);await sendLog(interaction.guild,'transcriptLogChannelId',{content:`Transcript for #${interaction.channel.name}`,files:[{attachment:Buffer.from(text||'No messages.'),name:`${interaction.channel.name}-transcript.txt`} ]});return safeEdit(interaction,'Transcript saved to the configured log channel.');}
      if(interaction.customId==='ticket_delete'){if(!(await reportStaffAllowed(interaction.member)))return safeEdit(interaction,'Reports team permission required.');const text=await transcript(interaction.channel);await sendLog(interaction.guild,'transcriptLogChannelId',{content:`Transcript for #${interaction.channel.name}`,files:[{attachment:Buffer.from(text||'No messages.'),name:`${interaction.channel.name}-transcript.txt`} ]});await safeEdit(interaction,'Transcript saved. Deleting ticket...');setTimeout(()=>interaction.channel.delete('Report ticket deleted').catch(()=>{}),800);}
    }
  } catch(e) {
    console.error('INTERACTION ERROR:',e.stack||e.message);
    await safeEdit(interaction,`An error occurred: ${e.message?.slice(0,250)||'Unknown error'}`);
  }
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
  try { await registerCommands(); } catch(e) { console.error('GLOBAL COMMAND REGISTRATION FAILED:',e.stack||e.message); }
  const initDB = async () => {
    try { await ensureSchema(); dbOnline=true; console.log('DATABASE ONLINE'); await pollDuty(); if(!dutyTimer)dutyTimer=setInterval(()=>pollDuty().catch(()=>{}),DUTY_POLL_MS); if(dbRetryTimer){clearInterval(dbRetryTimer);dbRetryTimer=null;} }
    catch(e){ dbOnline=false; console.error('DATABASE OFFLINE:',e.message); if(!dbRetryTimer)dbRetryTimer=setInterval(initDB,30000); }
  };
  await initDB();
});

process.on('unhandledRejection',e=>console.error('UNHANDLED REJECTION:',e));
process.on('uncaughtException',e=>console.error('UNCAUGHT EXCEPTION:',e));
process.on('SIGINT',async()=>{clearInterval(dutyTimer);clearInterval(dbRetryTimer);await pool.end().catch(()=>{});process.exit(0);});
process.on('SIGTERM',async()=>{clearInterval(dutyTimer);clearInterval(dbRetryTimer);await pool.end().catch(()=>{});process.exit(0);});

client.login(TOKEN);
