import { Model, DataTypes } from 'sequelize';
import sequelize from '../database.js';

class MatchPlayer extends Model {}

MatchPlayer.init({
  discordId: { type: DataTypes.STRING(64), allowNull: false },
  pickOrder: { type: DataTypes.INTEGER }
}, {
  sequelize,
  modelName: 'MatchPlayer',
  tableName: 'match_players',
  timestamps: false,
  indexes: [
    { fields: ['matchId'] }
  ]
});

export default MatchPlayer;
