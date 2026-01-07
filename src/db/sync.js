import dotenv from 'dotenv';
dotenv.config();
import { sequelize } from '../models/index.js';

(async () => {
  try {
    console.log('Connecting to DB...');
    await sequelize.authenticate();
    console.log('Connection OK. Syncing models...');
    await sequelize.sync({ alter: true });
    console.log('Models synced.');
  } catch (err) {
    console.error('DB sync error:', err);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
