import dotenv from 'dotenv';
dotenv.config();
import { Sequelize } from 'sequelize';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('DATABASE_URL not set in .env — set it before connecting to DB');
}

const sequelize = new Sequelize(connectionString, {
  dialect: 'postgres',
  logging: false,
});

export default sequelize;
