/** Barrel for the bot riders (T-3.10). Pure sim code: no view modules, no DOM. */

export {
  BOT_MODE_ENGAGE,
  BOT_MODE_EXTEND,
  BOT_MODE_PATROL,
  BOT_MODE_RETREAT,
  BotBrain,
  createBotBrain,
} from './brain';
export type { BotArena, BotBrainOptions, BotContext, BotMode } from './brain';
export { BOT_DIFFICULTY_TUNING, BOT_TUNING } from './tuning';
export type { BotDifficultyTuning, BotTuning } from './tuning';
