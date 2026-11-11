/** Barrel for the audio view (T-3.8). */

export {
  Rng,
  addCrackle,
  addNoise,
  addTail,
  addTone,
  crossfadeLoop,
  fadeEdges,
  normalise,
  peakOf,
  removeDc,
  rmsOf,
  tremolo,
  wobble,
} from './dsp';
export type { FilterMode } from './dsp';
export { AUDIO_SCENES, AUDIO_TUNING, createAudio } from './engine';
export type {
  AudioEngine,
  AudioOptions,
  AudioScene,
  AudioStats,
  AudioTuning,
  AudioVolumes,
  PadTuning,
} from './engine';
export {
  ABILITY_SOUNDS,
  ASSIST_SOUND,
  CHARGE_SOUNDS,
  COUNTDOWN_TICK_SOUND,
  FLIGHT_SOUNDS,
  HIT_CONFIRM_SOUND,
  HIT_SHIELD_SOUND,
  HIT_SOUNDS,
  IMPACT_SOUNDS,
  OBJECTIVE_SOUNDS,
  PHASE_SOUNDS,
  RESULT_SOUNDS,
  SPAWN_SOUND,
  STATUS_SOUNDS,
  SUSTAIN_SOUNDS,
  TAKEDOWN_CONFIRM_SOUND,
  TAKEDOWN_SOUND,
  UI_SOUNDS,
  UI_SOUND_IDS,
  eventSound,
  localFeedbackSound,
  resultSound,
} from './sound-table';
export type { LocalContext, UiSoundId } from './sound-table';
export {
  LOOP_OVERLAP_S,
  PRIORITY_COMBAT,
  PRIORITY_CRITICAL,
  PRIORITY_DETAIL,
  PRIORITY_LOCAL,
  PRIORITY_MAJOR,
  RENDER_PEAK,
  RENDER_SAMPLE_RATE,
  SOUND_BUSES,
  SOUND_COUNT,
  SOUND_DEFS,
  SOUND_DEF_LIST,
  SOUND_IDS,
  renderSound,
  soundIndexOf,
  soundLength,
} from './sounds';
export type { SoundBus, SoundDef, SoundGenerator, SoundId } from './sounds';
export {
  SPATIAL_TUNING,
  createListenerFrame,
  createSpatialResult,
  distanceCutoffHz,
  distanceGain,
  spatialise,
  writeListenerFrame,
} from './spatial';
export type { AudioListener, ListenerFrame, SpatialResult, SpatialTuning } from './spatial';
export { AGE_BUCKET_S, MAX_VOICES, NO_VOICE, VoiceAllocator } from './voices';
