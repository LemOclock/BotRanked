import { Model, DataTypes } from 'sequelize';
import sequelize from '../database.js';

class Team extends Model {}

Team.init({
	name: { type: DataTypes.STRING(50), allowNull: false },
	captainDiscordId: { type: DataTypes.STRING(64) }
}, {
	sequelize,
	modelName: 'Team',
	tableName: 'teams',
	timestamps: false
});

export default Team;
