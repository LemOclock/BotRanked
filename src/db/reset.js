import dotenv from 'dotenv';
dotenv.config();
import { sequelize } from '../models/index.js';

(async () => {
  try {
    console.log('Connecting to DB...');
    await sequelize.authenticate();
    console.log('Connection OK. Dropping all tables...');
    await sequelize.drop();
    console.log('✅ All tables dropped!');
    
    console.log('Creating new tables...');
    await sequelize.sync({ force: true });
    console.log('✅ Database reset successfully!');
  } catch (err) {
    console.error('DB reset error:', err);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
