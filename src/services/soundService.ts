// Shared UI sound-effect service.
// -----------------------------------------------------------------------------
// One lazily-created player per effect, reused across calls (avoids reloading
// the bundled asset on every play). Sound is a non-essential nicety layered on
// top of the existing haptic feedback, so playback errors are swallowed —
// never let a missing audio driver or muted device break the add-product flow.
import { createAudioPlayer, type AudioPlayer } from "expo-audio";

const addProductSoundAsset = require("../../assets/sounds/add-product.wav");

let addProductPlayer: AudioPlayer | null = null;

export function playAddProductSound(): void {
  try {
    if (!addProductPlayer) addProductPlayer = createAudioPlayer(addProductSoundAsset);
    void addProductPlayer.seekTo(0).catch(() => {});
    addProductPlayer.play();
  } catch {
    // Non-essential feedback — ignore.
  }
}
