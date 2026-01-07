import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, Events, REST, Routes } from 'discord.js';
import sequelize from './database.js';
import { ensureRegisterMessage, setupRegister } from './register.js';
import { ensureQueueMessage, setupQueue } from './queue.js';
import { setupStats, getLeaderboardCommand } from './stats.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN not set in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, async () => {
  console.log(`${client.user.tag} ready`);
  try {
    await sequelize.authenticate();
    console.log('DB connected');
    if (process.env.DB_SYNC_ON_START === '1') {
      console.log('Syncing DB schema (alter)...');
      await sequelize.sync({ alter: true });
      console.log('DB schema synced');
    }
  } catch (err) {
    console.error('DB connection failed:', err);
    setTimeout(() => process.exit(1), 2000);
  }

  if (CLIENT_ID) {
    try {
      const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
      const commands = [getLeaderboardCommand().toJSON()];
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Slash commands registered');
    } catch (err) {
      console.error('Failed to register commands:', err);
    }
  }

  for (const guild of client.guilds.cache.values()) {
    try { await ensureRegisterMessage(client, guild); } catch (err) { console.error('ensureRegisterMessage error', err); }
    try { await ensureQueueMessage(client, guild); } catch (err) { console.error('ensureQueueMessage error', err); }
  }
});

client.on(Events.Error, err => {
  console.error('Client error:', err);
});

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
});

setupRegister(client);
setupQueue(client);
setupStats(client);

client.login(BOT_TOKEN);
