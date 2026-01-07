import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, Events, MessageFlags } from 'discord.js';
import { User } from './models/index.js';
import { getRankByPoints, syncPlayerRank } from './queue.js';

const REGISTER_CHANNEL_NAME = 'register';
const REGISTER_TAG = '[BOT-REGISTER-V1]';
const REGISTER_COOLDOWN = 60 * 60 * 1000; // 1 hour in ms
const registerCooldowns = new Map(); // userId -> timestamp

// Validate pseudo to prevent XSS/injection and ensure reasonable input
function validatePseudo(pseudo) {
  if (!pseudo || typeof pseudo !== 'string') return false;
  if (pseudo.length < 2 || pseudo.length > 100) return false;
  // Allow alphanumeric, spaces, hyphens, underscores, accented characters
  return /^[\w\s\-àâäæçéèêëîïôùûüœ]+$/i.test(pseudo);
}


export async function ensureRegisterMessage(client, guild) {
  const channel = guild.channels.cache.find(c => c.isTextBased() && c.name === REGISTER_CHANNEL_NAME);
  if (!channel) return;

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = messages?.find(m => m.author?.id === client.user.id && m.content?.includes(REGISTER_TAG));
  if (existing) return;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('register_button').setLabel('Register').setStyle(ButtonStyle.Primary)
  );

  await channel.send({ content: `${REGISTER_TAG} Cliquez sur \`Register\` pour vous enregistrer.`, components: [row] });
}

export function setupRegister(client) {
  // Auto-register returning players
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const user = await User.findOne({ where: { discordId: member.id } });
      if (!user) return; // New player, needs manual registration

      // Player exists in DB: re-register them
      const guild = member.guild;
      const pseudo = user.username;

      // Set nickname
      try { await member.setNickname(pseudo); } catch {}

      // Add role
      const role = guild.roles.cache.find(r => r.name.toLowerCase() === 'membre');
      if (role) {
        try { await member.roles.add(role); } catch {}
      }

      // Sync rank role
      await syncPlayerRank(guild, member.id, user.points);

      // Send DM confirmation
      try {
        await member.send(`✅ Welcome back! You've been automatically re-registered as **${pseudo}** with your ${user.points} points.`);
      } catch {}

      console.log(`Auto-registered returning player: ${pseudo} (${user.points} points)`);
    } catch (err) {
      console.error('Auto-register error:', err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId === 'register_button') {
        const userId = interaction.user.id;
        
        // Check cooldown
        const lastClick = registerCooldowns.get(userId);
        const now = Date.now();
        if (lastClick && (now - lastClick) < REGISTER_COOLDOWN) {
          const timeLeft = Math.ceil((REGISTER_COOLDOWN - (now - lastClick)) / 60000); // minutes left
          await interaction.reply({ flags: MessageFlags.Ephemeral, content: `You can register again in ${timeLeft} minutes.` });
          return;
        }
        
        registerCooldowns.set(userId, now);
        
        const modal = new ModalBuilder().setCustomId('register_modal').setTitle('Enregistrement');
        const input = new TextInputBuilder().setCustomId('pseudo_input').setLabel('Ton pseudo').setStyle(TextInputStyle.Short).setPlaceholder('Entrer votre pseudo').setRequired(true).setMaxLength(100);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId === 'register_modal') {
        const pseudo = interaction.fields.getTextInputValue('pseudo_input').trim();
        const guild = interaction.guild;
        const member = interaction.member;

        // Validate pseudo input
        if (!validatePseudo(pseudo)) {
          await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Invalid pseudo. Use 2-100 alphanumeric characters, spaces, hyphens, underscores.' });
          return;
        }

        // If already registered, show their current info and re-assign role
        const existing = await User.findOne({ where: { discordId: member.id } });
        if (existing) {
          // Re-assign role and nickname
          const role = guild.roles.cache.find(r => r.name.toLowerCase() === 'membre');
          if (role) {
            try { await member.roles.add(role); } catch {}
          }
          try { await member.setNickname(`${existing.points} - ${existing.username}`); } catch {}

          // Sync rank role
          await syncPlayerRank(guild, member.id, existing.points);

          const stats = `Pseudo: **${existing.username}**\nPoints: **${existing.points}**\nWins: **${existing.wins}**\nLosses: **${existing.losses}**`;
          await interaction.reply({ flags: MessageFlags.Ephemeral, content: `You're already registered!\n\n${stats}\n\n✅ Rôle **Membre** réattribué.` });
          return;
        }

        // First time: create user, set nickname, assign role
        const newUser = await User.create({ discordId: member.id, username: pseudo, registeredAt: new Date() }).catch(async (err) => {
          // Handle duplicate pseudo error
          if (err.name === 'SequelizeUniqueConstraintError') {
            await interaction.reply({ flags: MessageFlags.Ephemeral, content: `The pseudo **${pseudo}** is already taken. Choose another one.` });
            return null;
          }
          throw err;
        });

        if (!newUser) return;

        let nickOk = true;
        try { await member.setNickname(`${newUser.points} - ${pseudo}`); } catch { nickOk = false; }

        const role = guild.roles.cache.find(r => r.name.toLowerCase() === 'membre');
        if (!role) {
          await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Rôle 'Membre' introuvable. Créez un rôle `Membre`." });
          return;
        }

        try { await member.roles.add(role); }
        catch {
          await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Impossible d'assigner le rôle. Vérifiez la hiérarchie et permissions du bot." });
          return;
        }

        // Sync rank role for new player
        await syncPlayerRank(guild, member.id, newUser.points);

        const parts = [`✅ Enregistré comme **${pseudo}**.`, 'Rôle **Membre** attribué.', nickOk ? 'Pseudo mis à jour.' : "Impossible de changer ton pseudo (permissions)." ];
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: parts.join(' ') });
        return;
      }
    } catch (err) {
      console.error('Register interaction error', err);
      if (!interaction.replied) {
        try { await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Une erreur est survenue.' }); } catch {}
      }
    }
  });
}
