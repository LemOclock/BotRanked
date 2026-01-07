import { Model, DataTypes } from 'sequelize';
import sequelize from '../database.js';

class Match extends Model {}

Match.init({
	channelId: { type: DataTypes.STRING(64), allowNull: false },
	status: { type: DataTypes.STRING(30), defaultValue: 'draft' }
}, {
	sequelize,
	modelName: 'Match',
	tableName: 'matches',
	timestamps: true,
	indexes: [
		{ fields: ['status'] }
	]
});

export default Match;
