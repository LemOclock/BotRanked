import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, Events, MessageFlags } from 'discord.js';
import { User } from './models/index.js';

const REGISTER_CHANNEL_NAME = 'register';
const REGISTER_TAG = '[BOT-REGISTER-V1]';

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
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId === 'register_button') {
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

        // If already registered, just inform and stop
        const existing = await User.findOne({ where: { discordId: member.id } });
        if (existing) {
          await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Already register' });
          return;
        }

        // First time: create user, set nickname, assign role
        await User.create({ discordId: member.id, username: pseudo, registeredAt: new Date() });

        let nickOk = true;
        try { await member.setNickname(pseudo); } catch { nickOk = false; }

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
