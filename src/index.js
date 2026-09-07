require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const root = path.join(__dirname, '..');
const configPath = path.join(root, 'config.json');

if (!process.env.DISCORD_TOKEN || !process.env.GUILD_ID) {
  throw new Error('Faltan DISCORD_TOKEN o GUILD_ID en el archivo .env.');
}

if (!fs.existsSync(configPath)) {
  throw new Error('No existe config.json. Copia config.example.json y completa los IDs.');
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});
const ticketTimeouts = new Map();
const panelEmojiCache = new Map();

const panelIconFiles = {
  support: '74135-new-member.png',
  reports: '11838-warning.png',
  donations: '90665-shopping-cart.png',
  vip: '90665-shopping-cart.png',
  staff_report: '52662-trial-mod.png',
  organizations: '74135-new-member.png',
  creators: '26778-video-creator.png',
  business: '90665-shopping-cart.png',
  rewards: '78507-punishment.png',
  refunds: '78507-punishment.png',
};

const commands = [
  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Publica el panel principal de tickets')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Administra el ticket actual')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Añade una persona al ticket')
        .addUserOption((option) => option.setName('usuario').setDescription('Persona que se añadirá').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Retira una persona del ticket')
        .addUserOption((option) => option.setName('usuario').setDescription('Persona que se retirará').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('rename')
        .setDescription('Cambia el nombre del ticket')
        .addStringOption((option) => option.setName('nombre').setDescription('Nuevo nombre').setMaxLength(80).setRequired(true)),
    ),
].map((command) => command.toJSON());

function hexColor() {
  return Number.parseInt((config.brand.color || '#D4AF37').replace('#', ''), 16);
}

function panelColor() {
  return Number.parseInt((config.brand.panelColor || config.brand.color || '#D4AF37').replace('#', ''), 16);
}

function safeName(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'usuario';
}

function metadata(channel) {
  if (!channel?.topic?.startsWith('MAYBACH_TICKET|')) return null;
  return Object.fromEntries(
    channel.topic
      .split('|')
      .slice(1)
      .map((part) => {
        const [key, ...rest] = part.split('=');
        return [key, rest.join('=')];
      }),
  );
}

function makeTopic(owner, type, claimed = '') {
  return `MAYBACH_TICKET|owner=${owner}|type=${type}|claimed=${claimed}`;
}

function isStaff(member) {
  return member.permissions.has(PermissionFlagsBits.ManageChannels)
    || config.staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

function panelEmojiName(fileName) {
  const baseName = path.basename(fileName, path.extname(fileName))
    .replace(/^\d+-/, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

  return `mb_${baseName}`.slice(0, 32);
}

function selectMenuEmoji(emoji) {
  if (!emoji) return null;
  return { id: emoji.id, name: emoji.name, animated: emoji.animated };
}

async function resolvePanelEmojis(guild) {
  if (!guild) return { byCategory: {}, failedUploads: 0, missingFiles: 0 };

  const emojisPath = path.join(root, 'emojis');
  const uniqueFiles = [...new Set(Object.values(panelIconFiles))];
  const uploadedByFile = new Map();
  const byCategory = {};
  let failedUploads = 0;
  let missingFiles = 0;

  const fetchedEmojis = await guild.emojis.fetch().catch(() => null);
  const emojiCollection = fetchedEmojis || guild.emojis.cache;

  for (const fileName of uniqueFiles) {
    const filePath = path.join(emojisPath, fileName);
    if (!fs.existsSync(filePath)) {
      missingFiles += 1;
      continue;
    }

    const name = panelEmojiName(fileName);
    let emoji = emojiCollection.find((item) => item.name === name);

    if (!emoji) {
      try {
        emoji = await guild.emojis.create({
          attachment: filePath,
          name,
          reason: `Icono del panel de tickets de ${config.brand.name}`,
        });
      } catch (error) {
        failedUploads += 1;
        console.warn(`[MayBach Tickets] No se pudo sincronizar el emoji ${name}:`, error.message);
        continue;
      }
    }

    uploadedByFile.set(fileName, emoji);
  }

  Object.entries(panelIconFiles).forEach(([categoryKey, fileName]) => {
    const emoji = uploadedByFile.get(fileName);
    if (!emoji) return;

    byCategory[categoryKey] = {
      display: emoji.toString(),
      menu: selectMenuEmoji(emoji),
    };
  });

  panelEmojiCache.set(guild.id, byCategory);
  return { byCategory, failedUploads, missingFiles };
}

function panelCategoryEmoji(categoryKey, category, panelEmojis = {}) {
  return panelEmojis[categoryKey]?.display || category.emoji || '•';
}

function cachedPanelCategoryEmoji(guildId, categoryKey, category) {
  return panelEmojiCache.get(guildId)?.[categoryKey]?.display || category.emoji || '•';
}

function countOpenTickets(guild) {
  if (!guild) return 0;

  return guild.channels.cache.filter((channel) => {
    if (channel.parentId !== config.ticketCategoryId) return false;
    return Boolean(metadata(channel));
  }).size;
}

function countOpenTicketsByCategory(guild) {
  const counts = Object.keys(config.categories).reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {});

  if (!guild) return counts;

  guild.channels.cache.forEach((channel) => {
    if (channel.parentId !== config.ticketCategoryId) return;

    const data = metadata(channel);
    if (!data || !data.type) return;

    if (counts[data.type] !== undefined) {
      counts[data.type] += 1;
    }
  });

  return counts;
}

async function updateBotPresence(guild) {
  if (!client.user) return;

  const counts = countOpenTicketsByCategory(guild);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const summary = Object.entries(config.categories)
    .map(([key, category]) => {
      const shortLabel = category.label.split(/\s+/)[0] || key;
      return `${shortLabel}: ${counts[key] || 0}`;
    })
    .join(' | ');

  await client.user.setPresence({
    activities: [{ name: `${summary} | Total: ${total}`, type: ActivityType.Watching }],
    status: 'online',
  });
}

function panelEmbed(panelEmojis = {}) {
  const lines = Object.entries(config.categories)
    .map(([key, category]) => [
      `${panelCategoryEmoji(key, category, panelEmojis)}・**${category.label}**`,
      `╰・${category.description}`,
    ].join('\n'))
    .join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(panelColor())
    .setDescription([
      `> *Bienvenido al sistema de tickets de ${config.brand.name}.*`,
      '> *Selecciona el tipo de ticket según tu necesidad.*',
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      '',
      lines,
      '',
      '★━━━━━━━━━━━━━━━━━━━━★',
    ].join('\n'))
    .setFooter({ text: config.brand.footer || `${config.brand.name} • Centro de atención` })
    .setTimestamp();

  return embed;
}

function panelComponents(panelEmojis = {}) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket_category')
    .setPlaceholder('Selecciona categoría...')
    .addOptions(
      Object.entries(config.categories).map(([value, category]) => ({
        label: category.label.slice(0, 100),
        description: category.description.slice(0, 100),
        emoji: panelEmojis[value]?.menu || category.emoji,
        value,
      })),
    );
  return [new ActionRowBuilder().addComponents(menu)];
}

function ticketButtons(claimed = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_claim')
        .setLabel(claimed ? 'Ticket reclamado' : 'Reclamar ticket')
        .setEmoji('🙋')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(claimed),
      new ButtonBuilder()
        .setCustomId('ticket_close')
        .setLabel('Cerrar ticket')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function clearTicketTimeout(channelId) {
  const timeout = ticketTimeouts.get(channelId);
  if (timeout) {
    clearTimeout(timeout);
    ticketTimeouts.delete(channelId);
  }
}

function scheduleTicketTimeout(guild, channel) {
  clearTicketTimeout(channel.id);

  const timeout = setTimeout(async () => {
    try {
      const current = metadata(channel);
      if (!current || !channel.deletable) return;

      const ownerUser = await client.users.fetch(current.owner).catch(() => null);
      if (ownerUser) {
        await ownerUser.send({
          content: `Tu ticket en **${guild.name}** ha sido cerrado automáticamente por inactividad tras 24 horas.`,
        }).catch(() => null);
      }

      await channel.send({
        content: `⚠️ Este ticket ha sido cerrado automáticamente por inactividad tras 24 horas.`,
      }).catch(() => null);

      const logChannel = await guild.channels.fetch(config.transcriptChannelId).catch(() => null);
      if (logChannel?.isTextBased()) {
        const logEmbed = new EmbedBuilder()
          .setColor(hexColor())
          .setTitle('⏰ Ticket cerrado por inactividad')
          .addFields(
            { name: 'Canal', value: channel.name, inline: true },
            { name: 'Creado por', value: `<@${current.owner}>`, inline: true },
            { name: 'Motivo', value: 'Inactividad superior a 24 horas' },
          )
          .setTimestamp();
        await logChannel.send({ embeds: [logEmbed] }).catch(() => null);
      }

      clearTicketTimeout(channel.id);
      await channel.delete('Ticket cerrado por inactividad tras 24 horas');
      await updateBotPresence(guild);
    } catch (error) {
      console.error('Error al cerrar ticket por inactividad:', error);
    }
  }, 24 * 60 * 60 * 1000);

  ticketTimeouts.set(channel.id, timeout);
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: commands });
}

async function findOpenTicket(guild, userId) {
  return guild.channels.cache.find((channel) => metadata(channel)?.owner === userId);
}

async function createTicket(interaction, type, subject, details) {
  const category = config.categories[type];
  if (!category) return interaction.reply({ content: 'Esa categoría ya no existe.', ephemeral: true });

  const existing = await findOpenTicket(interaction.guild, interaction.user.id);
  if (existing) {
    return interaction.reply({ content: `Ya tienes un ticket abierto: ${existing}`, ephemeral: true });
  }

  const roleIds = [...new Set([...config.staffRoleIds, ...(category.roleIds || [])])];
  const permissionOverwrites = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    },
    ...roleIds.map((id) => ({
      id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    })),
  ];

  const ticketParentId = category.categoryId || category.parentId || config.ticketCategoryId;

  const channel = await interaction.guild.channels.create({
    name: `${category.prefix}-${safeName(interaction.user.username)}`,
    type: ChannelType.GuildText,
    parent: ticketParentId,
    topic: makeTopic(interaction.user.id, type),
    permissionOverwrites,
    reason: `Ticket ${category.label} creado por ${interaction.user.tag}`,
  });

  const ticketEmbed = new EmbedBuilder()
    .setColor(hexColor())
    .setTitle(`${cachedPanelCategoryEmoji(interaction.guild.id, type, category)} ${category.label}`)
    .setDescription([
      `Hola ${interaction.user}, tu solicitud ya fue creada.`,
      '',
      `**Asunto:** ${subject}`,
      `**Descripción:**\n${details}`,
      '',
      'Un miembro del equipo responderá lo antes posible. Mientras esperas, adjunta cualquier evidencia importante.',
    ].join('\n'))
    .setFooter({ text: config.brand.footer })
    .setTimestamp();

  await channel.send({
    content: `${interaction.user} abrió este ticket. Un miembro del equipo responderá lo antes posible.`,
    embeds: [ticketEmbed],
    components: ticketButtons(),
    allowedMentions: { users: [interaction.user.id] },
  });

  scheduleTicketTimeout(interaction.guild, channel);
  await updateBotPresence(interaction.guild);
  return interaction.reply({ content: `Tu ticket fue creado: ${channel}`, ephemeral: true });
}

async function transcript(channel) {
  const messages = [];
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }

  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const output = messages.map((message) => {
    const attachments = [...message.attachments.values()].map((item) => item.url).join(' ');
    return `[${new Date(message.createdTimestamp).toISOString()}] ${message.author.tag}: ${message.cleanContent}${attachments ? ` ${attachments}` : ''}`;
  }).join('\n');

  return Buffer.from(output || 'El ticket no contenía mensajes.', 'utf8');
}

async function closeTicket(interaction, reason) {
  const data = metadata(interaction.channel);
  if (!data) return interaction.reply({ content: 'Este canal no es un ticket válido.', ephemeral: true });
  if (!isStaff(interaction.member)) {
    return interaction.reply({ content: 'Solo el equipo puede cerrar este ticket.', ephemeral: true });
  }

  clearTicketTimeout(interaction.channel.id);

  await interaction.reply({ content: 'Generando la transcripción y cerrando el ticket…', ephemeral: true });
  const file = new AttachmentBuilder(await transcript(interaction.channel), { name: `${interaction.channel.name}.txt` });
  const logChannel = await interaction.guild.channels.fetch(config.transcriptChannelId).catch(() => null);

  if (logChannel?.isTextBased()) {
    const logEmbed = new EmbedBuilder()
      .setColor(hexColor())
      .setTitle('🔒 Ticket cerrado')
      .addFields(
        { name: 'Canal', value: interaction.channel.name, inline: true },
        { name: 'Creado por', value: `<@${data.owner}>`, inline: true },
        { name: 'Cerrado por', value: `${interaction.user}`, inline: true },
        { name: 'Motivo', value: reason.slice(0, 1024) },
      )
      .setTimestamp();
    await logChannel.send({ embeds: [logEmbed], files: [file] });
  }

  await interaction.channel.delete(`Ticket cerrado por ${interaction.user.tag}: ${reason}`);
  await updateBotPresence(interaction.guild);
}

client.once('ready', async () => {
  await registerCommands();
  const guild = client.guilds.cache.get(process.env.GUILD_ID) || client.guilds.cache.first();
  await updateBotPresence(guild);
  console.log(`[MayBach Tickets] Conectado como ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ticket-panel') {
        if (interaction.channelId !== config.panelChannelId) {
          return interaction.reply({ content: `Utiliza este comando en <#${config.panelChannelId}>.`, ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        const panelEmojis = await resolvePanelEmojis(interaction.guild);
        await interaction.channel.send({
          embeds: [panelEmbed(panelEmojis.byCategory)],
          components: panelComponents(panelEmojis.byCategory),
        });

        const warning = panelEmojis.failedUploads || panelEmojis.missingFiles
          ? ' Algunos iconos locales no pudieron cargarse; revisa permisos de emojis del bot o la carpeta emojis.'
          : '';
        return interaction.editReply({ content: `Panel de tickets publicado.${warning}` });
      }

      if (interaction.commandName === 'ticket') {
        const data = metadata(interaction.channel);
        if (!data) return interaction.reply({ content: 'Este comando solo funciona dentro de un ticket.', ephemeral: true });
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Este comando es exclusivo del equipo.', ephemeral: true });

        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'rename') {
          const name = safeName(interaction.options.getString('nombre', true));
          await interaction.channel.setName(name, `Renombrado por ${interaction.user.tag}`);
          return interaction.reply({ content: `Canal renombrado a **${name}**.` });
        }

        const user = interaction.options.getUser('usuario', true);
        if (subcommand === 'add') {
          await interaction.channel.permissionOverwrites.edit(user.id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
          });
          return interaction.reply({ content: `${user} fue añadido al ticket.` });
        }

        await interaction.channel.permissionOverwrites.delete(user.id).catch(() => null);
        return interaction.reply({ content: `${user} fue retirado del ticket.` });
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_category') {
      const type = interaction.values[0];
      const category = config.categories[type];
      const modal = new ModalBuilder().setCustomId(`ticket_modal:${type}`).setTitle(category.label.slice(0, 45));
      const subject = new TextInputBuilder()
        .setCustomId('subject')
        .setLabel('Asunto de tu solicitud')
        .setPlaceholder('Resume brevemente el motivo del ticket')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true);
      const details = new TextInputBuilder()
        .setCustomId('details')
        .setLabel('Explícanos lo sucedido')
        .setPlaceholder('Incluye toda la información importante')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(10)
        .setMaxLength(1000)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(subject), new ActionRowBuilder().addComponents(details));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_modal:')) {
      const type = interaction.customId.split(':')[1];
      return createTicket(
        interaction,
        type,
        interaction.fields.getTextInputValue('subject'),
        interaction.fields.getTextInputValue('details'),
      );
    }

    if (interaction.isButton() && interaction.customId === 'ticket_claim') {
      const data = metadata(interaction.channel);
      if (!data) return interaction.reply({ content: 'Este canal no es un ticket.', ephemeral: true });
      if (!isStaff(interaction.member)) return interaction.reply({ content: 'Solo el equipo puede reclamar tickets.', ephemeral: true });
      if (data.claimed) return interaction.reply({ content: `Este ticket ya fue reclamado por <@${data.claimed}>.`, ephemeral: true });

      await interaction.channel.setTopic(makeTopic(data.owner, data.type, interaction.user.id));
      await interaction.update({ components: ticketButtons(true) });
      return interaction.followUp({ content: `🙋 ${interaction.user} reclamó este ticket.` });
    }

    if (interaction.isButton() && interaction.customId === 'ticket_close') {
      const data = metadata(interaction.channel);
      if (!data) return interaction.reply({ content: 'Este canal no es un ticket.', ephemeral: true });
      if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'Solo el equipo puede cerrar este ticket.', ephemeral: true });
      }
      const modal = new ModalBuilder().setCustomId('ticket_close_modal').setTitle('Cerrar ticket');
      const reason = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Motivo del cierre')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(500)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(reason));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'ticket_close_modal') {
      return closeTicket(interaction, interaction.fields.getTextInputValue('reason'));
    }
  } catch (error) {
    console.error(error);
    const payload = { content: 'Ocurrió un error procesando la solicitud. Revisa la consola del bot.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => null);
    else await interaction.reply(payload).catch(() => null);
  }
});

client.login(process.env.DISCORD_TOKEN);
