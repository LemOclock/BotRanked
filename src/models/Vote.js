import { Model, DataTypes } from 'sequelize';
import sequelize from '../database.js';

class Vote extends Model {}

Vote.init({
  voterDiscordId: { type: DataTypes.STRING(64), allowNull: false },
  voteForTeamId: { type: DataTypes.INTEGER, allowNull: false }
}, {
  sequelize,
  modelName: 'Vote',
  tableName: 'votes',
  timestamps: true,
  indexes: [
    { fields: ['matchId'] },
    { fields: ['voterDiscordId'] }
  ]
});

export default Vote;
