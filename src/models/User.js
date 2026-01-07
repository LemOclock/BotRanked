import { Model, DataTypes } from 'sequelize';
import sequelize from '../database.js';

class User extends Model {}

User.init({
  discordId: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true
  },
  username: {
    type: DataTypes.STRING(100),
    allowNull: false,
    unique: true,
    validate: {
      len: {
        args: [2, 100],
        msg: 'Username must be 2-100 characters'
      }
    }
  },
  points: {
    type: DataTypes.INTEGER,
    defaultValue: 1000,
    validate: {
      min: {
        args: [0],
        msg: 'Points cannot be negative'
      }
    }
  },
  wins: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  losses: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  registeredAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  sequelize,
  modelName: 'User',
  tableName: 'users',
  timestamps: true
});

export default User;
