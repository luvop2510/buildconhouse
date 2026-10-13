// Optional browser feedback must observe HTMLMediaElement.play() rejections.
// expo-audio's web player returns void while discarding that Promise, allowing
// unsupported codecs/autoplay restrictions to escape as uncaught page errors.
import { Asset } from "expo-asset";

const addProductSoundAsset = require("../../assets/sounds/add-product.wav");
let addProductAudio: HTMLAudioElement | null = null;

export function playAddProductSound(): void {
  try {
    if (typeof Audio === "undefined") return;
    if (!addProductAudio) addProductAudio = new Audio(Asset.fromModule(addProductSoundAsset).uri);
    addProductAudio.currentTime = 0;
    void Promise.resolve(addProductAudio.play()).catch(() => {});
  } catch {
    // Optional feedback must never interrupt adding a product.
  }
}
