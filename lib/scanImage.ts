import * as ImageManipulator from "expo-image-manipulator";
import type { ImagePickerAsset } from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Scan fixes, point 1 — the receipt photo is reduced from the file before it
// is ever turned into base64, in one pass that also bakes the EXIF
// orientation into the pixels (Vision's boxes come back in raw pixel space,
// so the pixels must be upright). The full-size original is never held as
// base64: a 50–200 MP photo did that several times over and the OS killed
// the app on "Scan receipt".
// 3200 px at 0.8 chosen on 2026-10-31 from 21 corpus reads: same results as
// the original photo; 2400 at 0.7 lost Ramires on all three reads.
export const SCAN_MAX_SIDE = 3200;
export const SCAN_JPEG_QUALITY = 0.8;

const kb = (bytes: number | null | undefined) => (bytes ? Math.round(bytes / 1024) : 0);

export async function prepareScanImage(
  asset: ImagePickerAsset,
  source: "camera" | "gallery"
): Promise<{ uri: string; base64: string }> {
  console.log(`[scan] photo taken ${asset.width}x${asset.height}, ${kb(asset.fileSize)} KB (${source})`);
  const resizeTo = (w: number, h: number): ImageManipulator.Action[] =>
    Math.max(w, h) > SCAN_MAX_SIDE ? [{ resize: w >= h ? { width: SCAN_MAX_SIDE } : { height: SCAN_MAX_SIDE } }] : [];
  const save = { compress: SCAN_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true };

  let result = await ImageManipulator.manipulateAsync(asset.uri, resizeTo(asset.width, asset.height), save);
  // The picker's width/height may be before the EXIF turn; if the long side
  // came out on the other axis, resize the (already smaller) result once more.
  if (Math.max(result.width, result.height) > SCAN_MAX_SIDE * 1.02) {
    console.log(`[scan] resize landed on the short side (${result.width}x${result.height}) — resizing again`);
    result = await ImageManipulator.manipulateAsync(result.uri, resizeTo(result.width, result.height), save);
  }
  const b64 = result.base64 ?? "";
  console.log(`[scan] resized ${result.width}x${result.height}, ${kb(b64.length * 0.75)} KB`);
  console.log(`[scan] base64 ${kb(b64.length)} KB`);
  return { uri: result.uri, base64: b64 ? `data:image/jpeg;base64,${b64}` : result.uri };
}

// A scan that was cut short (the OS restarted the app with the camera open,
// while reducing the photo, or while waiting for the server) is noticed at
// the next start: "The previous scan did not finish."
const SCAN_MARK_KEY = "pp.scan_in_progress";

export async function markScanStep(step: "camera" | "gallery" | "sending"): Promise<void> {
  try {
    await AsyncStorage.setItem(SCAN_MARK_KEY, JSON.stringify({ step, at: Date.now() }));
  } catch {
    // best effort: the notice is a convenience
  }
}

export async function clearScanMark(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SCAN_MARK_KEY);
  } catch {
    // best effort
  }
}

/** The step a scan was at when the app stopped, if that was in the last hour. Clears it. */
export async function takeInterruptedScan(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(SCAN_MARK_KEY);
    if (!raw) return null;
    await AsyncStorage.removeItem(SCAN_MARK_KEY);
    const mark = JSON.parse(raw) as { step?: string; at?: number };
    if (!mark.at || Date.now() - mark.at > 60 * 60 * 1000) return null;
    return mark.step ?? "unknown";
  } catch {
    return null;
  }
}
