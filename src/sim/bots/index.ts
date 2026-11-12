/** Barrel for the bot riders (T-3.10). Pure sim code: no view modules, no DOM. */

export {
  BOT_ERRAND_CARRY,
  BOT_ERRAND_NONE,
  BOT_ERRAND_RETURN,
  BOT_ERRAND_TAKE,
  BOT_MODE_ENGAGE,
  BOT_MODE_EXTEND,
  BOT_MODE_OBJECTIVE,
  BOT_MODE_PATROL,
  BOT_MODE_RETREAT,
  BotBrain,
  createBotBrain,
} from './brain';
export type { BotArena, BotBrainOptions, BotContext, BotErrand, BotMode } from './brain';
export { BOT_DIFFICULTY_TUNING, BOT_TUNING } from './tuning';
export type { BotDifficultyTuning, BotTuning } from './tuning';
