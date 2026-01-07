import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, Events, EmbedBuilder } from 'discord.js';

const tickets = new Map(); // ticketNumber -> { creatorId, channelId, guildId }
let nextTicketNumber = 1;

export async function ensureTicketMessage(client, guild) {
  try {
    const ticketChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === 'make-a-ticket');
    if (!ticketChannel) return;

    const messages = await ticketChannel.messages.fetch({ limit: 50 }).catch(() => null);
    const existing = messages?.find(m => m.author?.id === client.user.id && m.components?.length);

    const embed = new EmbedBuilder()
      .setTitle('Support Tickets')
      .setDescription('Click the button below to open a support ticket.');

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_open')
          .setLabel('Open Ticket')
          .setStyle(ButtonStyle.Primary)
      );

    if (existing) {
      try {
        await existing.edit({ embeds: [embed], components: [row] });
      } catch {}
    } else {
      await ticketChannel.send({ embeds: [embed], components: [row] });
    }
  } catch (err) {
    console.error('Error updating ticket message:', err);
  }
}

export function setupTickets(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // Handle ticket button
      if (interaction.isButton() && interaction.customId === 'ticket_open') {
        const guild = interaction.guild;
        const userId = interaction.user.id;

        // Check if user already has an open ticket
        const userTicket = [...tickets.values()].find(t => t.creatorId === userId && t.guildId === guild.id);
        if (userTicket) {
          await interaction.reply({ content: `You already have an open ticket (#${userTicket.number}). Close it first.`, flags: 64 });
          return;
        }

        const ticketNumber = nextTicketNumber++;
        const channelName = `ticket-${ticketNumber}`;

        // Create ticket channel (only accessible to creator and admins)
        const ticketChannel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              deny: [PermissionFlagsBits.ViewChannel]
            },
            {
              id: userId,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
            },
            {
              id: guild.roles.cache.find(r => r.name === 'admin')?.id || guild.ownerId,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
            }
          ]
        });

        tickets.set(ticketNumber, {
          number: ticketNumber,
          creatorId: userId,
          channelId: ticketChannel.id,
          guildId: guild.id
        });

        const ticketEmbed = new EmbedBuilder()
          .setTitle(`Ticket #${ticketNumber}`)
          .setDescription(`Created by <@${userId}>`)
          .setFooter({ text: 'You can now describe your issue' });

        await ticketChannel.send({ embeds: [ticketEmbed] });
        await interaction.reply({ content: `Ticket #${ticketNumber} created! <#${ticketChannel.id}>`, flags: 64 });
        return;
      }

      // Handle slash commands
      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === 'delete-ticket') {
        const ticketNumber = interaction.options.getInteger('ticket');
        const ticket = tickets.get(ticketNumber);

        if (!ticket) {
          await interaction.reply({ content: `Ticket #${ticketNumber} not found.`, flags: 64 });
          return;
        }

        // Check if user is admin or creator
        const isAdmin = interaction.member.roles.cache.some(r => r.name === 'admin') || interaction.user.id === ticket.creatorId || interaction.user.id === interaction.guild.ownerId;
        if (!isAdmin) {
          await interaction.reply({ content: 'Only admins or the ticket creator can delete this ticket.', flags: 64 });
          return;
        }

        const channel = await interaction.guild.channels.fetch(ticket.channelId).catch(() => null);
        if (channel) await channel.delete().catch(() => {});

        tickets.delete(ticketNumber);
        await interaction.reply({ content: `Ticket #${ticketNumber} deleted.`, flags: 64 });
        return;
      }

      if (interaction.commandName === 'invite-player-ticket') {
        const ticketNumber = interaction.options.getInteger('ticket');
        const player = interaction.options.getUser('player');
        const ticket = tickets.get(ticketNumber);

        if (!ticket) {
          await interaction.reply({ content: `Ticket #${ticketNumber} not found.`, flags: 64 });
          return;
        }

        // Check if user is admin
        const isAdmin = interaction.member.roles.cache.some(r => r.name === 'admin') || interaction.user.id === interaction.guild.ownerId;
        if (!isAdmin) {
          await interaction.reply({ content: 'Only admins can invite players to tickets.', flags: 64 });
          return;
        }

        const channel = await interaction.guild.channels.fetch(ticket.channelId).catch(() => null);
        if (!channel) {
          await interaction.reply({ content: `Ticket channel not found.`, flags: 64 });
          return;
        }

        await channel.permissionOverwrites.edit(player.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true
        });

        await interaction.reply({ content: `<@${player.id}> invited to ticket #${ticketNumber}.`, flags: 64 });
        return;
      }
    } catch (err) {
      console.error('Ticket command error:', err);
    }
  });
}

export function getDeleteTicketCommand() {
  return new SlashCommandBuilder()
    .setName('delete-ticket')
    .setDescription('Delete a support ticket')
    .addIntegerOption(option =>
      option.setName('ticket')
        .setDescription('Ticket number to delete')
        .setRequired(true)
    );
}

export function getInvitePlayerTicketCommand() {
  return new SlashCommandBuilder()
    .setName('invite-player-ticket')
    .setDescription('Invite a player to a support ticket')
    .addIntegerOption(option =>
      option.setName('ticket')
        .setDescription('Ticket number')
        .setRequired(true)
    )
    .addUserOption(option =>
      option.setName('player')
        .setDescription('Player to invite')
        .setRequired(true)
    );
}
