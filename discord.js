// Bot Discord Gruz Client (opcjonalny): /gruz gracz, /gruz online, /gruz top i kanał "kto teraz gra".
// Włącza się, gdy ustawisz zmienną DISCORD_TOKEN. Szczegóły w README.
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes, ActivityType } = require('discord.js');

const COLOR = 0xb45cff;
const STATE_NAMES = { launcher: 'w launcherze', menu: 'w menu gry', singleplayer: 'w świecie jednoosobowym', multiplayer: 'na serwerze' };

function hoursText(ms) {
  const h = (ms || 0) / 36e5;
  return h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`;
}

module.exports = function startDiscord(ctx) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return null;
  const guildId = process.env.DISCORD_GUILD_ID || '';
  const channelId = process.env.DISCORD_CHANNEL_ID || '';
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  const command = new SlashCommandBuilder()
    .setName('gruz').setDescription('Gruz Client')
    .addSubcommand((s) => s.setName('gracz').setDescription('Profil gracza Gruz Client')
      .addStringOption((o) => o.setName('nick').setDescription('Nick w Minecrafcie').setRequired(true)))
    .addSubcommand((s) => s.setName('online').setDescription('Kto teraz gra na Gruz Client'))
    .addSubcommand((s) => s.setName('top').setDescription('Najwięcej godzin w Gruz Client'));

  function onlineList() {
    const out = [];
    for (const uuid of ctx.online.keys()) {
      const u = ctx.db.users[uuid];
      if (!u) continue;
      out.push({ u, p: ctx.presenceOf(uuid) });
    }
    return out.sort((a, b) => a.u.name.localeCompare(b.u.name));
  }

  function line({ u, p }) {
    const where = p.state === 'multiplayer' && p.server ? `na **${p.server}**` : STATE_NAMES[p.state] || 'online';
    return `• **${u.name}** · poz. ${ctx.levelOf(u).level} · ${where}`;
  }

  function onlineEmbed() {
    const list = onlineList();
    const e = new EmbedBuilder().setColor(COLOR).setTitle(`🟢 Teraz na Gruz Client: ${list.length}`)
      .setDescription(list.length ? list.slice(0, 40).map(line).join('\n') + (list.length > 40 ? `\n…i ${list.length - 40} więcej` : '') : 'Nikt teraz nie gra.')
      .setFooter({ text: `Graczy łącznie: ${Object.keys(ctx.db.users).length}` }).setTimestamp(new Date());
    return e;
  }

  function profileEmbed(u) {
    const p = ctx.presenceOf(u.uuid);
    const lv = ctx.levelOf(u);
    const badges = (u.badges || []).map((b) => ctx.badgeName(b)).filter(Boolean);
    return new EmbedBuilder().setColor(COLOR)
      .setTitle(u.name).setURL(`https://namemc.com/profile/${u.uuid}`)
      .setThumbnail(`https://mc-heads.net/avatar/${u.uuid}/128`)
      .setDescription(p.online ? `🟢 ${p.state === 'multiplayer' && p.server ? `gra na **${p.server}**` : STATE_NAMES[p.state] || 'online'}` : `⚫ offline · ostatnio <t:${Math.floor((u.lastSeen || Date.now()) / 1000)}:R>`)
      .addFields(
        { name: 'Poziom', value: `${lv.level} (${lv.xp}/${lv.next} XP)`, inline: true },
        { name: 'Czas gry', value: hoursText(u.stats?.totalMs), inline: true },
        { name: 'Kille', value: String(u.stats?.kills || 0), inline: true },
        { name: 'Znajomi', value: String(u.friends?.length || 0), inline: true },
        { name: 'W Gruz od', value: `<t:${Math.floor((u.firstSeen || Date.now()) / 1000)}:D>`, inline: true },
        { name: 'Odznaki', value: badges.length ? badges.join(', ') : '—', inline: false },
      );
  }

  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || i.commandName !== 'gruz') return;
    try {
      const sub = i.options.getSubcommand();
      if (sub === 'online') return i.reply({ embeds: [onlineEmbed()] });
      if (sub === 'top') {
        const top = Object.values(ctx.db.users).sort((a, b) => (b.stats?.totalMs || 0) - (a.stats?.totalMs || 0)).slice(0, 10);
        const medal = ['🥇', '🥈', '🥉'];
        return i.reply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('🏆 Najwięcej godzin w Gruz Client')
          .setDescription(top.map((u, k) => `${medal[k] || `**${k + 1}.**`} ${u.name} · ${hoursText(u.stats?.totalMs)} · poz. ${ctx.levelOf(u).level}`).join('\n') || 'Brak danych.')] });
      }
      if (sub === 'gracz') {
        const nick = i.options.getString('nick', true).trim().toLowerCase();
        const u = Object.values(ctx.db.users).find((x) => x.name.toLowerCase() === nick);
        if (!u) return i.reply({ content: `Nie ma gracza **${nick}** w Gruz Client.`, ephemeral: true });
        return i.reply({ embeds: [profileEmbed(u)] });
      }
    } catch (e) {
      console.error('[discord]', e);
      if (!i.replied) i.reply({ content: 'Coś poszło nie tak.', ephemeral: true }).catch(() => {});
    }
  });

  // wiadomość "kto teraz gra" odświeżana co minutę na wybranym kanale
  let statusMsg = null;
  async function updateStatus() {
    const n = ctx.online.size;
    client.user?.setActivity(`Gruz Client · ${n} online`, { type: ActivityType.Watching });
    if (!channelId) return;
    try {
      const ch = await client.channels.fetch(channelId);
      if (!ch?.isTextBased()) return;
      if (!statusMsg) {
        const recent = await ch.messages.fetch({ limit: 20 });
        statusMsg = recent.find((m) => m.author.id === client.user.id) || null;
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
      await rest.put(route, { body: [command.toJSON()] });
      console.log('[discord] komenda /gruz zarejestrowana' + (guildId ? ' na serwerze' : ' globalnie (może pojawić się po godzinie)'));
    } catch (e) { console.error('[discord] rejestracja komend:', e.message); }
    updateStatus();
    setInterval(updateStatus, 60_000);
  });

  client.login(token).catch((e) => console.error('[discord] logowanie nieudane:', e.message));
  return client;
};
