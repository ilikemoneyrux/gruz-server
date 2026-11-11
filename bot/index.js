// Bot Discord Gruz Client. Włącza się, gdy ustawisz zmienną DISCORD_TOKEN (szczegóły w README).
//
// /gruz       – dla wszystkich: player, online, top, skin, server, servers
// /gruzadmin  – dla adminów:     giveaway, code, tickets, verify, config, wipe
// /shop-codes – dla adminów:     paczka jednorazowych kodów na kosmetykę + plik CSV (do sprzedaży kodów)
//
// Ustawienia bota (język, kanały, kategorie ticketów, giveawaye…) trzymamy w db.discord,
// więc przetrwają restart serwera.
const crypto = require('crypto');
const {
  Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes, ActivityType, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, StringSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, AttachmentBuilder,
} = require('discord.js');
const i18n = require('./i18n');
const images = require('./images');
const mcping = require('./mcping');

const COLOR = 0xb45cff;
const GREEN = 0x3ddc84;
const RED = 0xff5c7a;
const RELEASES_REPO = process.env.GRUZ_RELEASES_REPO || 'ilikemoneyrux/gruz-client';
// opis zmian do ogłoszeń nowych wersji (ten sam plik co gruzclient.com/changelog i okienko „Co nowego” w launcherze)
const CHANGELOG_URL = process.env.GRUZ_CHANGELOG_URL || 'https://gruzclient.com/changelog.json';
const SITE = (process.env.SHOP_SITE_URL || 'https://gruzclient.com').replace(/\/+$/, '');
const LINK_XP = 200; // jednorazowe XP za połączenie konta Discord (/gruz link)
const P = PermissionFlagsBits;

const SLOT = {
  en: { cape: 'Cape', head: 'Hat', wings: 'Wings', back: 'Back item', trail: 'Trail', pet: 'Pet', name: 'Name effect' },
  pl: { cape: 'Peleryna', head: 'Czapka', wings: 'Skrzydła', back: 'Plecak', trail: 'Ślad', pet: 'Zwierzak', name: 'Efekt nicku' },
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------- komendy ----------------
const cosmeticOpt = (o) => o.setName('cosmetic').setDescription('Cosmetic').setRequired(true).setAutocomplete(true);
const publicCmd = new SlashCommandBuilder()
  .setName('gruz').setDescription('Gruz Client')
  .addSubcommand((s) => s.setName('player').setDescription('Gruz Client player profile')
    .addStringOption((o) => o.setName('nick').setDescription('Minecraft nickname (empty = your linked account)')))
  .addSubcommand((s) => s.setName('link').setDescription('Link your Minecraft account (code from the Gruz launcher)')
    .addStringOption((o) => o.setName('code').setDescription('6-character code from Launcher → Friends → Link Discord').setRequired(true).setMinLength(6).setMaxLength(6)))
  .addSubcommand((s) => s.setName('unlink').setDescription('Unlink your Minecraft account'))
  .addSubcommand((s) => s.setName('online').setDescription('Who is playing Gruz Client right now'))
  .addSubcommand((s) => s.setName('top').setDescription('Gruz Client leaderboard')
    .addStringOption((o) => o.setName('period').setDescription('This week (XP) or all time (hours)')
      .addChoices({ name: 'This week', value: 'week' }, { name: 'All time', value: 'all' })))
  .addSubcommand((s) => s.setName('invite').setDescription('Post a link that lets anyone join your Gruz party')
    .addStringOption((o) => o.setName('message').setDescription('e.g. "Bedwars 4v4, need 2 more"').setMaxLength(120)))
  .addSubcommand((s) => s.setName('skin').setDescription('Skin preview with the Gruz cape')
    .addStringOption((o) => o.setName('nick').setDescription('Minecraft nickname').setRequired(true)))
  .addSubcommand((s) => s.setName('server').setDescription('Minecraft server status')
    .addStringOption((o) => o.setName('address').setDescription('e.g. hypixel.net').setRequired(true)))
  .addSubcommand((s) => s.setName('servers').setDescription('Most played servers by Gruz Client players'))
  .addSubcommand((s) => s.setName('invites').setDescription('Your invite code, invited friends and rewards'));

const adminCmd = new SlashCommandBuilder()
  .setName('gruzadmin').setDescription('Gruz Client – admin tools')
  .setDefaultMemberPermissions(P.Administrator).setDMPermission(false)
  .addSubcommandGroup((g) => g.setName('giveaway').setDescription('Cosmetic giveaways')
    .addSubcommand((s) => s.setName('start').setDescription('Start a giveaway')
      .addStringOption(cosmeticOpt)
      .addStringOption((o) => o.setName('duration').setDescription('e.g. 30m, 24h, 2d').setRequired(true))
      .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(20))
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('end').setDescription('End a giveaway now')
      .addStringOption((o) => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)))
    .addSubcommand((s) => s.setName('reroll').setDescription('Pick new winners')
      .addStringOption((o) => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true))))
  .addSubcommand((s) => s.setName('code').setDescription('Create a cosmetic code (and DM it to someone)')
    .addStringOption(cosmeticOpt)
    .addUserOption((o) => o.setName('user').setDescription('Send the code to this person in DMs'))
    .addIntegerOption((o) => o.setName('uses').setDescription('How many times the code works (default 1)').setMinValue(1).setMaxValue(1000))
    .addStringOption((o) => o.setName('note').setDescription('Note for the admin panel')))
  .addSubcommandGroup((g) => g.setName('tickets').setDescription('Ticket system')
    .addSubcommand((s) => s.setName('panel').setDescription('Post the ticket panel')
      .addChannelOption((o) => o.setName('channel').setDescription('Where (default: here)').addChannelTypes(ChannelType.GuildText))
      .addStringOption((o) => o.setName('title').setDescription('Panel title'))
      .addStringOption((o) => o.setName('text').setDescription('Panel text')))
    .addSubcommand((s) => s.setName('add-category').setDescription('Add a ticket category')
      .addStringOption((o) => o.setName('name').setDescription('e.g. Bug report').setRequired(true).setMaxLength(40))
      .addStringOption((o) => o.setName('description').setDescription('Short description shown in the menu').setRequired(true).setMaxLength(90))
      .addStringOption((o) => o.setName('emoji').setDescription('e.g. 🐛'))
      .addStringOption((o) => o.setName('question').setDescription('Label of the description field (default: Describe your problem)').setMaxLength(45)))
    .addSubcommand((s) => s.setName('remove-category').setDescription('Remove a ticket category')
      .addStringOption((o) => o.setName('name').setDescription('Category').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('staff-role').setDescription('Role that sees and handles tickets')
      .addRoleOption((o) => o.setName('role').setDescription('Staff role').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Show ticket settings')))
  .addSubcommandGroup((g) => g.setName('verify').setDescription('Captcha verification')
    .addSubcommand((s) => s.setName('panel').setDescription('Post the verification panel')
      .addRoleOption((o) => o.setName('role').setDescription('Role given after verification').setRequired(true))
      .addChannelOption((o) => o.setName('channel').setDescription('Where (default: here)').addChannelTypes(ChannelType.GuildText))
      .addIntegerOption((o) => o.setName('min_account_age_days').setDescription('Block Discord accounts younger than this (default 0)').setMinValue(0).setMaxValue(365))))
  .addSubcommandGroup((g) => g.setName('config').setDescription('Bot settings')
    .addSubcommand((s) => s.setName('language').setDescription('Bot language')
      .addStringOption((o) => o.setName('language').setDescription('Language').setRequired(true)
        .addChoices({ name: 'English', value: 'en' }, { name: 'Polski', value: 'pl' })))
    .addSubcommand((s) => s.setName('status-channel').setDescription('Channel with the live list of Gruz players')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('updates-channel').setDescription('Channel for new version announcements')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('logs-channel').setDescription('Channel for ticket transcripts and verification logs')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('crashes-channel').setDescription('Channel for crash reports sent from the launcher (staff only!)')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('member-role').setDescription('Role given after linking a Minecraft account (e.g. Gruz Member)')
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('partner-role').setDescription('Add/remove a role that can use /gruzpartner (e.g. Partner, Content Creator)')
      .addRoleOption((o) => o.setName('role').setDescription('Role (run again to remove)').setRequired(true)))
    .addSubcommand((s) => s.setName('ranking-channel').setDescription('Channel for the weekly XP ranking (posted every Monday)')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('shop-channel').setDescription('Channel for new cosmetics and sales in the shop (posted automatically)')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))))
  .addSubcommandGroup((g) => g.setName('levels').setDescription('Discord roles for Gruz levels')
    .addSubcommand((s) => s.setName('set').setDescription('Give a role to linked players from this level up')
      .addIntegerOption((o) => o.setName('level').setDescription('Gruz level').setRequired(true).setMinValue(1).setMaxValue(200))
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove the role for a level')
      .addIntegerOption((o) => o.setName('level').setDescription('Gruz level').setRequired(true).setMinValue(1).setMaxValue(200)))
    .addSubcommand((s) => s.setName('list').setDescription('Show level roles'))
    .addSubcommand((s) => s.setName('sync').setDescription('Check every linked player now')))
  .addSubcommand((s) => s.setName('ranking').setDescription('Post the current weekly ranking now'))
  .addSubcommandGroup((g) => g.setName('invites').setDescription('Rewards for inviting friends')
    .addSubcommand((s) => s.setName('set').setDescription('Add or change a reward: invite N friends -> get a cosmetic')
      .addIntegerOption((o) => o.setName('count').setDescription('How many invited friends').setRequired(true).setMinValue(1).setMaxValue(1000))
      .addStringOption(cosmeticOpt))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a reward')
      .addIntegerOption((o) => o.setName('count').setDescription('Reward for how many friends').setRequired(true).setMinValue(1).setMaxValue(1000)))
    .addSubcommand((s) => s.setName('welcome').setDescription('Cosmetic for the NEW player who used a friend code (empty = none)')
      .addStringOption((o) => o.setName('cosmetic').setDescription('Cosmetic').setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Show invite rewards and top inviters')))
  .addSubcommandGroup((g) => g.setName('event').setDescription('Community events')
    .addSubcommand((s) => s.setName('create').setDescription('Announce an event with a reminder and a Join button')
      .addStringOption((o) => o.setName('title').setDescription('e.g. Bedwars tournament').setRequired(true).setMaxLength(80))
      .addStringOption((o) => o.setName('when').setDescription('"20:00", "tomorrow 18:30", "05.11 20:00", "2026-11-05 20:00" or "in 2h"').setRequired(true).setMaxLength(40))
      .addStringOption((o) => o.setName('server').setDescription('Server IP players should join, e.g. mc.hypixel.net').setMaxLength(80))
      .addStringOption((o) => o.setName('description').setDescription('What is going to happen').setMaxLength(1000))
      .addStringOption((o) => o.setName('prize').setDescription('e.g. Galaxy cape for the winner').setMaxLength(100))
      .addRoleOption((o) => o.setName('ping').setDescription('Role to ping in the announcement'))
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel an event')
      .addStringOption((o) => o.setName('message_id').setDescription('Event message ID').setRequired(true))))
  .addSubcommand((s) => s.setName('release').setDescription('Announce the latest Gruz Client release in the updates channel now'))
  .addSubcommand((s) => s.setName('wipe').setDescription('Delete every channel except the bot channels'));

// /shop-codes – paczka jednorazowych kodów na kosmetykę do sprzedaży (np. w Tebexie) + plik CSV tylko dla admina
const shopCodesCmd = new SlashCommandBuilder()
  .setName('shop-codes').setDescription('Generate single-use cosmetic codes to sell (sends you a CSV file)')
  .setDefaultMemberPermissions(P.Administrator).setDMPermission(false)
  .addStringOption(cosmeticOpt)
  .addIntegerOption((o) => o.setName('amount').setDescription('How many codes (1–1000)').setRequired(true).setMinValue(1).setMaxValue(1000))
  .addStringOption((o) => o.setName('note').setDescription('Note for the admin panel (e.g. Tebex package name)').setMaxLength(60));

/** Plik dokładnie jak szablon Tebexa (license-keys-template.csv): bez nagłówka, bez BOM i cudzysłowów, "KOD," w każdej linii, końce linii LF */
function codesCsv(codes) {
  return codes.map((c) => `${c},`).join('\n') + '\n';
}

const partnerCmd = new SlashCommandBuilder()
  .setName('gruzpartner').setDescription('Gruz Client – for partners and content creators').setDMPermission(false)
  .addSubcommand((s) => s.setName('set-nick').setDescription('Set your creator name (YouTube/Twitch/TikTok) and your creator code')
    .addStringOption((o) => o.setName('nick').setDescription('Name shown on your banners, e.g. your YouTube name').setRequired(true).setMaxLength(24))
    .addStringOption((o) => o.setName('code').setDescription('Creator code players type in the launcher (default: your nick)').setMinLength(3).setMaxLength(16)))
  .addSubcommand((s) => s.setName('banners').setDescription('Get ready-made Gruz Client ads with your name and creator code'))
  .addSubcommand((s) => s.setName('stats').setDescription('How many players used your creator code'));


module.exports = function startDiscord(ctx) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return null;
  const guildId = process.env.DISCORD_GUILD_ID || '';
  const { db } = ctx;

  // ---------------- ustawienia ----------------
  function cfg() {
    const d = (db.discord ||= {});
    d.lang ||= 'en';
    d.channels ||= {};
    d.giveaways ||= {};
    d.tickets ||= {};
    const t = d.tickets;
    t.categories ||= [];
    t.open ||= {};
    t.panels ||= [];
    t.counter ||= 0;
    d.verify ||= {};
    return d;
  }
  const t = i18n.make(() => cfg().lang);
  const statusChannel = () => cfg().channels.status || process.env.DISCORD_CHANNEL_ID || '';
  const save = () => ctx.save();

  const cosmeticLabel = (key) => {
    const lang = cfg().lang === 'pl' ? 'pl' : 'en';
    if (key === 'all') return lang === 'pl' ? 'Wszystkie kosmetyki' : 'All cosmetics';
    if (key === 'pass:premium') return lang === 'pl' ? 'Gruz Pass Premium (bieżący miesiąc)' : 'Gruz Pass Premium (current month)';
    if (/^plus:\d+$/.test(key)) return lang === 'pl' ? `Gruz+ (${key.slice(5)} dni)` : `Gruz+ (${key.slice(5)} days)`;
    if (key.startsWith('emote:')) { const n = { highfive: ['Przybij piątkę', 'High five'], hug: ['Przytulas', 'Hug'], duodance: ['Taniec w parze', 'Duo dance'] }[key.slice(6)] || [key, key]; return (lang === 'pl' ? 'Emotka we dwoje: ' : 'Duo emote: ') + n[lang === 'pl' ? 0 : 1]; }
    const [slot, v] = key.split(':');
    const own = ctx.catalog?.customName?.(key, lang); // własna peleryna z panelu – nazwa z panelu
    if (own) return lang === 'pl' ? `${SLOT.pl[slot]} ${own}` : `${own} ${SLOT.en[slot].toLowerCase()}`;
    return lang === 'pl' ? `${SLOT.pl[slot]} ${cap(v)}` : `${cap(v)} ${SLOT.en[slot].toLowerCase()}`;
  };
  const hoursText = (ms) => { const h = (ms || 0) / 36e5; return t('hours', { h: h >= 10 ? Math.round(h) : h.toFixed(1) }); };
  const ts = (ms, f = 'R') => `<t:${Math.floor(ms / 1000)}:${f}>`;
  const findUser = (nick) => Object.values(db.users).find((x) => x.name.toLowerCase() === String(nick).trim().toLowerCase());

  function makeCode(cosmetic, note, maxUses = 1) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = 'GRUZ-'; for (let i = 0; i < 8; i++) code += abc[crypto.randomInt(abc.length)]; } while (db.codes[code]);
    db.codes[code] = { cosmetic, maxUses, used: [], created: Date.now(), note: String(note || '').slice(0, 80) };
    save();
    return code;
  }

  function parseDuration(s) {
    let ms = 0;
    const re = /(\d+)\s*(w|d|h|m|s)/gi;
    let m, matched = '';
    while ((m = re.exec(s))) { ms += Number(m[1]) * { w: 6048e5, d: 864e5, h: 36e5, m: 6e4, s: 1e3 }[m[2].toLowerCase()]; matched += m[0]; }
    if (!matched || matched.replace(/\s/g, '').length !== String(s).replace(/\s/g, '').length) return null;
    return ms >= 6e4 && ms <= 30 * 864e5 ? ms : null;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  // ---------------- wspólne ----------------
  const reply = (i, content, extra = {}) => (i.deferred || i.replied
    ? i.editReply({ content, ...extra })
    : i.reply({ content, ephemeral: true, ...extra }));
  const isAdmin = (i) => i.inGuild() && (i.memberPermissions?.has(P.Administrator) || i.memberPermissions?.has(P.ManageGuild));
  const isStaff = (i) => isAdmin(i) || (cfg().tickets.staffRole && i.member?.roles?.cache?.has(cfg().tickets.staffRole));
  const cooldown = new Map();
  function slow(i, ms = 4000) {
    const k = i.user.id + ':' + (i.options?.getSubcommand?.(false) || '');
    const last = cooldown.get(k) || 0;
    if (Date.now() - last < ms) return true;
    cooldown.set(k, Date.now());
    return false;
  }
  async function logTo(payload) {
    const id = cfg().channels.logs;
    if (!id) return;
    try { const ch = await client.channels.fetch(id); await ch.send(payload); } catch { /* kanał usunięty */ }
  }

  // ---------------- lista online / profil / top ----------------
  function where(p) {
    return p.state === 'multiplayer' && p.server ? t('playingOn', { s: p.server }) : t('state.' + (p.state || 'online')) || t('state.online');
  }
  function onlineEmbed() {
    const list = [];
    for (const uuid of ctx.online.keys()) { const u = db.users[uuid]; if (u) list.push({ u, p: ctx.presenceOf(uuid) }); }
    list.sort((a, b) => a.u.name.localeCompare(b.u.name));
    const lines = list.slice(0, 40).map(({ u, p }) => `• **${u.name}** · ${t('level', { n: ctx.levelOf(u).level })} · ${where(p)}`);
    return new EmbedBuilder().setColor(COLOR).setTitle(t('onlineTitle', { n: list.length }))
      .setDescription(list.length ? lines.join('\n') + (list.length > 40 ? '\n' + t('onlineMore', { n: list.length - 40 }) : '') : t('onlineNobody'))
      .setFooter({ text: t('onlineFooter', { n: Object.keys(db.users).length }) }).setTimestamp(new Date());
  }
  function profileEmbed(u) {
    const p = ctx.presenceOf(u.uuid);
    const lv = ctx.levelOf(u);
    const badges = (u.badges || []).map((b) => ctx.badgeName(b)).filter(Boolean);
    // publiczny profil na stronie (gruzclient.com/u/<nick>), chyba że gracz go ukrył
    const web = u.privateProfile ? null : `https://gruzclient.com/u/${encodeURIComponent(u.name)}`;
    return new EmbedBuilder().setColor(COLOR)
      .setTitle(u.name).setURL(web || `https://namemc.com/profile/${u.uuid}`)
      .setThumbnail(`https://mc-heads.net/avatar/${u.uuid}/128`)
      .setDescription((p.online ? `🟢 ${where(p)}` : t('offlineSeen', { t: ts(u.lastSeen || Date.now()) })) + (web ? `\n🌐 [gruzclient.com/u/${u.name.replace(/[*_`~]/g, '\\$&')}](${web})` : ''))
      .addFields(
        { name: t('f.level'), value: `${lv.level} (${lv.xp}/${lv.next} XP)`, inline: true },
        { name: t('f.playtime'), value: hoursText(u.stats?.totalMs), inline: true },
        { name: t('f.kills'), value: String(u.stats?.kills || 0), inline: true },
        { name: t('f.friends'), value: String(u.friends?.length || 0), inline: true },
        { name: t('f.since'), value: ts(u.firstSeen || Date.now(), 'D'), inline: true },
        { name: t('f.badges'), value: badges.length ? badges.join(', ') : t('none'), inline: false },
      );
  }

  // ---------------- /gruz skin ----------------
  async function cmdSkin(i) {
    await i.deferReply();
    const nick = i.options.getString('nick', true).trim();
    if (!/^\w{1,16}$/.test(nick)) return i.editReply(t('skinNotFound', { nick: nick.slice(0, 20) }));
    const prof = await images.mojangProfile(nick).catch(() => null);
    if (!prof) return i.editReply(t('skinNotFound', { nick }));
    const u = db.users[prof.uuid];
    const capeKey = /(?:^|;)cape=([a-z]+)/.exec(u?.cosmetics || '')?.[1];
    const cape = capeKey && capeKey !== 'none' ? capeKey : 'gruz';
    const skin = prof.skinUrl ? await images.fetchBuf(prof.skinUrl).catch(() => null) : null;
    const png = await images.skinCard({
      name: prof.name, skin, slim: prof.slim, cape,
      line1: u ? t('skinGruz', { lv: ctx.levelOf(u).level, h: hoursText(u.stats?.totalMs) }) : t('skinNotGruz'),
      capeLabel: t('skinCape', { c: cosmeticLabel('cape:' + cape) }),
    });
    return i.editReply({ files: [new AttachmentBuilder(png, { name: `${prof.name}.png` })] });
  }

  // ---------------- /gruz server ----------------
  async function cmdServer(i) {
    await i.deferReply();
    const addr = i.options.getString('address', true).trim().slice(0, 100);
    let s;
    try { s = await mcping.ping(addr); } catch {
      return i.editReply({ embeds: [new EmbedBuilder().setColor(RED).setDescription(t('srvOffline', { a: addr.replace(/[*_`~]/g, '') }))] });
    }
    const key = ctx.serverKey(s.display);
    let gruzHere = 0;
    for (const v of ctx.serverSessions.values()) if (v.key === key) gruzHere++;
    const e = new EmbedBuilder().setColor(GREEN).setTitle(s.display).setDescription(t('srvOnline'))
      .addFields(
        { name: t('f.players'), value: `${s.online.toLocaleString('en')} / ${s.max.toLocaleString('en')}`, inline: true },
        { name: t('f.version'), value: s.version.slice(0, 60) || '?', inline: true },
        { name: t('f.ping'), value: s.latency != null ? `${s.latency} ms` : '?', inline: true },
        { name: t('f.gruzHere'), value: String(gruzHere), inline: true },
      );
    if (s.motd) e.addFields({ name: t('f.motd'), value: '```' + s.motd.replace(/```/g, '').slice(0, 300) + '```' });
    if (s.sample.length) e.addFields({ name: t('srvSample'), value: s.sample.join(', ').slice(0, 300) });
    const files = [];
    if (s.favicon) { files.push(new AttachmentBuilder(s.favicon, { name: 'icon.png' })); e.setThumbnail('attachment://icon.png'); }
    return i.editReply({ embeds: [e], files });
  }

  // ---------------- /gruz servers ----------------
  function cmdServers(i) {
    const live = new Map();
    for (const v of ctx.serverSessions.values()) live.set(v.key, (live.get(v.key) || 0) + 1);
    const rows = Object.entries(db.servers || {})
      .map(([k, v]) => ({ k, players: v.players?.length || 0, ms: v.ms || 0, now: live.get(k) || 0 }))
      .sort((a, b) => b.players - a.players || b.ms - a.ms).slice(0, 15);
    return i.reply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle(t('serversTitle'))
      .setDescription(rows.length ? rows.map((r, k) => t('serversLine', { i: k + 1, s: r.k, p: r.players, h: hoursText(r.ms), n: r.now })).join('\n') : t('noData'))] });
  }

  // ---------------- kody ----------------
  async function cmdCode(i) {
    const cosmetic = i.options.getString('cosmetic', true);
    if (!(ctx.isCodeKey ? ctx.isCodeKey(cosmetic) : ctx.LOCKED.includes(cosmetic))) return reply(i, t('unknownCosmetic'));
    const target = i.options.getUser('user');
    const uses = i.options.getInteger('uses') || 1;
    const code = makeCode(cosmetic, i.options.getString('note') || `discord ${i.user.tag}${target ? ' → ' + target.tag : ''}`, uses);
    let msg = t('codeMade', { c: cosmeticLabel(cosmetic), code, u: uses });
    if (target) {
      try {
        await target.send({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle(t('codeDmTitle')).setDescription(t('codeDmBody', { c: cosmeticLabel(cosmetic), code }))] });
        msg += '\n' + t('codeSent', { user: `${target}` });
      } catch { msg += '\n' + t('codeDmFail', { user: `${target}` }); }
    }
    return reply(i, msg);
  }

  async function cmdShopCodes(i) {
    const cosmetic = i.options.getString('cosmetic', true);
    if (!(ctx.isCodeKey ? ctx.isCodeKey(cosmetic) : ctx.LOCKED.includes(cosmetic))) return reply(i, t('unknownCosmetic'));
    const amount = Math.min(1000, Math.max(1, i.options.getInteger('amount', true)));
    await i.deferReply({ ephemeral: true });
    const d = new Date();
    const batch = `shop-${d.toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
    const note = `${batch}${i.options.getString('note') ? ' · ' + i.options.getString('note') : ''} · ${i.user.tag}`.slice(0, 80);
    const name = cosmeticLabel(cosmetic);
    const codes = [];
    for (let k = 0; k < amount; k++) {
      const code = makeCode(cosmetic, note, 1);
      db.codes[code].batch = batch; // cała paczka razem – widać w panelu (Kody) po notatce
      codes.push(code);
    }
    save();
    console.log(`[discord] /shop-codes: ${amount} × ${cosmetic} (${batch}) przez ${i.user.tag}`);
    return i.editReply({
      content: t('shopCodesMade', { n: amount, c: name, batch }),
      files: [new AttachmentBuilder(Buffer.from(codesCsv(codes), 'utf8'), { name: `tebex-keys-${cosmetic.replace(':', '-')}-${batch}.csv` })],
    });
  }

  // ---------------- giveawaye ----------------
  const dirtyGw = new Set();
  function gwComponents(g, ended) {
    const row = new ActionRowBuilder();
    if (ended) row.addComponents(new ButtonBuilder().setCustomId('gw:claim').setLabel(t('gwClaim')).setEmoji('🎁').setStyle(ButtonStyle.Success).setDisabled(!g.winners?.length));
    else row.addComponents(new ButtonBuilder().setCustomId('gw:join').setLabel(`${t('gwJoin')} (${g.entrants.length})`).setEmoji('🎉').setStyle(ButtonStyle.Primary));
    return [row];
  }
  function gwEmbed(g) {
    const e = new EmbedBuilder().setColor(g.ended ? 0x5a5a6e : COLOR).setTitle(t('gwTitle'))
      .setThumbnail('attachment://logo.png');
    if (!g.ended) e.setDescription(t('gwBody', { c: cosmeticLabel(g.cosmetic), w: g.count, end: ts(g.endsAt), endAbs: ts(g.endsAt, 'f'), host: `<@${g.host}>` }));
    else e.setDescription(t('gwEndedBody', { c: cosmeticLabel(g.cosmetic), winners: g.winners.length ? g.winners.map((w) => `<@${w}>`).join(', ') : t('gwNoEntries'), endAbs: ts(g.endsAt, 'f'), n: g.entrants.length }));
    return e;
  }
  const logoFile = () => new AttachmentBuilder(require('path').join(__dirname, '..', 'assets', 'logo.png'), { name: 'logo.png' });

  async function cmdGiveawayStart(i) {
    const cosmetic = i.options.getString('cosmetic', true);
    if (!ctx.LOCKED.includes(cosmetic)) return reply(i, t('unknownCosmetic'));
    const ms = parseDuration(i.options.getString('duration', true));
    if (!ms) return reply(i, t('gwBadDuration'));
    const ch = i.options.getChannel('channel') || i.channel;
    const g = { channelId: ch.id, cosmetic, count: i.options.getInteger('winners') || 1, endsAt: Date.now() + ms, host: i.user.id, entrants: [], winners: [], codes: {}, ended: false };
    const msg = await ch.send({ embeds: [gwEmbed(g)], components: gwComponents(g), files: [logoFile()] });
    cfg().giveaways[msg.id] = g;
    save();
    return reply(i, t('gwStarted', { ch: `${ch}` }));
  }

  function pickWinners(g, n, exclude = []) {
    const pool = g.entrants.filter((id) => !exclude.includes(id));
    const out = [];
    while (out.length < n && pool.length) out.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
    return out;
  }
  async function awardWinners(id, g, winners) {
    for (const w of winners) {
      const code = makeCode(g.cosmetic, `giveaway ${id}`);
      g.codes[w] = code;
      try {
        const u = await client.users.fetch(w);
        await u.send({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle(t('gwDmTitle')).setDescription(t('codeDmBody', { c: cosmeticLabel(g.cosmetic), code }))] });
      } catch { /* zamknięte DM – zostaje przycisk Odbierz */ }
    }
  }
  async function finishGiveaway(id) {
    const g = cfg().giveaways[id];
    if (!g || g.ended) return;
    g.ended = true;
    g.winners = pickWinners(g, g.count);
    save();
    await awardWinners(id, g, g.winners);
    save();
    try {
      const ch = await client.channels.fetch(g.channelId);
      const msg = await ch.messages.fetch(id);
      await msg.edit({ embeds: [gwEmbed(g)], components: gwComponents(g, true) });
      await msg.reply(g.winners.length
        ? t('gwWinners', { winners: g.winners.map((w) => `<@${w}>`).join(', '), c: cosmeticLabel(g.cosmetic) })
        : t('gwNoWinner', { c: cosmeticLabel(g.cosmetic) }));
    } catch (e) { console.error('[discord] giveaway:', e.message); }
  }
  async function cmdGiveawayEnd(i) {
    const id = i.options.getString('message_id', true).trim();
    const g = cfg().giveaways[id];
    if (!g) return reply(i, t('gwNotFound'));
    if (g.ended) return reply(i, t('gwOver'));
    g.endsAt = Date.now();
    await i.deferReply({ ephemeral: true });
    await finishGiveaway(id);
    return i.editReply(t('gwEndedNow'));
  }
  async function cmdGiveawayReroll(i) {
    const id = i.options.getString('message_id', true).trim();
    const g = cfg().giveaways[id];
    if (!g) return reply(i, t('gwNotFound'));
    if (!g.ended) return reply(i, t('gwNotFound'));
    await i.deferReply({ ephemeral: true });
    const fresh = pickWinners(g, g.count, [...g.winners, ...(g.rerolled || [])]);
    g.rerolled = [...(g.rerolled || []), ...g.winners];
    g.winners = fresh;
    await awardWinners(id, g, fresh);
    save();
    try {
      const ch = await client.channels.fetch(g.channelId);
      const msg = await ch.messages.fetch(id);
      await msg.edit({ embeds: [gwEmbed(g)], components: gwComponents(g, true) });
      if (fresh.length) await msg.reply(t('gwWinners', { winners: fresh.map((w) => `<@${w}>`).join(', '), c: cosmeticLabel(g.cosmetic) }));
    } catch { /* ignore */ }
    return i.editReply(t('gwRerolled', { w: fresh.length ? fresh.map((w) => `<@${w}>`).join(', ') : t('gwNoEntries') }));
  }
  async function btnGiveaway(i, act) {
    const g = cfg().giveaways[i.message.id];
    if (!g) return reply(i, t('gwOver'));
    if (act === 'join') {
      if (g.ended || Date.now() >= g.endsAt) return reply(i, t('gwOver'));
      const k = g.entrants.indexOf(i.user.id);
      if (k >= 0) g.entrants.splice(k, 1); else g.entrants.push(i.user.id);
      dirtyGw.add(i.message.id);
      save();
      return reply(i, k >= 0 ? t('gwLeft') : t('gwJoined'));
    }
    if (act === 'claim') {
      const code = g.codes?.[i.user.id];
      if (!code || !g.winners.includes(i.user.id)) return reply(i, t('gwNotWinner'));
      return reply(i, t('gwClaimCode', { c: cosmeticLabel(g.cosmetic), code }));
    }
  }
  async function giveawayTick() {
    const all = cfg().giveaways;
    for (const [id, g] of Object.entries(all)) {
      if (!g.ended && Date.now() >= g.endsAt) await finishGiveaway(id);
      // stare zakończone giveawaye sprzątamy po 30 dniach
      if (g.ended && Date.now() - g.endsAt > 30 * 864e5) { delete all[id]; save(); }
    }
    for (const id of dirtyGw) {
      dirtyGw.delete(id);
      const g = all[id];
      if (!g || g.ended) continue;
      try {
        const ch = await client.channels.fetch(g.channelId);
        const msg = await ch.messages.fetch(id);
        await msg.edit({ components: gwComponents(g) });
      } catch { /* ignore */ }
    }
  }

  // ---------------- ogłoszenia nowych wersji ----------------
  /** Sprawdza najnowszy release na GitHubie i ogłasza go. force = ogłoś nawet jeśli już był. Zwraca opis wyniku. */
  async function releaseTick(force = false) {
    const chId = cfg().channels.updates;
    if (!chId) return { ok: false, error: 'Nie ustawiono kanału ogłoszeń nowych wersji.' };
    try {
      const headers = { 'user-agent': 'GruzClientBot', accept: 'application/vnd.github+json' };
      if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const r = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, { headers });
      if (!r.ok) {
        const msg = `GitHub ${r.status}${r.status === 403 || r.status === 429 ? ' – limit zapytań, ustaw GITHUB_TOKEN na Renderze' : r.status === 404 ? ' – brak opublikowanego release' : ''}`;
        console.error('[discord] aktualizacje:', msg);
        return { ok: false, error: msg };
      }
      const rel = await r.json();
      if (!rel.tag_name) return { ok: false, error: 'Brak release na GitHubie.' };
      if (!force && rel.tag_name === cfg().lastRelease) return { ok: true, skipped: rel.tag_name };
      const exe = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
      let notes = String(rel.body || '').trim().replace(/\r/g, '').slice(0, 3500);
      // pusty opis release (albo samo „bug fixes”) – bierzemy listę zmian z gruzclient.com/changelog.json
      if (!notes || /^(bug ?fixes|poprawki)/i.test(notes)) notes = (await changelogNotes(rel.tag_name)) || notes || t('relNoNotes');
      const ch = await client.channels.fetch(chId);
      const e = new EmbedBuilder().setColor(COLOR).setTitle(t('relTitle', { v: rel.tag_name })).setURL(rel.html_url)
        .setDescription(notes).setThumbnail('attachment://logo.png').setFooter({ text: t('relFooter') })
        .setTimestamp(new Date(rel.published_at || Date.now()));
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t('relDownload')).setEmoji('⬇️').setURL(exe?.browser_download_url || rel.html_url));
      await ch.send({ embeds: [e], components: [row], files: [logoFile()] });
      // dopiero po udanym wysłaniu – inaczej przy błędzie (np. brak uprawnień) wersja przepadała
      cfg().lastRelease = rel.tag_name;
      save();
      return { ok: true, posted: rel.tag_name };
    } catch (e) {
      const msg = e.code === 50013 || e.code === 50001 ? 'Bot nie ma uprawnień na kanale ogłoszeń (Wyświetl kanał, Wysyłaj wiadomości, Osadzaj linki, Załączaj pliki).' : e.message;
      console.error('[discord] aktualizacje:', msg);
      return { ok: false, error: msg };
    }
  }

  /** Lista zmian danej wersji z changelog.json (w języku bota) albo null */
  async function changelogNotes(tag) {
    try {
      const v = String(tag || '').replace(/^v/i, '');
      const r = await fetch(CHANGELOG_URL, { headers: { 'user-agent': 'GruzClientBot' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      const list = await r.json();
      const entry = Array.isArray(list) && list.find((x) => x.version === v);
      if (!entry) return null;
      const c = entry[cfg().lang === 'pl' ? 'pl' : 'en'] || entry.en;
      const lines = [c.title ? `**${c.title}**` : '', c.lead || '', ...(c.items || []).map((x) => `• ${x}`)].filter(Boolean);
      return (lines.join('\n') + `\n\n[${t('relAll')}](${SITE}/changelog)`).slice(0, 3800);
    } catch { return null; }
  }

  // ---------------- nowości i promocje w sklepie (Tebex) ----------------
  // Co 15 minut porównujemy pakiety z Tebexa z zapamiętanymi. Nowy pakiet albo nowa promocja = post z obrazkiem
  // i przyciskiem BUY NOW (gruzclient.com/cosmetics). Przy pierwszym sprawdzeniu tylko zapamiętujemy (bez spamu).
  async function shopTick() {
    const chId = cfg().channels.shop;
    const token = (process.env.TEBEX_PUBLIC_TOKEN || db.shop?.token || '').trim();
    if (!chId || !token) return;
    try {
      const r = await fetch(`https://headless.tebex.io/api/accounts/${encodeURIComponent(token)}/packages`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return;
      const list = (await r.json()).data || [];
      const c = cfg();
      const first = !c.shopSeen;
      const seen = c.shopSeen || {};
      const posts = [];
      for (const p of list) {
        const off = p.base_price > 0 && p.discount > 0 ? Math.round((p.discount / p.base_price) * 100) : 0;
        const was = seen[p.id];
        if (!first && !was) posts.push({ p, kind: 'new', off });
        else if (!first && was && off >= 5 && off !== was.off) posts.push({ p, kind: 'sale', off });
        seen[p.id] = { off, at: was?.at || Date.now() };
      }
      c.shopSeen = seen;
      save();
      if (!posts.length) return;
      const ch = await client.channels.fetch(chId);
      for (const { p, kind, off } of posts.slice(0, 5)) {
        const key = ctx.codePackages?.[p.id];
        const url = `${SITE}/cosmetics${key ? '#' + (key === 'pass:premium' ? 'pass' : key) : ''}`;
        const price = new Intl.NumberFormat(cfg().lang === 'pl' ? 'pl-PL' : 'en-GB', { style: 'currency', currency: p.currency || 'EUR' }).format(p.total_price ?? p.base_price);
        const desc = String(p.description || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0] || '';
        const e = new EmbedBuilder().setColor(kind === 'sale' ? 0xff7a1a : COLOR).setURL(url)
          .setTitle(t(kind === 'sale' ? 'shopSaleTitle' : 'shopNewTitle', { name: p.name, off }))
          .setDescription(`${desc}\n\n**${price}**${kind === 'sale' ? ` ~~${new Intl.NumberFormat(cfg().lang === 'pl' ? 'pl-PL' : 'en-GB', { style: 'currency', currency: p.currency || 'EUR' }).format(p.base_price)}~~` : ''}\n${t('shopHow')}`)
          .setFooter({ text: 'gruzclient.com/cosmetics' });
        if (p.image) e.setImage(p.image);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('BUY NOW').setEmoji('🛒').setURL(url));
        await ch.send({ embeds: [e], components: [row] });
      }
    } catch (e) {
      console.error('[discord] sklep:', e.code === 50013 || e.code === 50001 ? 'brak uprawnień na kanale sklepu' : e.message);
    }
  }

  // ---------------- tickety ----------------
  const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'x';

  function ticketPanel(title, text) {
    const tk = cfg().tickets;
    const e = new EmbedBuilder().setColor(COLOR).setTitle(title || t('tkPanelTitle')).setDescription(text || t('tkPanelText'))
      .setThumbnail('attachment://logo.png');
    const menu = new StringSelectMenuBuilder().setCustomId('tk:open').setPlaceholder(t('tkPlaceholder'))
      .addOptions(tk.categories.map((c) => ({ label: c.name, value: c.id, description: c.description.slice(0, 100), ...(c.emoji ? { emoji: c.emoji } : {}) })));
    return { embeds: [e], components: [new ActionRowBuilder().addComponents(menu)] };
  }
  async function refreshPanels() {
    const tk = cfg().tickets;
    if (!tk.categories.length) return;
    const keep = [];
    for (const p of tk.panels) {
      try {
        const ch = await client.channels.fetch(p.c);
        const msg = await ch.messages.fetch(p.m);
        await msg.edit(ticketPanel(p.title, p.text));
        keep.push(p);
      } catch { /* panel usunięty */ }
    }
    tk.panels = keep;
    save();
  }
  function parseEmoji(s) {
    if (!s) return null;
    const m = /^<a?:(\w+):(\d+)>$/.exec(s.trim());
    if (m) return { name: m[1], id: m[2] };
    return /\p{Extended_Pictographic}/u.test(s) ? s.trim().slice(0, 8) : null;
  }

  async function cmdTickets(i, sub) {
    const tk = cfg().tickets;
    if (sub === 'add-category') {
      if (tk.categories.length >= 25) return reply(i, t('tkCatLimit'));
      const name = i.options.getString('name', true).trim();
      const id = slug(name);
      if (tk.categories.some((c) => c.id === id)) return reply(i, t('tkCatExists'));
      tk.categories.push({ id, name, description: i.options.getString('description', true).trim(), emoji: parseEmoji(i.options.getString('emoji')), question: i.options.getString('question')?.trim() || '' });
      save();
      await i.deferReply({ ephemeral: true });
      await refreshPanels();
      return i.editReply(t('tkCatAdded', { n: name }));
    }
    if (sub === 'remove-category') {
      const v = i.options.getString('name', true);
      const c = tk.categories.find((x) => x.id === v || x.name.toLowerCase() === v.toLowerCase());
      if (!c) return reply(i, t('tkCatMissing', { n: v }));
      tk.categories = tk.categories.filter((x) => x !== c);
      save();
      await i.deferReply({ ephemeral: true });
      await refreshPanels();
      return i.editReply(t('tkCatRemoved', { n: c.name }));
    }
    if (sub === 'staff-role') {
      const role = i.options.getRole('role', true);
      tk.staffRole = role.id;
      save();
      return reply(i, t('tkStaffSet', { r: `${role}` }));
    }
    if (sub === 'list') {
      const list = tk.categories.map((c) => `${c.emoji ? (typeof c.emoji === 'string' ? c.emoji : `<:${c.emoji.name}:${c.emoji.id}>`) + ' ' : ''}**${c.name}** – ${c.description}${c.question ? ` _(${c.question})_` : ''}`).join('\n') || t('none');
      return reply(i, t('tkList', { list, r: tk.staffRole ? `<@&${tk.staffRole}>` : t('none') }));
    }
    if (sub === 'panel') {
      if (!tk.categories.length) return reply(i, t('tkNoCats'));
      const ch = i.options.getChannel('channel') || i.channel;
      const title = i.options.getString('title') || '', text = (i.options.getString('text') || '').replace(/\\n/g, '\n');
      const msg = await ch.send({ ...ticketPanel(title, text), files: [logoFile()] });
      tk.panels.push({ c: ch.id, m: msg.id, title, text });
      save();
      return reply(i, t('tkPanelSent', { ch: `${ch}` }));
    }
  }

  async function selectTicket(i) {
    const c = cfg().tickets.categories.find((x) => x.id === i.values[0]);
    if (!c) return reply(i, t('tkNoCats'));
    const modal = new ModalBuilder().setCustomId('tk:modal:' + c.id).setTitle(t('tkModalTitle', { n: c.name }).slice(0, 45))
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nick').setLabel(t('tkNick')).setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(16).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('desc').setLabel((c.question || t('tkDesc')).slice(0, 45)).setStyle(TextInputStyle.Paragraph).setMinLength(5).setMaxLength(1500).setRequired(true)),
      );
    await i.showModal(modal);
    // reset wyboru w menu, żeby można było wybrać tę samą kategorię jeszcze raz
    i.message.edit(ticketPanel(...(() => { const p = cfg().tickets.panels.find((x) => x.m === i.message.id); return p ? [p.title, p.text] : []; })())).catch(() => {});
  }

  async function ticketParent(guild) {
    const tk = cfg().tickets;
    let parent = tk.parentId && (await guild.channels.fetch(tk.parentId).catch(() => null));
    if (!parent) {
      parent = await guild.channels.create({
        name: '🎫 Tickets', type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [P.ViewChannel] }, { id: client.user.id, allow: [P.ViewChannel, P.ManageChannels, P.SendMessages] }],
      });
      tk.parentId = parent.id;
      save();
    }
    return parent;
  }

  async function submitTicket(i, catId) {
    const tk = cfg().tickets;
    const c = tk.categories.find((x) => x.id === catId);
    if (!c) return reply(i, t('tkNoCats'));
    const mine = Object.entries(tk.open).filter(([, v]) => v.user === i.user.id);
    if (mine.length >= 3) return reply(i, t('tkTooMany', { n: mine.length, list: mine.map(([id]) => `<#${id}>`).join(', ') }));
    if (!i.guild.members.me.permissions.has(P.ManageChannels)) return reply(i, t('noPerm', { perm: 'Manage Channels' }));
    await i.deferReply({ ephemeral: true });
    const nick = i.fields.getTextInputValue('nick').trim().replace(/[^\w]/g, '').slice(0, 16) || '?';
    const desc = i.fields.getTextInputValue('desc').trim();
    const num = ++tk.counter;
    const parent = await ticketParent(i.guild);
    const allowUser = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
    const overwrites = [
      { id: i.guild.roles.everyone.id, deny: [P.ViewChannel] },
      { id: i.user.id, allow: allowUser },
      { id: client.user.id, allow: [...allowUser, P.ManageChannels, P.ManageMessages] },
    ];
    if (tk.staffRole) overwrites.push({ id: tk.staffRole, allow: [...allowUser, P.ManageMessages] });
    const ch = await i.guild.channels.create({
      name: `${String(num).padStart(4, '0')}-${slug(c.name).slice(0, 12)}-${slug(nick)}`, type: ChannelType.GuildText, parent: parent.id,
      topic: `${c.name} · ${i.user.tag} · ${nick}`, permissionOverwrites: overwrites,
    });
    tk.open[ch.id] = { num, user: i.user.id, cat: c.id, catName: c.name, nick, at: Date.now() };
    save();
    const gu = findUser(nick);
    const emoji = c.emoji ? (typeof c.emoji === 'string' ? c.emoji : `<:${c.emoji.name}:${c.emoji.id}>`) : '🎫';
    const e = new EmbedBuilder().setColor(COLOR).setTitle(t('tkOpenedTitle', { e: emoji, n: c.name, num }))
      .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(nick)}/96`)
      .addFields(
        { name: t('tk.f.user'), value: `${i.user}`, inline: true },
        { name: t('tk.f.nick'), value: `\`${nick}\``, inline: true },
        { name: t('tk.f.gruz'), value: gu ? t('tkGruzYes', { lv: ctx.levelOf(gu).level, h: hoursText(gu.stats?.totalMs) }) : t('tkGruzNo'), inline: true },
        { name: c.question || t('tk.f.desc'), value: desc.slice(0, 1024) },
      ).setTimestamp(new Date());
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tk:claim').setLabel(t('tkClaim')).setEmoji('🙋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('tk:close').setLabel(t('tkClose')).setEmoji('🔒').setStyle(ButtonStyle.Danger),
    );
    await ch.send({
      content: t('tkWelcome', { user: `${i.user}`, staff: tk.staffRole ? `<@&${tk.staffRole}>` : '@admin' }),
      embeds: [e], components: [row], allowedMentions: { users: [i.user.id], roles: tk.staffRole ? [tk.staffRole] : [] },
    });
    return i.editReply(t('tkCreated', { ch: `${ch}` }));
  }

  async function transcript(ch) {
    const all = [];
    let before;
    for (let k = 0; k < 10; k++) {
      const batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!batch.size) break;
      all.push(...batch.values());
      before = batch.last().id;
      if (batch.size < 100) break;
    }
    all.reverse();
    const lines = all.map((m) => {
      const when = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 16);
      const body = [m.content, ...m.embeds.map((e) => [e.title, e.description, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join(' | ')), ...m.attachments.map((a) => a.url)].filter(Boolean).join('\n    ');
      return `[${when}] ${m.author.tag}: ${body}`;
    });
    return { text: lines.join('\n'), count: all.length };
  }

  async function btnTicket(i, act) {
    const tk = cfg().tickets;
    const rec = tk.open[i.channelId];
    if (!rec) return reply(i, t('tkNotTicket'));
    if (act === 'claim') {
      if (!isStaff(i)) return reply(i, t('tkStaffOnly'));
      rec.claimedBy = i.user.id;
      save();
      const e = EmbedBuilder.from(i.message.embeds[0]);
      const fields = (e.data.fields || []).filter((f) => f.name !== t('tk.f.claimed'));
      e.setFields(...fields, { name: t('tk.f.claimed'), value: `${i.user}`, inline: true });
      await i.update({ embeds: [e] });
      return i.channel.send(t('tkClaimed', { user: `${i.user}` }));
    }
    if (act === 'close') {
      if (!isStaff(i) && i.user.id !== rec.user) return reply(i, t('tkStaffOnly'));
      await i.reply(t('tkClosing'));
      delete tk.open[i.channelId];
      save();
      const ch = i.channel;
      let tr = { text: '', count: 0 };
      try { tr = await transcript(ch); } catch { /* ignore */ }
      const file = () => new AttachmentBuilder(Buffer.from(tr.text, 'utf8'), { name: `ticket-${rec.num}.txt` });
      await logTo({
        embeds: [new EmbedBuilder().setColor(0x5a5a6e).setTitle(t('tkLogTitle', { num: rec.num })).addFields(
          { name: t('tk.f.user'), value: `<@${rec.user}>`, inline: true },
          { name: t('tk.f.closedBy'), value: `${i.user}`, inline: true },
          { name: t('tk.f.category'), value: rec.catName || rec.cat, inline: true },
          { name: t('tk.f.nick'), value: `\`${rec.nick}\``, inline: true },
          { name: t('tk.f.messages'), value: String(tr.count), inline: true },
          ...(rec.claimedBy ? [{ name: t('tk.f.claimed'), value: `<@${rec.claimedBy}>`, inline: true }] : []),
        ).setTimestamp(new Date())],
        files: [file()],
      });
      try {
        const u = await client.users.fetch(rec.user);
        await u.send({ content: t('tkDmClosed', { num: rec.num, n: rec.catName || rec.cat, g: i.guild.name }), files: [file()] });
      } catch { /* DM zamknięte */ }
      setTimeout(() => ch.delete(`ticket #${rec.num} closed by ${i.user.tag}`).catch(() => {}), 5000);
    }
  }

  // ---------------- weryfikacja (captcha) ----------------
  const vfPending = new Map(); // userId -> { code, at, tries }
  const vfAttempts = new Map(); // userId -> [czasy]

  async function cmdVerifyPanel(i) {
    const role = i.options.getRole('role', true);
    const me = i.guild.members.me;
    if (!me.permissions.has(P.ManageRoles)) return reply(i, t('noPerm', { perm: 'Manage Roles' }));
    if (role.position >= me.roles.highest.position || role.managed) return reply(i, t('vfRoleHigh', { r: `${role}` }));
    const v = cfg().verify;
    v.roleId = role.id;
    v.minAge = i.options.getInteger('min_account_age_days') || 0;
    save();
    const ch = i.options.getChannel('channel') || i.channel;
    const e = new EmbedBuilder().setColor(COLOR).setTitle(t('vfTitle')).setDescription(t('vfText')).setThumbnail('attachment://logo.png');
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('vf:start').setLabel(t('vfButton')).setEmoji('✅').setStyle(ButtonStyle.Success));
    await ch.send({ embeds: [e], components: [row], files: [logoFile()] });
    return reply(i, t('vfPanelSent', { ch: `${ch}`, r: `${role}` }));
  }

  async function btnVerify(i, act) {
    const v = cfg().verify;
    if (!v.roleId) return reply(i, t('err'));
    if (i.member.roles.cache.has(v.roleId)) return reply(i, t('vfAlready'));
    if (act === 'start') {
      if (v.minAge && Date.now() - i.user.createdTimestamp < v.minAge * 864e5) return reply(i, t('vfTooNew', { d: v.minAge }));
      const times = (vfAttempts.get(i.user.id) || []).filter((x) => Date.now() - x < 10 * 6e4);
      if (times.length >= 5) return reply(i, t('vfSlow'));
      times.push(Date.now());
      vfAttempts.set(i.user.id, times);
      const code = images.newCode(6);
      vfPending.set(i.user.id, { code, at: Date.now(), tries: 0 });
      const png = await images.captcha(code);
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('vf:enter').setLabel(t('vfEnter')).setEmoji('⌨️').setStyle(ButtonStyle.Primary));
      return i.reply({ content: t('vfCaptcha'), files: [new AttachmentBuilder(png, { name: 'verify.png' })], components: [row], ephemeral: true });
    }
    if (act === 'enter') {
      const p = vfPending.get(i.user.id);
      if (!p || Date.now() - p.at > 5 * 6e4 || p.tries >= 3) return reply(i, t('vfExpired'));
      return i.showModal(new ModalBuilder().setCustomId('vf:modal').setTitle(t('vfModalTitle'))
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('code').setLabel(t('vfModalLabel')).setStyle(TextInputStyle.Short).setMinLength(4).setMaxLength(10).setRequired(true))));
    }
  }

  async function submitVerify(i) {
    const v = cfg().verify;
    const p = vfPending.get(i.user.id);
    if (!p || Date.now() - p.at > 5 * 6e4 || p.tries >= 3) { vfPending.delete(i.user.id); return reply(i, t('vfExpired')); }
    const given = i.fields.getTextInputValue('code').trim().toUpperCase().replace(/\s/g, '').replace(/0/g, 'O').replace(/1/g, 'I');
    const want = p.code.replace(/0/g, 'O').replace(/1/g, 'I');
    if (given !== want) {
      p.tries++;
      if (p.tries >= 3) { vfPending.delete(i.user.id); return reply(i, t('vfExpired')); }
      return reply(i, t('vfWrong', { n: 3 - p.tries }));
    }
    vfPending.delete(i.user.id);
    try {
      await i.member.roles.add(v.roleId, 'Gruz captcha');
    } catch {
      return reply(i, t('vfRoleHigh', { r: `<@&${v.roleId}>` }));
    }
    logTo({ content: t('vfLog', { user: `${i.user} (${i.user.tag})` }), allowedMentions: { parse: [] } });
    return reply(i, t('vfOk'));
  }

  // ---------------- wipe ----------------
  const wipePending = new Map();
  function keptChannels(guild) {
    const keep = new Set();
    for (const id of [statusChannel(), cfg().channels.updates, cfg().channels.logs, cfg().channels.crashes, cfg().channels.ranking]) {
      const c = id && guild.channels.cache.get(id);
      if (!c) continue;
      keep.add(c.id);
      if (c.parentId) keep.add(c.parentId);
    }
    return keep;
  }
  async function cmdWipe(i) {
    if (!statusChannel() || !i.guild.channels.cache.has(statusChannel())) return reply(i, t('wipeNeedList'));
    if (!i.guild.members.me.permissions.has(P.ManageChannels)) return reply(i, t('noPerm', { perm: 'Manage Channels' }));
    await i.guild.channels.fetch();
    const keep = keptChannels(i.guild);
    const n = i.guild.channels.cache.filter((c) => !keep.has(c.id) && !c.isThread()).size;
    const id = crypto.randomBytes(6).toString('hex');
    wipePending.set(id, { user: i.user.id, at: Date.now() });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`wipe:yes:${id}`).setLabel(t('wipeYes', { n })).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`wipe:no:${id}`).setLabel(t('wipeNo')).setStyle(ButtonStyle.Secondary),
    );
    return i.reply({ content: t('wipeConfirm', { n, ch: [...keep].filter((k) => i.guild.channels.cache.get(k)?.type !== ChannelType.GuildCategory).map((k) => `<#${k}>`).join(', ') }), components: [row], ephemeral: true });
  }
  async function btnWipe(i, answer, id) {
    const p = wipePending.get(id);
    wipePending.delete(id);
    if (!p || p.user !== i.user.id || Date.now() - p.at > 120_000) return i.update({ content: t('wipeExpired'), components: [] });
    if (answer !== 'yes') return i.update({ content: t('wipeCancel'), components: [] });
    await i.update({ content: t('wipeWorking'), components: [] });
    await i.guild.channels.fetch();
    const keep = keptChannels(i.guild);
    const targets = [...i.guild.channels.cache.values()].filter((c) => !keep.has(c.id) && !c.isThread());
    targets.sort((a, b) => (a.type === ChannelType.GuildCategory) - (b.type === ChannelType.GuildCategory));
    let ok = 0;
    const failed = [];
    for (const c of targets) {
      try { await c.delete(`wipe by ${i.user.tag}`); ok++; } catch { failed.push(`#${c.name}`); }
    }
    // tickety i panele z usuniętych kanałów nie istnieją
    const tk = cfg().tickets;
    for (const chId of Object.keys(tk.open)) if (!i.guild.channels.cache.has(chId)) delete tk.open[chId];
    if (tk.parentId && !i.guild.channels.cache.has(tk.parentId)) tk.parentId = null;
    save();
    try {
      const ch = await client.channels.fetch(statusChannel());
      await ch.send({ content: `${i.user} ` + t('wipeDone', { n: ok }) + (failed.length ? t('wipeFailed', { list: failed.slice(0, 20).join(', ') }) : '') });
    } catch { /* ignore */ }
  }

  // ---------------- config ----------------
  async function cmdConfig(i, sub) {
    const c = cfg();
    if (sub === 'language') {
      c.lang = i.options.getString('language', true);
      save();
      return reply(i, t('cfgLang'));
    }
    if (sub === 'partner-role') {
      const role = i.options.getRole('role', true);
      c.partnerRoles ||= [];
      const had = c.partnerRoles.includes(role.id);
      c.partnerRoles = had ? c.partnerRoles.filter((x) => x !== role.id) : [...c.partnerRoles, role.id];
      save();
      return reply(i, t(had ? 'cfgPartnerOff' : 'cfgPartnerOn', { r: `${role}`, list: c.partnerRoles.map((x) => `<@&${x}>`).join(', ') || t('none') }));
    }
    if (sub === 'member-role') {
      const role = i.options.getRole('role', true);
      const me = i.guild.members.me;
      if (!me.permissions.has(P.ManageRoles)) return reply(i, t('noPerm', { perm: 'Manage Roles' }));
      if (role.position >= me.roles.highest.position || role.managed) return reply(i, t('vfRoleHigh', { r: `${role}` }));
      c.memberRole = role.id;
      save();
      return reply(i, t('cfgMemberRole', { r: `${role}` }));
    }
    const ch = i.options.getChannel('channel', true);
    const key = { 'status-channel': 'status', 'updates-channel': 'updates', 'logs-channel': 'logs', 'crashes-channel': 'crashes', 'ranking-channel': 'ranking', 'shop-channel': 'shop' }[sub];
    c.channels[key] = ch.id;
    if (key === 'status') statusMsg = null;
    if (key === 'updates') c.lastRelease = c.lastRelease || null;
    save();
    if (key === 'status') updateStatus();
    if (key === 'updates') releaseTick();
    if (key === 'shop') shopTick();
    return reply(i, t('cfgChannel', { what: t('cfg.' + key), ch: `${ch}` }));
  }

  // ---------------- łączenie konta Minecraft ----------------
  const linkedUuid = (discordId) => cfg().links?.[discordId] || null;

  async function cmdLink(i) {
    const code = i.options.getString('code', true).trim().toUpperCase();
    const uuid = ctx.consumeLinkCode(code);
    const u = uuid && db.users[uuid];
    if (!u) return reply(i, t('linkBad'));
    const c = cfg();
    c.links ||= {};
    // jedno konto Minecraft = jedno konto Discord
    for (const [did, uid] of Object.entries(c.links)) if (uid === uuid && did !== i.user.id) delete c.links[did];
    c.links[i.user.id] = uuid;
    u.discord = { id: i.user.id, tag: i.user.tag, at: Date.now() };
    // jednorazowe XP za pierwsze połączenie (liczy się też do Gruz Pass)
    let xpNote = '';
    if (!u.linkXp) { u.linkXp = true; u.bonusXp = (u.bonusXp || 0) + LINK_XP; xpNote = t('linkXp', { xp: LINK_XP }); ctx.updateBadges?.(uuid); }
    save();
    ctx.pushMe?.(uuid);
    let roleNote = '';
    if (c.memberRole && i.inGuild()) {
      try { await i.member.roles.add(c.memberRole, 'Gruz account linked'); roleNote = t('linkRole', { r: `<@&${c.memberRole}>` }); }
      catch { roleNote = t('vfRoleHigh', { r: `<@&${c.memberRole}>` }); }
    }
    logTo({ content: t('linkLog', { user: `${i.user} (${i.user.tag})`, nick: u.name }), allowedMentions: { parse: [] } });
    applyLevelRole(uuid).catch(() => {});
    return i.reply({ embeds: [profileEmbed(u).setAuthor({ name: t('linkOk', { nick: u.name }) })], content: [xpNote, roleNote].filter(Boolean).join('\n') || undefined, ephemeral: true });
  }

  async function cmdUnlink(i) {
    const c = cfg();
    const uuid = linkedUuid(i.user.id);
    if (!uuid) return reply(i, t('linkNone'));
    delete c.links[i.user.id];
    if (db.users[uuid]) { delete db.users[uuid].discord; ctx.pushMe?.(uuid); }
    save();
    if (c.memberRole && i.inGuild()) i.member.roles.remove(c.memberRole, 'Gruz account unlinked').catch(() => {});
    if (i.inGuild()) for (const x of levelRoles()) i.member.roles.remove(x.roleId, 'Gruz account unlinked').catch(() => {});
    return reply(i, t('unlinkOk'));
  }

  // ---------------- raporty crashy z launchera ----------------
  ctx.onCrash?.(async (r) => {
    const chId = cfg().channels.crashes;
    if (!chId) return;
    try {
      const ch = await client.channels.fetch(chId);
      const discordId = Object.entries(cfg().links || {}).find(([, uid]) => uid === r.uuid)?.[0];
      const e = new EmbedBuilder().setColor(RED).setTitle(`💥 ${r.title || 'Crash'}`.slice(0, 250))
        .setThumbnail(`https://mc-heads.net/avatar/${r.uuid}/64`)
        .addFields(
          { name: 'Player', value: `\`${r.name}\`${discordId ? ` · <@${discordId}>` : ''}`, inline: true },
          { name: 'Minecraft', value: `${r.mc || '?'} ${r.loader || ''}`.trim(), inline: true },
          { name: 'Gruz', value: `launcher ${r.launcher || '?'} · mod ${r.mod || '-'}`, inline: true },
          { name: 'Type', value: r.kind || '?', inline: true },
          ...(r.mods.length ? [{ name: 'Suspected mods', value: r.mods.join(', ').slice(0, 1000) }] : []),
          ...(r.note ? [{ name: 'Player note', value: r.note.slice(0, 1000) }] : []),
          ...(r.excerpt ? [{ name: 'Excerpt', value: '```' + r.excerpt.replace(/```/g, '').slice(0, 900) + '```' }] : []),
        ).setFooter({ text: `report ${r.id}` }).setTimestamp(new Date(r.at));
      if (r.text) e.setDescription(r.text.slice(0, 1000));
      const files = r.log ? [new AttachmentBuilder(Buffer.from(r.log, 'utf8'), { name: `crash-${r.id}.log` })] : [];
      await ch.send({ embeds: [e], files, allowedMentions: { parse: [] } });
    } catch (e) { console.error('[discord] crash:', e.message); }
  });



  // ---------------- "Poproś o pomoc" z launchera: ticket z crashem ----------------
  ctx.onCrashHelp?.(async (r, u) => {
    const g = await guild().catch(() => null);
    if (!g) throw new Error('HELP_NO_BOT');
    const member = await g.members.fetch(u.discord.id).catch(() => null);
    if (!member) throw new Error('HELP_NOT_IN_GUILD');
    if (!g.members.me.permissions.has(P.ManageChannels)) throw new Error('HELP_FAILED');
    const tk = cfg().tickets;
    const mine = Object.entries(tk.open).filter(([, v]) => v.user === member.id);
    if (mine.length >= 3) throw new Error('HELP_TOO_MANY');
    const num = ++tk.counter;
    const parent = await ticketParent(g);
    const allowUser = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
    const overwrites = [
      { id: g.roles.everyone.id, deny: [P.ViewChannel] },
      { id: member.id, allow: allowUser },
      { id: client.user.id, allow: [...allowUser, P.ManageChannels, P.ManageMessages] },
    ];
    if (tk.staffRole) overwrites.push({ id: tk.staffRole, allow: [...allowUser, P.ManageMessages] });
    const ch = await g.channels.create({
      name: `${String(num).padStart(4, '0')}-crash-${slug(u.name)}`, type: ChannelType.GuildText, parent: parent.id,
      topic: `Crash · ${member.user.tag} · ${u.name} · report ${r.id}`, permissionOverwrites: overwrites,
    });
    tk.open[ch.id] = { num, user: member.id, cat: 'crash', catName: 'Crash', nick: u.name, at: Date.now(), report: r.id };
    save();
    const e = new EmbedBuilder().setColor(RED).setTitle(t('tkCrashTitle', { num, title: r.title || 'Crash' }).slice(0, 250))
      .setThumbnail(`https://mc-heads.net/avatar/${r.uuid}/96`)
      .setDescription(r.text ? r.text.slice(0, 1500) : null)
      .addFields(
        { name: t('tk.f.user'), value: `${member}`, inline: true },
        { name: t('tk.f.nick'), value: `\`${u.name}\``, inline: true },
        { name: t('tk.f.gruz'), value: t('tkGruzYes', { lv: ctx.levelOf(u).level, h: hoursText(u.stats?.totalMs) }), inline: true },
        { name: 'Minecraft', value: `${r.mc || '?'} ${r.loader || ''}`.trim(), inline: true },
        { name: 'Gruz', value: `launcher ${r.launcher || '?'} · mod ${r.mod || '-'}`, inline: true },
        { name: t('tkCrashKind'), value: r.kind || '?', inline: true },
        ...(r.mods.length ? [{ name: t('tkCrashMods'), value: r.mods.join(', ').slice(0, 1000) }] : []),
        ...(r.note ? [{ name: t('tkCrashNote'), value: r.note.slice(0, 1000) }] : []),
        ...(r.excerpt ? [{ name: t('tkCrashExcerpt'), value: '```' + r.excerpt.replace(/```/g, '').slice(0, 900) + '```' }] : []),
      ).setFooter({ text: `report ${r.id}` }).setTimestamp(new Date(r.at));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tk:claim').setLabel(t('tkClaim')).setEmoji('🙋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('tk:close').setLabel(t('tkClose')).setEmoji('🔒').setStyle(ButtonStyle.Danger),
    );
    const files = r.log ? [new AttachmentBuilder(Buffer.from(r.log, 'utf8'), { name: `crash-${r.id}.log` })] : [];
    await ch.send({
      content: t('tkCrashWelcome', { user: `${member}`, staff: tk.staffRole ? `<@&${tk.staffRole}>` : '@admin' }),
      embeds: [e], components: [row], files, allowedMentions: { users: [member.id], roles: tk.staffRole ? [tk.staffRole] : [] },
    });
    logTo({ content: t('tkCrashLog', { user: `${member.user.tag}`, nick: u.name, ch: `${ch}` }), allowedMentions: { parse: [] } });
    return { url: `https://discord.com/channels/${g.id}/${ch.id}` };
  });

  // ---------------- /gruz invite: link do party ----------------
  async function cmdInvite(i) {
    const u = db.users[linkedUuid(i.user.id)];
    if (!u) return reply(i, t('linkNone'));
    if (!ctx.online.has(u.uuid)) return reply(i, t('pinvOffline'));
    const link = ctx.partyLink(u.uuid);
    const msg = (i.options.getString('message') || '').replace(/[\r\n]+/g, ' ').trim();
    const p = ctx.presenceOf(u.uuid);
    const e = new EmbedBuilder().setColor(COLOR).setAuthor({ name: t('pinvTitle', { nick: u.name }), iconURL: `https://mc-heads.net/avatar/${u.uuid}/64` })
      .setDescription([msg ? `> ${msg.replace(/[*_`~|>]/g, '')}` : '', t('pinvText', { t: ts(link.expires) }), p.online ? `🟢 ${where(p)}` : ''].filter(Boolean).join('\n\n'))
      .setFooter({ text: t('pinvFoot', { lv: ctx.levelOf(u).level }) });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setEmoji('🎮').setLabel(t('pinvJoin')).setURL(link.url),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setEmoji('⬇️').setLabel(t('evBtnDownload')).setURL(DOWNLOAD));
    return i.reply({ embeds: [e], components: [row], allowedMentions: { parse: [] } });
  }

  // ---------------- role za poziom ----------------
  const levelRoles = () => (cfg().levelRoles || []).slice().sort((a, b) => a.level - b.level);
  const discordOf = (uuid) => Object.entries(cfg().links || {}).find(([, uid]) => uid === uuid)?.[0] || null;
  /** Daje graczowi rolę za jego poziom (najwyższą pasującą; niższe zdejmuje, chyba że włączone "zostaw niższe") */
  async function applyLevelRole(uuid) {
    const list = levelRoles();
    const did = discordOf(uuid);
    const u = db.users[uuid];
    if (!list.length || !did || !u) return false;
    const g = await guild().catch(() => null);
    if (!g) return false;
    const member = await g.members.fetch(did).catch(() => null);
    if (!member) return false;
    const lv = ctx.levelOf(u).level;
    const reached = list.filter((x) => x.level <= lv);
    const want = new Set(cfg().levelStack ? reached.map((x) => x.roleId) : reached.slice(-1).map((x) => x.roleId));
    let changed = false;
    for (const x of list) {
      const has = member.roles.cache.has(x.roleId);
      try {
        if (want.has(x.roleId) && !has) { await member.roles.add(x.roleId, `Gruz level ${lv}`); changed = true; }
        if (!want.has(x.roleId) && has) { await member.roles.remove(x.roleId, `Gruz level ${lv}`); changed = true; }
      } catch (e) { console.error('[discord] rola za poziom:', e.message); }
    }
    return changed;
  }
  ctx.onLevel?.((u, lv, before) => {
    applyLevelRole(u.uuid).then((changed) => {
      if (changed && lv > before) logTo({ content: t('lvLog', { nick: u.name, n: lv }), allowedMentions: { parse: [] } });
    }).catch(() => {});
  });
  let syncing = false;
  async function syncLevelRoles() {
    if (syncing || !levelRoles().length) return 0;
    syncing = true;
    let n = 0;
    try {
      for (const uuid of Object.values(cfg().links || {})) {
        if (await applyLevelRole(uuid).catch(() => false)) n++;
        await new Promise((r) => setTimeout(r, 400));
      }
    } finally { syncing = false; }
    return n;
  }
  async function cmdLevels(i, sub) {
    const c = cfg();
    c.levelRoles ||= [];
    if (sub === 'set') {
      const level = i.options.getInteger('level', true), role = i.options.getRole('role', true);
      const me = i.guild.members.me;
      if (!me.permissions.has(P.ManageRoles)) return reply(i, t('noPerm', { perm: 'Manage Roles' }));
      if (role.position >= me.roles.highest.position || role.managed) return reply(i, t('vfRoleHigh', { r: `${role}` }));
      c.levelRoles = [...c.levelRoles.filter((x) => x.level !== level && x.roleId !== role.id), { level, roleId: role.id }].slice(0, 20);
      save();
      syncLevelRoles().catch(() => {});
      return reply(i, t('lvSet', { n: level, r: `${role}` }));
    }
    if (sub === 'remove') {
      const level = i.options.getInteger('level', true);
      c.levelRoles = c.levelRoles.filter((x) => x.level !== level);
      save();
      return reply(i, t('lvRemoved', { n: level }));
    }
    if (sub === 'sync') {
      await i.deferReply({ ephemeral: true });
      const n = await syncLevelRoles();
      return i.editReply(t('lvSynced', { n }));
    }
    return reply(i, t('lvList', { list: levelRoles().map((x) => t('lvLine', { n: x.level, r: `<@&${x.roleId}>` })).join('\n') || t('none') }));
  }

  // ---------------- ranking tygodniowy ----------------
  function weeklyEmbed(rows, { title, week, cosmetic, places } = {}) {
    const medal = ['🥇', '🥈', '🥉'];
    const e = new EmbedBuilder().setColor(COLOR).setTitle(title || t('wkTitle', { w: week || ctx.weekKey() })).setURL('https://gruzclient.com/top')
      .setDescription(rows.length ? rows.map((r, k) => `${medal[k] || `**${k + 1}.**`} ${r.name.replace(/[*_`~]/g, '\\$&')} · **${r.xp} XP**`).join('\n') : t('wkEmpty'))
      .setThumbnail('attachment://logo.png').setTimestamp(new Date());
    if (cosmetic && places) e.addFields({ name: t('wkReward'), value: t('wkRewardText', { n: places, c: cosmeticLabel(cosmetic) }) });
    e.setFooter({ text: t('wkFoot') });
    return e;
  }
  async function postWeekly(res) {
    const chId = cfg().channels.ranking;
    if (!chId) return;
    try {
      const ch = await client.channels.fetch(chId);
      const mentions = [];
      const lines = res.top.map((r) => { const did = discordOf(r.uuid); if (did && mentions.length < 3) mentions.push(did); return r; });
      const reward = db.promo?.weeklyReward || {};
      const e = weeklyEmbed(lines, { title: t('wkDoneTitle', { w: res.week }), cosmetic: res.cosmetic, places: res.rewarded?.length ? reward.places : 0 });
      const winners = mentions.length ? t('wkCongrats', { users: mentions.map((x) => `<@${x}>`).join(' ') }) : undefined;
      await ch.send({ content: winners, embeds: [e], files: [logoFile()], allowedMentions: { users: mentions } });
    } catch (e) { console.error('[discord] ranking:', e.message); }
  }
  ctx.onWeekly?.((res) => { postWeekly(res); });


  // ---------------- partnerzy i twórcy ----------------
  const PUBLIC_URL = (process.env.GRUZ_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://gruz-server.onrender.com').replace(/\/$/, '');
  const DOWNLOAD = `https://github.com/${RELEASES_REPO}/releases/latest`;
  const isPartner = (i) => isAdmin(i) || (cfg().partnerRoles || []).some((r) => i.member?.roles?.cache?.has(r));
  const creatorOf = (discordId) => Object.values(db.creators || {}).find((c) => c.discordId === discordId) || null;
  const rewardOf = (cr) => cr?.cosmetic || db.promo?.creatorReward || 'cape:nebula';
  const rewardEn = (key) => { const [slot, v] = key.split(':'); return `${cap(v)} ${(SLOT.en[slot] || slot).toLowerCase()}`; };

  async function cmdPartner(i, sub) {
    if (!isPartner(i)) return reply(i, t('pnOnly'));
    db.creators ||= {};
    const mine = creatorOf(i.user.id);
    if (sub === 'set-nick') {
      const nick = i.options.getString('nick', true).trim().replace(/[\n\r]/g, ' ').slice(0, 24);
      const code = ctx.creatorKey(i.options.getString('code') || mine?.code || nick);
      if (code.length < 3) return reply(i, t('pnCodeShort'));
      const taken = db.creators[code];
      if ((taken && taken.discordId !== i.user.id) || db.codes[code]) return reply(i, t('pnCodeTaken', { code }));
      const entry = { code, name: nick, discordId: i.user.id, cosmetic: mine?.cosmetic || null, uses: mine?.uses || [], created: mine?.created || Date.now() };
      if (mine && mine.code !== code) {
        delete db.creators[mine.code];
        for (const u of Object.values(db.users)) if (u.referredBy === mine.code) u.referredBy = code;
      }
      db.creators[code] = entry;
      save();
      logTo({ content: t('pnLog', { user: `${i.user}`, nick, code }), allowedMentions: { parse: [] } });
      return i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(COLOR).setTitle(t('pnSetTitle'))
        .setDescription(t('pnSetText', { nick, code, reward: cosmeticLabel(rewardOf(entry)) }))] });
    }
    if (!mine) return reply(i, t('pnNoNick'));
    if (sub === 'stats') {
      const week = Date.now() - 7 * 864e5;
      const users = (mine.uses || []).map((u) => db.users[u]).filter(Boolean);
      const recent = users.filter((u) => (u.firstSeen || 0) > week).length;
      const hours = users.reduce((a, u) => a + (u.stats?.totalMs || 0), 0) / 36e5;
      return i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(COLOR).setTitle(t('pnStatsTitle', { code: mine.code }))
        .addFields(
          { name: t('pnStatsTotal'), value: String(users.length), inline: true },
          { name: t('pnStatsWeek'), value: String(recent), inline: true },
          { name: t('pnStatsHours'), value: hoursText(hours * 36e5), inline: true },
        ).setFooter({ text: t('pnStatsFoot') })] });
    }
    if (sub === 'banners') {
      if (slow(i, 20_000)) return reply(i, t('pnSlow'));
      await i.deferReply({ ephemeral: true });
      let skin = null, slim = false;
      const linked = db.users[linkedUuid(i.user.id)];
      if (linked) {
        try { const p = await images.mojangProfile(linked.name); if (p?.skinUrl) { skin = await images.fetchBuf(p.skinUrl); slim = p.slim; } } catch { /* bez skina */ }
      }
      const reward = 'free ' + rewardEn(rewardOf(mine));
      const list = await images.partnerBanners({ nick: mine.name, code: mine.code, reward, skin, slim });
      const files = list.map((b) => new AttachmentBuilder(b.buffer, { name: b.name }));
      const promoText = t('pnPromoText', { code: mine.code, reward, url: DOWNLOAD });
      const e = new EmbedBuilder().setColor(COLOR).setTitle(t('pnBannersTitle'))
        .setDescription(t('pnBannersText', { list: list.map((b) => `• **${b.title}** – \`${b.name}\``).join('\n') })
          + (linked ? '' : '\n\n' + t('pnNoSkin')))
        .addFields({ name: t('pnPromoField'), value: '```' + promoText + '```' })
        .setImage('attachment://' + list[1].name);
      return i.editReply({ embeds: [e], files });
    }
  }

  // ---------------- eventy ----------------
  const TZ = process.env.GRUZ_TZ || 'Europe/Warsaw';
  function tzOffset(ms) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  }
  function zoned(y, mo, d, h, mi) {
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    let ms = guess - tzOffset(guess);
    ms = guess - tzOffset(ms);
    return ms;
  }
  /** "20:00", "tomorrow 18:30", "05.11 20:00", "2026-11-05 20:00", "in 2h" -> ms albo null */
  function parseWhen(raw) {
    const s = String(raw || '').trim().toLowerCase();
    let m;
    if ((m = /^(?:in|za)\s+(.+)$/.exec(s))) { const d = parseDuration(m[1]); return d ? Date.now() + d : null; }
    const nowP = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date()).map((x) => [x.type, Number(x.value)]));
    if ((m = /^(today|tomorrow|dzi[sś]|jutro)?\s*(\d{1,2})[:.](\d{2})$/.exec(s))) {
      const plus = /tomorrow|jutro/.test(m[1] || '') ? 1 : 0;
      let at = zoned(nowP.year, nowP.month, nowP.day + plus, +m[2], +m[3]);
      if (!m[1] && at < Date.now()) at = zoned(nowP.year, nowP.month, nowP.day + 1, +m[2], +m[3]);
      return at;
    }
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ t](\d{1,2}):(\d{2})$/.exec(s))) return zoned(+m[1], +m[2], +m[3], +m[4], +m[5]);
    if ((m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?\s+(\d{1,2})[:.](\d{2})$/.exec(s))) {
      let at = zoned(m[3] ? +m[3] : nowP.year, +m[2], +m[1], +m[4], +m[5]);
      if (!m[3] && at < Date.now() - 864e5) at = zoned(nowP.year + 1, +m[2], +m[1], +m[4], +m[5]);
      return at;
    }
    return null;
  }
  const joinUrl = (ip) => `${PUBLIC_URL}/join?ip=${encodeURIComponent(ip)}`;
  function eventView(ev) {
    const e = new EmbedBuilder().setColor(ev.cancelled ? RED : COLOR)
      .setTitle(`${ev.cancelled ? '❌' : ev.started ? '🟢' : '📅'} ${ev.title}`)
      .setDescription([ev.cancelled ? `**${t('evCancelled')}**` : '', ev.desc || ''].filter(Boolean).join('\n\n') || null)
      .addFields(
        { name: t('evWhen'), value: `${ts(ev.at, 'F')} · ${ts(ev.at, 'R')}`, inline: false },
        ...(ev.server ? [{ name: t('evServer'), value: '`' + ev.server + '`', inline: true }] : []),
        ...(ev.prize ? [{ name: t('evPrize'), value: ev.prize, inline: true }] : []),
        { name: t('evGoing'), value: String(ev.going.length), inline: true },
      ).setThumbnail('attachment://logo.png').setFooter({ text: t('evFoot') });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ev:go').setStyle(ButtonStyle.Primary).setEmoji('🔔').setLabel(t('evBtnGo', { n: ev.going.length })).setDisabled(!!ev.cancelled || !!ev.ended),
      ...(ev.server ? [new ButtonBuilder().setStyle(ButtonStyle.Link).setEmoji('🎮').setLabel(t('evBtnJoin')).setURL(joinUrl(ev.server))] : []),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setEmoji('⬇️').setLabel(t('evBtnDownload')).setURL(DOWNLOAD));
    return { embeds: [e], components: [row] };
  }
  async function cmdEvent(i, sub) {
    const c = cfg();
    c.events ||= {};
    if (sub === 'cancel') {
      const id = i.options.getString('message_id', true).trim();
      const ev = c.events[id];
      if (!ev) return reply(i, t('evNotFound'));
      ev.cancelled = true;
      save();
      try { const ch = await client.channels.fetch(ev.channelId); const msg = await ch.messages.fetch(id); await msg.edit(eventView(ev)); } catch { /* usunięta */ }
      delete c.events[id];
      save();
      return reply(i, t('evCancelOk'));
    }
    const at = parseWhen(i.options.getString('when', true));
    if (!at || at < Date.now() - 60_000 || at > Date.now() + 90 * 864e5) return reply(i, t('evBadTime'));
    const server = (i.options.getString('server') || '').trim().toLowerCase();
    if (server && !/^[a-z0-9.-]+(:\d{1,5})?$/.test(server)) return reply(i, t('evBadServer'));
    const ch = i.options.getChannel('channel') || i.channel;
    const ping = i.options.getRole('ping');
    const ev = { title: i.options.getString('title', true), desc: i.options.getString('description') || '', prize: i.options.getString('prize') || '',
      server, at, going: [], channelId: ch.id, by: i.user.id, reminded: at - Date.now() < 15 * 60_000, started: false };
    await i.deferReply({ ephemeral: true });
    const msg = await postEvent(ch, ev, ping?.id || null);
    return i.editReply({ content: t('evCreated', { url: msg.url, t: ts(at, 'F') }) });
  }
  async function postEvent(ch, ev, pingRoleId) {
    const c = cfg();
    c.events ||= {};
    Object.assign(ev, { going: ev.going || [], channelId: ch.id, reminded: ev.at - Date.now() < 15 * 60_000, started: false });
    const msg = await ch.send({ content: pingRoleId ? `<@&${pingRoleId}>` : undefined, ...eventView(ev), files: [logoFile()], allowedMentions: { roles: pingRoleId ? [pingRoleId] : [] } });
    ev.id = msg.id;
    c.events[msg.id] = ev;
    save();
    return msg;
  }
  async function btnEvent(i) {
    const ev = cfg().events?.[i.message.id];
    if (!ev || ev.cancelled) return reply(i, t('evNotFound'));
    const had = ev.going.includes(i.user.id);
    ev.going = had ? ev.going.filter((x) => x !== i.user.id) : [...ev.going, i.user.id];
    save();
    await i.update(eventView(ev));
    return i.followUp({ content: had ? t('evLeft') : t('evJoined', { t: ts(ev.at, 'R') }), ephemeral: true });
  }
  async function eventTick() {
    const evs = cfg().events || {};
    for (const ev of Object.values(evs)) {
      const left = ev.at - Date.now();
      try {
        if (!ev.reminded && left <= 15 * 60_000 && left > 0) {
          ev.reminded = true;
          save();
          const ch = await client.channels.fetch(ev.channelId);
          const who = ev.going.slice(0, 60).map((u) => `<@${u}>`).join(' ');
          await ch.send({ content: `${who}\n` + t('evReminder', { title: ev.title, t: ts(ev.at, 'R') }) + (ev.server ? '\n' + t('evServerLine', { s: ev.server }) : ''),
            reply: { messageReference: ev.id, failIfNotExists: false }, allowedMentions: { users: ev.going.slice(0, 60) } });
        }
        if (!ev.started && left <= 0) {
          ev.started = true;
          save();
          const ch = await client.channels.fetch(ev.channelId);
          const row = ev.server ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setEmoji('🎮').setLabel(t('evBtnJoin')).setURL(joinUrl(ev.server)))] : [];
          await ch.send({ content: t('evStarting', { title: ev.title }) + (ev.server ? '\n' + t('evServerLine', { s: ev.server }) : ''), components: row,
            reply: { messageReference: ev.id, failIfNotExists: false }, allowedMentions: { parse: [] } });
          try { const msg = await ch.messages.fetch(ev.id); await msg.edit(eventView(ev)); } catch { /* ignore */ }
        }
        if (left < -6 * 36e5) {
          ev.ended = true;
          try { const ch = await client.channels.fetch(ev.channelId); const msg = await ch.messages.fetch(ev.id); await msg.edit(eventView(ev)); } catch { /* ignore */ }
          delete evs[ev.id];
          save();
        }
      } catch (e) { console.error('[discord] event:', e.message); }
    }
  }


  // ---------------- zaproszenia znajomych ----------------
  const tierLine = (tr) => t('invTier', { n: tr.count, c: cosmeticLabel(tr.cosmetic) });
  function invitesTopText() {
    const top = Object.values(db.users).filter((u) => (u.invited || []).length).sort((a, b) => b.invited.length - a.invited.length).slice(0, 10);
    const medal = ['🥇', '🥈', '🥉'];
    return top.map((u, k) => `${medal[k] || `**${k + 1}.**`} ${u.name} · ${t('invCount', { n: u.invited.length })}`).join('\n') || t('noData');
  }
  function setTiers(list) {
    db.promo ||= {};
    db.promo.inviteTiers = list.filter((x) => ctx.catalog.exists(x.cosmetic)).sort((a, b) => a.count - b.count).slice(0, 12);
    save();
    for (const u of Object.values(db.users)) if ((u.invited || []).length) { ctx.grantInviteRewards(u); ctx.pushMe(u.uuid); }
  }
  async function cmdInvitesAdmin(i, sub) {
    const list = ctx.tiers();
    if (sub === 'set') {
      const count = i.options.getInteger('count', true), cosmetic = i.options.getString('cosmetic', true);
      if (!ctx.catalog.exists(cosmetic)) return reply(i, t('unknownCosmetic'));
      setTiers([...list.filter((x) => x.count !== count), { count, cosmetic }]);
      return reply(i, t('invSet', { line: tierLine({ count, cosmetic }) }));
    }
    if (sub === 'remove') {
      const count = i.options.getInteger('count', true);
      setTiers(list.filter((x) => x.count !== count));
      return reply(i, t('invRemoved', { n: count }));
    }
    if (sub === 'welcome') {
      const c = i.options.getString('cosmetic') || '';
      if (c && !ctx.catalog.exists(c)) return reply(i, t('unknownCosmetic'));
      db.promo ||= {};
      db.promo.inviteWelcome = c;
      save();
      return reply(i, c ? t('invWelcomeSet', { c: cosmeticLabel(c) }) : t('invWelcomeOff'));
    }
    return i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(COLOR).setTitle(t('invAdminTitle'))
      .addFields(
        { name: t('invRewards'), value: ctx.tiers().map(tierLine).join('\n') || t('none') },
        { name: t('invWelcome'), value: db.promo?.inviteWelcome ? cosmeticLabel(db.promo.inviteWelcome) : t('none') },
        { name: t('invTop'), value: invitesTopText() },
      )] });
  }
  function cmdInvites(i) {
    const u = db.users[linkedUuid(i.user.id)];
    const e = new EmbedBuilder().setColor(COLOR).setTitle(t('invTitle'));
    if (u) {
      const count = (u.invited || []).length;
      const next = ctx.tiers().find((x) => x.count > count);
      e.setDescription(t('invYours', { code: ctx.inviteCodeOf(u), n: count })
        + '\n' + (next ? t('invNext', { left: next.count - count, c: cosmeticLabel(next.cosmetic) }) : t('invAllDone')));
    } else e.setDescription(t('invLinkFirst'));
    e.addFields({ name: t('invRewards'), value: ctx.tiers().map(tierLine).join('\n') || t('none') }, { name: t('invTop'), value: invitesTopText() })
      .setFooter({ text: t('invFoot') });
    return i.reply({ embeds: [e], ephemeral: true });
  }
  ctx.onInvite?.(({ inviter, invitee }) => {
    logTo({ content: t('invLog', { a: inviter.name, b: invitee.name, n: inviter.invited.length }), allowedMentions: { parse: [] } });
  });

  // ---------------- API dla panelu w przeglądarce ----------------
  const guild = async () => (guildId ? client.guilds.fetch(guildId) : client.guilds.cache.first()) || null;
  const chName = (id) => { const c = id && client.channels.cache.get(id); return c ? '#' + c.name : null; };
  async function eventFromPanel(b) {
    const at = Number(b.at) || parseWhen(b.when);
    if (!at || at < Date.now() - 60_000 || at > Date.now() + 90 * 864e5) throw new Error('Zła data/godzina eventu.');
    const server = String(b.server || '').trim().toLowerCase();
    if (server && !/^[a-z0-9.-]+(:\d{1,5})?$/.test(server)) throw new Error('Zły adres serwera.');
    if (!String(b.title || '').trim()) throw new Error('Podaj tytuł eventu.');
    const ch = await client.channels.fetch(String(b.channelId || ''));
    if (!ch?.isTextBased()) throw new Error('Wybierz kanał.');
    return postEvent(ch, { title: String(b.title).slice(0, 80), desc: String(b.desc || '').slice(0, 1000), prize: String(b.prize || '').slice(0, 100), server, at, by: 'panel' }, b.pingRoleId || null);
  }
  ctx.registerAdmin?.({
    async info() {
      const g = await guild().catch(() => null);
      const c = cfg();
      let channels = [], roles = [];
      if (g) {
        const chs = await g.channels.fetch();
        channels = [...chs.values()].filter((x) => x && (x.type === ChannelType.GuildText || x.type === ChannelType.GuildAnnouncement))
          .sort((a, b) => a.rawPosition - b.rawPosition).map((x) => ({ id: x.id, name: x.name, parent: x.parent?.name || '' }));
        const rs = await g.roles.fetch();
        roles = [...rs.values()].filter((r) => r.id !== g.id && !r.managed).sort((a, b) => b.position - a.position)
          .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
      }
      return {
        online: !!client.user, tag: client.user?.tag || null, guild: g ? { id: g.id, name: g.name, members: g.memberCount } : null,
        channels, roles, cosmetics: ctx.LOCKED,
        config: { lang: c.lang, channels: c.channels, memberRole: c.memberRole || '', partnerRoles: c.partnerRoles || [], staffRole: c.tickets.staffRole || '',
          verifyRole: c.verify.roleId || '', verifyMinAge: c.verify.minAge || 0, ticketCategories: c.tickets.categories,
          levelRoles: levelRoles(), levelStack: !!c.levelStack },
        events: Object.values(c.events || {}).sort((a, b) => a.at - b.at).map((e) => ({ id: e.id, title: e.title, at: e.at, server: e.server, going: e.going.length, channel: chName(e.channelId) })),
        giveaways: Object.entries(c.giveaways).filter(([, g2]) => !g2.ended).map(([id, g2]) => ({ id, cosmetic: g2.cosmetic, endsAt: g2.endsAt, entrants: g2.entrants.length, channel: chName(g2.channelId) })),
      };
    },
    async setConfig(b) {
      const c = cfg();
      if (b.lang === 'en' || b.lang === 'pl') c.lang = b.lang;
      if (b.channels && typeof b.channels === 'object') {
        for (const k of ['status', 'updates', 'logs', 'crashes', 'ranking', 'shop']) if (k in b.channels) c.channels[k] = String(b.channels[k] || '') || undefined;
        statusMsg = null;
      }
      if ('memberRole' in b) c.memberRole = String(b.memberRole || '') || undefined;
      if (Array.isArray(b.partnerRoles)) c.partnerRoles = b.partnerRoles.map(String).slice(0, 10);
      if ('staffRole' in b) c.tickets.staffRole = String(b.staffRole || '') || undefined;
      if ('levelStack' in b) c.levelStack = !!b.levelStack;
      if (Array.isArray(b.levelRoles)) {
        const seen = new Set();
        c.levelRoles = b.levelRoles.map((x) => ({ level: Math.max(1, Math.min(200, Math.round(Number(x.level) || 0))), roleId: String(x.roleId || '') }))
          .filter((x) => x.level && /^\d{5,25}$/.test(x.roleId) && !seen.has(x.level) && seen.add(x.level)).slice(0, 20);
        syncLevelRoles().catch(() => {});
      }
      save();
      updateStatus();
      if (b.channels?.updates) releaseTick();
      return { ok: true };
    },
    createEvent: async (b) => ({ ok: true, id: (await eventFromPanel(b)).id }),
    async syncLevels() { return { ok: true, changed: await syncLevelRoles() }; },
    async postRanking() {
      const chId = cfg().channels.ranking;
      if (!chId) throw new Error('Najpierw wybierz kanał rankingu i zapisz ustawienia.');
      const ch = await client.channels.fetch(chId);
      const msg = await ch.send({ embeds: [weeklyEmbed(ctx.weeklyTop(10), { cosmetic: db.promo?.weeklyReward?.cosmetic, places: db.promo?.weeklyReward?.places })], files: [logoFile()] });
      return { ok: true, url: msg.url };
    },
    async releaseNow() {
      const r = await releaseTick(true);
      if (!r.ok) throw new Error(r.error);
      return { ok: true, url: 1, posted: r.posted };
    },
    async cancelEvent(id) {
      const ev = cfg().events?.[id];
      if (!ev) throw new Error('Nie ma takiego eventu.');
      ev.cancelled = true;
      try { const ch = await client.channels.fetch(ev.channelId); const msg = await ch.messages.fetch(id); await msg.edit(eventView(ev)); } catch { /* ignore */ }
      delete cfg().events[id];
      save();
      return { ok: true };
    },
    async announce(b) {
      const ch = await client.channels.fetch(String(b.channelId || '')).catch(() => null);
      if (!ch?.isTextBased()) throw new Error('Wybierz kanał.');
      if (!String(b.title || b.text || '').trim()) throw new Error('Wpisz tytuł albo treść.');
      const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? parseInt(b.color.slice(1), 16) : COLOR;
      const e = new EmbedBuilder().setColor(color).setThumbnail('attachment://logo.png');
      if (b.title) e.setTitle(String(b.title).slice(0, 250));
      if (b.text) e.setDescription(String(b.text).slice(0, 4000));
      if (/^https:\/\//.test(b.image || '')) e.setImage(b.image);
      if (/^https:\/\//.test(b.url || '')) e.setURL(b.url);
      const ping = b.ping === 'everyone' ? '@everyone' : b.ping ? `<@&${b.ping}>` : undefined;
      const rows = /^https:\/\//.test(b.buttonUrl || '') ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(String(b.buttonLabel || 'Open').slice(0, 80)).setURL(b.buttonUrl))] : [];
      const msg = await ch.send({ content: ping, embeds: [e], components: rows, files: [logoFile()],
        allowedMentions: b.ping === 'everyone' ? { parse: ['everyone'] } : { roles: b.ping ? [b.ping] : [] } });
      return { ok: true, url: msg.url };
    },
    async postPanel(b) {
      const ch = await client.channels.fetch(String(b.channelId || '')).catch(() => null);
      if (!ch?.isTextBased()) throw new Error('Wybierz kanał.');
      if (b.kind === 'tickets') {
        const tk = cfg().tickets;
        if (!tk.categories.length) throw new Error('Najpierw dodaj kategorie ticketów.');
        const msg = await ch.send({ ...ticketPanel(b.title || '', b.text || ''), files: [logoFile()] });
        tk.panels.push({ c: ch.id, m: msg.id, title: b.title || '', text: b.text || '' });
        save();
        return { ok: true, url: msg.url };
      }
      if (b.kind === 'verify') {
        const g = ch.guild;
        const role = b.roleId && await g.roles.fetch(b.roleId).catch(() => null);
        if (!role) throw new Error('Wybierz rolę dla zweryfikowanych.');
        if (role.position >= g.members.me.roles.highest.position) throw new Error(`Rola bota musi być wyżej niż ${role.name}.`);
        const v = cfg().verify;
        v.roleId = role.id;
        v.minAge = Math.max(0, Math.min(365, Number(b.minAge) || 0));
        save();
        const e = new EmbedBuilder().setColor(COLOR).setTitle(t('vfTitle')).setDescription(t('vfText')).setThumbnail('attachment://logo.png');
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('vf:start').setLabel(t('vfButton')).setEmoji('✅').setStyle(ButtonStyle.Success));
        const msg = await ch.send({ embeds: [e], components: [row], files: [logoFile()] });
        return { ok: true, url: msg.url };
      }
      throw new Error('Nieznany panel.');
    },
    async giveaway(b) {
      if (!ctx.LOCKED.includes(b.cosmetic)) throw new Error('Wybierz kosmetykę.');
      const ms = parseDuration(String(b.duration || ''));
      if (!ms) throw new Error('Zły czas (np. 30m, 24h, 2d).');
      const ch = await client.channels.fetch(String(b.channelId || '')).catch(() => null);
      if (!ch?.isTextBased()) throw new Error('Wybierz kanał.');
      const g = { channelId: ch.id, cosmetic: b.cosmetic, count: Math.max(1, Math.min(20, Number(b.winners) || 1)), endsAt: Date.now() + ms, host: client.user.id, entrants: [], winners: [], codes: {}, ended: false };
      const msg = await ch.send({ embeds: [gwEmbed(g)], components: gwComponents(g), files: [logoFile()] });
      cfg().giveaways[msg.id] = g;
      save();
      return { ok: true, url: msg.url };
    },
    async ticketCategory(b) {
      const tk = cfg().tickets;
      if (b.remove) { tk.categories = tk.categories.filter((x) => x.id !== b.remove); save(); await refreshPanels(); return { ok: true }; }
      const name = String(b.name || '').trim().slice(0, 40), description = String(b.description || '').trim().slice(0, 90);
      if (!name || !description) throw new Error('Podaj nazwę i opis kategorii.');
      if (tk.categories.length >= 25) throw new Error('Maksymalnie 25 kategorii.');
      const id = slug(name);
      if (tk.categories.some((c) => c.id === id)) throw new Error('Taka kategoria już jest.');
      tk.categories.push({ id, name, description, emoji: parseEmoji(b.emoji || ''), question: String(b.question || '').trim().slice(0, 45) });
      save();
      await refreshPanels();
      return { ok: true };
    },
  });

  // ---------------- router ----------------
  const route = async (i) => {
    try {
      if (i.isAutocomplete()) {
        const f = i.options.getFocused(true);
        const q = String(f.value || '').toLowerCase();
        if (f.name === 'cosmetic') {
          const items = [...ctx.LOCKED, ...(ctx.isCodeKey ? ['pass:premium', 'emote:highfive', 'emote:hug', 'emote:duodance', 'plus:30', 'plus:90', 'plus:365'] : [])].map((k) => ({ name: cosmeticLabel(k), value: k }))
            .filter((x) => !q || x.name.toLowerCase().includes(q) || x.value.includes(q));
          return i.respond(items.slice(0, 25));
        }
        if (f.name === 'name') {
          return i.respond(cfg().tickets.categories.filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, 25).map((c) => ({ name: c.name, value: c.id })));
        }
        return i.respond([]);
      }

      if (i.isChatInputCommand()) {
        if (i.commandName === 'gruz') {
          const sub = i.options.getSubcommand();
          if (sub === 'online') return i.reply({ embeds: [onlineEmbed()] });
          if (sub === 'top' && i.options.getString('period') === 'week') {
            return i.reply({ embeds: [weeklyEmbed(ctx.weeklyTop(10), { cosmetic: db.promo?.weeklyReward?.cosmetic, places: db.promo?.weeklyReward?.places })], files: [logoFile()] });
          }
          if (sub === 'top') {
            const top = Object.values(db.users).filter((u) => !u.banned && !u.privateProfile).sort((a, b) => (b.stats?.totalMs || 0) - (a.stats?.totalMs || 0)).slice(0, 10);
            const medal = ['🥇', '🥈', '🥉'];
            return i.reply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle(t('topTitle')).setURL('https://gruzclient.com/top')
              .setDescription((top.map((u, k) => `${medal[k] || `**${k + 1}.**`} ${u.name} · ${hoursText(u.stats?.totalMs)} · ${t('level', { n: ctx.levelOf(u).level })}`).join('\n') || t('noData')) + '\n\n🌐 [gruzclient.com/top](https://gruzclient.com/top)')] });
          }
          if (sub === 'link') return cmdLink(i);
          if (sub === 'invites') return cmdInvites(i);
          if (sub === 'unlink') return cmdUnlink(i);
          if (sub === 'player') {
            const nick = (i.options.getString('nick') || '').trim();
            if (!nick) {
              const own = db.users[linkedUuid(i.user.id)];
              if (!own) return reply(i, t('linkNone'));
              return i.reply({ embeds: [profileEmbed(own)] });
            }
            const u = findUser(nick);
            if (!u) return reply(i, t('noPlayer', { nick: nick.replace(/[*_`~]/g, '').slice(0, 20) }));
            return i.reply({ embeds: [profileEmbed(u)] });
          }
          if (sub === 'servers') return cmdServers(i);
          if (sub === 'invite') { if (slow(i, 15_000)) return reply(i, '⏳'); return cmdInvite(i); }
          if (slow(i)) return reply(i, '⏳');
          if (sub === 'skin') return cmdSkin(i);
          if (sub === 'server') return cmdServer(i);
        }
        if (i.commandName === 'gruzpartner') return cmdPartner(i, i.options.getSubcommand());
        if (i.commandName === 'shop-codes') {
          if (!isAdmin(i)) return reply(i, t('adminOnly'));
          return cmdShopCodes(i);
        }
        if (i.commandName === 'gruzadmin') {
          if (!isAdmin(i)) return reply(i, t('adminOnly'));
          const group = i.options.getSubcommandGroup(false);
          const sub = i.options.getSubcommand();
          if (group === 'giveaway') {
            if (sub === 'start') return cmdGiveawayStart(i);
            if (sub === 'end') return cmdGiveawayEnd(i);
            if (sub === 'reroll') return cmdGiveawayReroll(i);
          }
          if (group === 'tickets') return cmdTickets(i, sub);
          if (group === 'verify') return cmdVerifyPanel(i);
          if (group === 'config') return cmdConfig(i, sub);
          if (group === 'event') return cmdEvent(i, sub);
          if (group === 'invites') return cmdInvitesAdmin(i, sub);
          if (group === 'levels') return cmdLevels(i, sub);
          if (sub === 'ranking') {
            return i.reply({ embeds: [weeklyEmbed(ctx.weeklyTop(10), { cosmetic: db.promo?.weeklyReward?.cosmetic, places: db.promo?.weeklyReward?.places })], files: [logoFile()] });
          }
          if (sub === 'code') return cmdCode(i);
          if (sub === 'wipe') return cmdWipe(i);
          if (sub === 'release') {
            await i.deferReply({ ephemeral: true });
            const r = await releaseTick(true);
            return i.editReply(r.ok ? `✅ ${r.posted}` : `❌ ${r.error}`);
          }
        }
        return;
      }

      if (i.isButton()) {
        const [kind, a, b] = i.customId.split(':');
        if (kind === 'gw') return btnGiveaway(i, a);
        if (kind === 'tk') return btnTicket(i, a);
        if (kind === 'vf') return btnVerify(i, a);
        if (kind === 'ev') return btnEvent(i);
        if (kind === 'wipe') { if (!isAdmin(i)) return reply(i, t('adminOnly')); return btnWipe(i, a, b); }
        return;
      }
      if (i.isStringSelectMenu() && i.customId === 'tk:open') return selectTicket(i);
      if (i.isModalSubmit()) {
        if (i.customId.startsWith('tk:modal:')) return submitTicket(i, i.customId.slice(9));
        if (i.customId === 'vf:modal') return submitVerify(i);
      }
    } catch (e) {
      console.error('[discord]', e);
      if (i.isRepliable?.()) reply(i, t('err')).catch(() => {});
    }
  };
  // komendy zwracają obietnicę bez await, więc ich błędy (np. wygasła interakcja po uśpieniu hostingu) łapiemy tutaj –
  // inaczej jako nieobsłużone odrzucenie wyłączały cały serwer
  client.on('interactionCreate', (i) => route(i).catch((e) => {
    console.error('[discord]', e.message);
    if (i.isRepliable?.()) reply(i, t('err')).catch(() => {});
  }));
  client.on('error', (e) => console.error('[discord] błąd połączenia:', e.message));

  // ---------------- lista grających na kanale ----------------
  let statusMsg = null;
  async function updateStatus() {
    client.user?.setActivity(t('watching', { n: ctx.online.size }), { type: ActivityType.Watching });
    const chId = statusChannel();
    if (!chId) return;
    try {
      const ch = await client.channels.fetch(chId);
      if (!ch?.isTextBased()) return;
      if (!statusMsg || statusMsg.channelId !== chId) {
        const recent = await ch.messages.fetch({ limit: 20 });
        statusMsg = recent.find((m) => m.author.id === client.user.id && m.embeds[0]?.title?.startsWith('🟢')) || null;
      }
      if (statusMsg) await statusMsg.edit({ embeds: [onlineEmbed()] });
      else statusMsg = await ch.send({ embeds: [onlineEmbed()] });
    } catch (e) {
      console.error('[discord] kanał statusu:', e.message);
      statusMsg = null;
    }
  }

  client.once('ready', async () => {
    console.log(`[discord] zalogowano jako ${client.user.tag}`);
    try {
      const rest = new REST({ version: '10' }).setToken(token);
      const route = guildId ? Routes.applicationGuildCommands(client.user.id, guildId) : Routes.applicationCommands(client.user.id);
      await rest.put(route, { body: [publicCmd.toJSON(), adminCmd.toJSON(), partnerCmd.toJSON(), shopCodesCmd.toJSON()] });
      console.log('[discord] komendy zarejestrowane' + (guildId ? ' na serwerze' : ' globalnie (mogą pojawić się po godzinie)'));
    } catch (e) { console.error('[discord] rejestracja komend:', e.message); }
    updateStatus();
    setInterval(updateStatus, 60_000);
    setInterval(() => giveawayTick().catch((e) => console.error('[discord] giveaway tick:', e.message)), 10_000);
    releaseTick();
    setInterval(releaseTick, 5 * 60_000);
    shopTick();
    setInterval(shopTick, 15 * 60_000);
    setInterval(() => eventTick().catch((e) => console.error('[discord] event tick:', e.message)), 30_000);
    setTimeout(() => syncLevelRoles().catch(() => {}), 60_000);
    setInterval(() => syncLevelRoles().catch(() => {}), 6 * 36e5);
  });

  client.login(token).catch((e) => console.error('[discord] logowanie nieudane:', e.message));
  return client;
};

module.exports.codesCsv = codesCsv;
module.exports.commands = () => [publicCmd.toJSON(), adminCmd.toJSON(), partnerCmd.toJSON(), shopCodesCmd.toJSON()];
