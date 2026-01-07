import sequelize from '../database.js';
import User from './User.js';
import Match from './Match.js';
import Team from './Team.js';
import MatchPlayer from './MatchPlayer.js';
import Vote from './Vote.js';

// Associations
Match.hasMany(Team, { foreignKey: 'matchId' });
Team.belongsTo(Match, { foreignKey: 'matchId' });

Match.hasMany(MatchPlayer, { foreignKey: 'matchId' });
MatchPlayer.belongsTo(Match, { foreignKey: 'matchId' });

Team.hasMany(MatchPlayer, { foreignKey: 'teamId' });
MatchPlayer.belongsTo(Team, { foreignKey: 'teamId' });

Match.hasMany(Vote, { foreignKey: 'matchId' });
Vote.belongsTo(Match, { foreignKey: 'matchId' });

export {
  sequelize,
  User,
  Match,
  Team,
  MatchPlayer,
  Vote
};
