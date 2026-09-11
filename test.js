'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `Missing section: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.ok(end > start, `Missing end section: ${endMarker}`);
  return source.slice(start, end);
}

const oldBrand = ['PS', 'RP'].join('');
assert.strictEqual(source.toLowerCase().includes(oldBrand.toLowerCase()), false, 'Legacy branding remains in index.js');
assert.strictEqual(fs.readFileSync(path.join(root, 'README.md'), 'utf8').toLowerCase().includes(oldBrand.toLowerCase()), false, 'Legacy branding remains in README.md');
assert.strictEqual(/\p{Extended_Pictographic}/u.test(source), false, 'Decorative emoji found in index.js');

assert.ok(source.includes("const REPORT_GUILD_ID = '1499578614298181642';"));
for (const id of ['1542399560394088538', '1542399564588261446', '1542399567234994206']) {
  assert.ok(source.includes(`'${id}'`), `Missing LEO voice channel ${id}`);
}
for (const department of ['USM', 'SASP', 'BCSO', 'LSPD']) {
  assert.ok(source.includes(`'${department}'`), `Missing department ${department}`);
}

assert.ok(source.includes('Routes.applicationCommands(CLIENT_ID)'), 'Commands are not registered globally');
assert.strictEqual(source.includes('Routes.applicationGuildCommands'), false, 'Guild command registration found');

const interactionSection = section("client.on('interactionCreate'", "client.once('clientReady'");
assert.ok(interactionSection.indexOf('await interaction.deferReply') < interactionSection.indexOf('handleCommand(interaction)'), 'Slash command is not deferred before command handling');
assert.ok(interactionSection.includes("interaction.isButton()"));
assert.ok(interactionSection.includes("await interaction.deferReply({ ephemeral: true })"), 'Button/modal defer missing');
assert.ok(interactionSection.includes('return await handleReportSelect(interaction)'), 'Report select handler missing');

const selectSection = section('async function handleReportSelect', 'async function handleReportModal');
assert.ok(selectSection.includes('interaction.showModal(reportFieldsModal(type))'), 'Report select does not immediately show modal');
assert.strictEqual(/\bq\(|getSetting\(|getJsonSetting\(/.test(selectSection), false, 'Report select waits on database before modal');

const modalSection = section('function reportFieldsModal', 'function reportContext');
for (const id of ['department', 'officer', 'date', 'evidence', 'details']) {
  assert.ok(modalSection.includes(`.setCustomId('${id}')`), `Modal missing ${id}`);
}
assert.strictEqual((modalSection.match(/new ActionRowBuilder\(\)\.addComponents/g) || []).length, 5, 'Report modal must have exactly five input rows');

const anonCommandBuild = section("commands.find(c => c.name === 'addofficer')", 'function addReportOptions');
assert.strictEqual(anonCommandBuild.includes("commands.find(c => c.name === 'anonreport')"), false, '/anonreport unexpectedly has input options');

const anonSection = section('async function handleAnonReport', 'async function handleRename');
assert.ok(anonSection.includes('report.anonymous = 1'));
assert.ok(anonSection.includes('permissionOverwrites.set(overwrites)'), 'Anonymous permissions are not rebuilt');
assert.ok(anonSection.includes('clearChannelFast(interaction.channel)'), 'Anonymous ticket is not cleared');
assert.ok(anonSection.includes('`anon-${report.department.toLowerCase()}`'), 'Anonymous channel rename missing');
assert.ok(anonSection.includes('sendReportPost(interaction.channel, report'), 'Anonymous report embed/evidence is not resubmitted');

const anonPerms = section('async function anonymousReportPermissions', 'async function persistReport');
assert.ok(anonPerms.includes('staffRoleIds'), 'Reports Team roles not retained');
assert.ok(anonPerms.includes('report.reportedUserId'), 'Reported user access missing');
assert.ok(anonPerms.includes('deny: [PermissionFlagsBits.SendMessages]'), 'Reported user should be read-only');
assert.strictEqual(anonPerms.includes('reportRoles:'), false, 'Department ping roles retained in anonymous permissions');

const addOfficerSection = section('async function handleAddOfficer', 'async function handleAnonReport');
assert.ok(addOfficerSection.includes("interaction.options.getUser('user')"));
assert.ok(addOfficerSection.includes("interaction.options.getString('user_id')"));
assert.ok(addOfficerSection.includes('anonymousReportPermissions'), 'Anonymous /addofficer does not grant reportee access');
assert.ok(addOfficerSection.includes('replaceReportPost'), 'Anonymous /addofficer does not resubmit full report embed');

const renameSection = section('async function handleRename', 'async function handleClose');
assert.ok(renameSection.includes('cleanName(interaction.user.username)'), '/rename does not use handler username');
assert.strictEqual(renameSection.includes('report.reporterId'), false, '/rename still uses reporter username');

const rideSection = section('async function handleRideAlong', 'async function handleCommand');
assert.ok(rideSection.includes('member.roles.cache.has(traineeRoleId)'));
assert.ok(rideSection.includes('member.roles.remove(traineeRoleId'), 'Ride-along does not remove configured trainee role');

const offDuty = section('function dutyOffEmbed', 'function getWeekWindow');
for (const label of ['Off Duty', 'We hope you enjoyed your shift!', 'Reason', 'Clock Out', 'Session', 'This Week (Fri-Thu)', 'Week', 'Department', 'In Voice', 'Out of Voice', 'Voice Coverage']) {
  assert.ok(offDuty.includes(label), `Off Duty embed missing ${label}`);
}
assert.strictEqual(offDuty.includes("name: 'Clock In'"), false, 'Off Duty embed still includes Clock In field');

const commandBuild = section('const commands = [', 'function buildCommandsJson');
const hoursPos = commandBuild.indexOf("commands.find(c => c.name === 'hours')");
assert.ok(hoursPos >= 0);
const hoursBlock = commandBuild.slice(hoursPos, commandBuild.indexOf("commands.find(c => c.name === 'evaluate')", hoursPos));
assert.ok(hoursBlock.includes("department', true"));
assert.ok(hoursBlock.includes("setName('timeframe')") && hoursBlock.includes('setRequired(true)'));
assert.ok(hoursBlock.includes("setName('user')") && hoursBlock.includes('setRequired(false)'));

const evalPos = commandBuild.indexOf("commands.find(c => c.name === 'evaluate')");
const evalBlock = commandBuild.slice(evalPos, commandBuild.indexOf("for (const name of ['allhours'", evalPos));
assert.ok(evalBlock.includes("setName('user')") && evalBlock.includes('setRequired(true)'));
assert.ok(evalBlock.includes("department', true"));
assert.ok(evalBlock.includes("setName('timeframe')") && evalBlock.includes('setRequired(true)'));

assert.ok(source.includes('DB_TIMEOUT_MS'));
assert.ok(source.includes('DB_RETRY_COOLDOWN_MS'));
assert.ok(source.includes('DatabaseUnavailableError'));
assert.ok(source.includes('settings-cache.json'));
assert.ok(envExample.includes('DB_TIMEOUT_MS=1500'));

for (const column of ['discordId', 'inTime', 'outTime', 'department']) {
  assert.ok(schema.includes(`\`${column}\``), `duty_hours schema missing ${column}`);
}
assert.ok(schema.includes('duty_voice_segments'));
assert.ok(schema.includes('bot_settings'));
assert.ok(schema.includes('reports'));
assert.ok(schema.includes('ridealongs'));

assert.strictEqual(pkg.main, 'index.js');
assert.strictEqual(pkg.scripts.start, 'node index.js');
assert.ok(pkg.scripts.check);
assert.ok(pkg.scripts.test);

console.log('All WCRP Department Utilities static integration tests passed.');
