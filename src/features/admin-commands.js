import { 
  Events, 
  ChannelType, 
  MessageFlags, 
  SlashCommandBuilder, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle, 
  ActionRowBuilder 
} from "discord.js";
import { Match, User } from "../models/index.js";
import { syncPlayerRank, getRankByPoints } from "../queue.js";

const DODGE_BAN_DURATION = 60 * 60 * 1000; // 1 hour in ms

/**
 * Setup all admin commands handlers
 */
export function setupAdminCommands(client, dodgeBans, matches, voteUpdateQueues) {
  // Handle /ban-player command (admin only)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'ban-player') return;

    try {
      const isAdmin = interaction.member.roles.cache.some(r => r.name === 'admin') || interaction.user.id === interaction.guild.ownerId;
      if (!isAdmin) {
        await interaction.reply({ content: 'Only admins can ban players.', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('player');
      const durationStr = interaction.options.getString('duration');

      // Parse duration (2h, 3h, 1j, 30m, etc.)
      const match = durationStr.match(/^(\d+)(m|h|j|d)$/i);
      if (!match) {
        await interaction.reply({ content: 'Invalid duration format. Use: 30m, 2h, 1j (m=minutes, h=hours, j/d=days)', flags: MessageFlags.Ephemeral });
        return;
      }

      const value = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      let durationMs = 0;

      if (unit === 'm') durationMs = value * 60 * 1000;
      else if (unit === 'h') durationMs = value * 60 * 60 * 1000;
      else if (unit === 'j' || unit === 'd') durationMs = value * 24 * 60 * 60 * 1000;

      const banExpiry = Date.now() + durationMs;
      dodgeBans.set(targetUser.id, { timestamp: banExpiry, createdAt: Date.now() });

      // Post to #bann channel
      try {
        const guild = interaction.guild;
        let bannChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === 'bann');
        if (!bannChannel) {
          bannChannel = await guild.channels.create({ name: 'bann', type: ChannelType.GuildText });
        }
        await bannChannel.send(`<@${targetUser.id}> vous êtes banni ${durationStr}.`);
      } catch (errBann) {
        console.error('Error posting to bann channel:', errBann);
      }

      await interaction.reply({ content: `<@${targetUser.id}> banned from queue for ${durationStr}.`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('Ban player error:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Error banning player.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  // Handle /reset-match command (admin only)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'reset-match') return;

    try {
      const isAdmin = interaction.member.roles.cache.some(r => r.name === 'admin') || interaction.user.id === interaction.guild.ownerId;
      if (!isAdmin) {
        await interaction.reply({ content: 'Only admins can reset matches.', flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.options.getChannel('channel');
      const state = matches.get(channel.id);

      if (!state) {
        await interaction.reply({ content: 'No active match found in that channel.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Mark match as cancelled in DB
      if (state.matchId) {
        await Match.update({ status: 'cancelled' }, { where: { id: state.matchId } }).catch(() => {});
      }

      // Clean up
      matches.delete(channel.id);
      voteUpdateQueues.delete(state.matchId);

      await interaction.reply({ content: `Match in ${channel} has been reset. Channel will be deleted in 5 seconds.`, flags: MessageFlags.Ephemeral });

      // Delete channel
      setTimeout(() => {
        try { channel.delete().catch(() => {}); } catch {}
      }, 5000);

    } catch (err) {
      console.error('Reset match error:', err);
      await interaction.reply({ content: 'Error resetting match.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  // Handle /unban-player command (admin only)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'unban-player') return;

    try {
      const isAdmin = interaction.member.roles.cache.some(r => r.name === 'admin') || interaction.user.id === interaction.guild.ownerId;
      if (!isAdmin) {
        await interaction.reply({ content: 'Only admins can unban players.', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('player');

      // Check if player is actually banned
      if (!dodgeBans.has(targetUser.id)) {
        await interaction.reply({ content: `<@${targetUser.id}> is not banned from queue.`, flags: MessageFlags.Ephemeral });
        return;
      }

      // Remove the ban
      dodgeBans.delete(targetUser.id);

      // Post to #bann channel
      try {
        const guild = interaction.guild;
        let bannChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === 'bann');
        if (bannChannel) {
          await bannChannel.send(`<@${targetUser.id}> a été débanni.`);
        }
      } catch (errBann) {
        console.error('Error posting to bann channel:', errBann);
      }

      await interaction.reply({ content: `<@${targetUser.id}> unbanned from queue.`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('Unban player error:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Error unbanning player.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  // Handle /edit-player-stats command (admin only)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'edit-player-stats') return;

    try {
      const isAdmin = interaction.member.roles.cache.some(r => r.name === 'admin') || interaction.user.id === interaction.guild.ownerId;
      if (!isAdmin) {
        await interaction.reply({ content: 'Only admins can edit player stats.', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('player');

      // Get current stats
      const user = await User.findOne({ where: { discordId: targetUser.id } });
      if (!user) {
        await interaction.reply({ content: `<@${targetUser.id}> is not registered in the system.`, flags: MessageFlags.Ephemeral });
        return;
      }

      // Create Modal with pre-filled stats
      const modal = new ModalBuilder()
        .setCustomId(`edit-stats-${targetUser.id}`)
        .setTitle(`Edit ${user.username} Stats`);

      const pointsInput = new TextInputBuilder()
        .setCustomId('points-input')
        .setLabel('Points')
        .setStyle(TextInputStyle.Short)
        .setValue(user.points.toString())
        .setRequired(true);

      const winsInput = new TextInputBuilder()
        .setCustomId('wins-input')
        .setLabel('Wins')
        .setStyle(TextInputStyle.Short)
        .setValue(user.wins.toString())
        .setRequired(true);

      const lossesInput = new TextInputBuilder()
        .setCustomId('losses-input')
        .setLabel('Losses')
        .setStyle(TextInputStyle.Short)
        .setValue(user.losses.toString())
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(pointsInput),
        new ActionRowBuilder().addComponents(winsInput),
        new ActionRowBuilder().addComponents(lossesInput)
      );

      await interaction.showModal(modal);
    } catch (err) {
      console.error('Edit player stats error:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Error opening stats editor.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  // Handle Modal submission for edit-player-stats
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (!interaction.customId.startsWith('edit-stats-')) return;

    try {
      const targetUserId = interaction.customId.replace('edit-stats-', '');
      
      // Validate Discord ID format
      if (!/^\d{17,19}$/.test(targetUserId)) {
        await interaction.reply({ content: 'Invalid user ID.', flags: MessageFlags.Ephemeral });
        return;
      }

      const points = parseInt(interaction.fields.getTextInputValue('points-input'));
      const wins = parseInt(interaction.fields.getTextInputValue('wins-input'));
      const losses = parseInt(interaction.fields.getTextInputValue('losses-input'));

      // Validate numbers
      if (isNaN(points) || isNaN(wins) || isNaN(losses)) {
        await interaction.reply({ content: 'All values must be valid numbers.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Validate non-negative values
      if (points < 0 || wins < 0 || losses < 0) {
        await interaction.reply({ content: 'Points, wins, and losses must be >= 0.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Get user and old values
      const user = await User.findOne({ where: { discordId: targetUserId } });
      if (!user) {
        await interaction.reply({ content: 'Player not found.', flags: MessageFlags.Ephemeral });
        return;
      }

      const oldPoints = user.points;
      const oldWins = user.wins;
      const oldLosses = user.losses;

      // Update stats
      await user.update({ points, wins, losses });

      // Sync rank after points update
      await syncPlayerRank(interaction.guild, targetUserId, points);

      const confirmMessage = `**${user.username}** stats updated:\n` +
        `Points: **${oldPoints}** → **${points}**\n` +
        `Wins: **${oldWins}** → **${wins}**\n` +
        `Losses: **${oldLosses}** → **${losses}**`;

      await interaction.reply({ content: confirmMessage, flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('Edit player stats modal error:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Error updating player stats.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });
}

/**
 * Slash command definitions
 */
export function getResetMatchCommand() {
  return new SlashCommandBuilder()
    .setName('reset-match')
    .setDescription('Cancel an active match (admin only)')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Match channel to reset')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    );
}

export function getBanPlayerCommand() {
  return new SlashCommandBuilder()
    .setName('ban-player')
    .setDescription('Ban a player from queue for a duration (admin only)')
    .addUserOption(option =>
      option.setName('player')
        .setDescription('Player to ban')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('Ban duration (e.g. 30m, 2h, 1j)')
        .setRequired(true)
    );
}

export function getUnbanPlayerCommand() {
  return new SlashCommandBuilder()
    .setName('unban-player')
    .setDescription('Unban a player from queue (admin only)')
    .addUserOption(option =>
      option.setName('player')
        .setDescription('Player to unban')
        .setRequired(true)
    );
}

export function getEditPlayerStatsCommand() {
  return new SlashCommandBuilder()
    .setName('edit-player-stats')
    .setDescription('Edit player stats (admin only)')
    .addUserOption(option =>
      option.setName('player')
        .setDescription('Player to edit')
        .setRequired(true)
    );
}
