/**
 * Image editor screen — mandatory crop step between capture/gallery and OCR.
 * Crops (or, on skip, just normalizes) the photo via expo-image-manipulator,
 * then hands off to receipt-preview.tsx for rotation and analysis.
 */
import React, { useRef, useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  PanResponder,
  Dimensions,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImageManipulator from "expo-image-manipulator";
import { Colors } from "@/constants/colors";
import { useReceiptStore } from "@/store/receiptStore";
import { showDialog } from "@/lib/dialog";

const { width: SCREEN_W } = Dimensions.get("window");
const CORNER = 28; // corner handle touch target
const MIN_CROP = 0.15; // minimum crop box size (fraction)
const MAX_SIDE = 2000; // cap the longer side so GPT-4o Vision gets a consistently sized image

type CropBox = { x: number; y: number; w: number; h: number }; // all 0-1 fractions

// The rect the image actually occupies inside its container once resizeMode="contain"
// letterboxing is accounted for — offsetX/offsetY are the top-left of that rect,
// width/height its size, all in the same pixel units as the container.
type DisplayedRect = { offsetX: number; offsetY: number; width: number; height: number };

/**
 * Width to pass to ImageManipulator's resize action so the longer side ends
 * up at MAX_SIDE, preserving aspect ratio (the other dimension is derived
 * automatically when only `width` is given). Returns null when the image is
 * already within bounds and no resize is needed.
 */
function computeResizeWidth(width: number, height: number): number | null {
  const longer = Math.max(width, height);
  if (longer <= MAX_SIDE) return null;
  return Math.round(width * (MAX_SIDE / longer));
}

/**
 * Computes the rect a resizeMode="contain" image occupies inside its container.
 * "Contain" scales the image to fit without cropping, which letterboxes on one
 * axis whenever the image's aspect ratio doesn't match the container's — the
 * returned rect is the actual image area (excluding those bars), which is what
 * crop fractions must be measured against, not the raw container.
 */
function computeDisplayedImageRect(
  containerW: number,
  containerH: number,
  naturalW: number,
  naturalH: number
): DisplayedRect {
  const containerAspect = containerW / containerH;
  const imageAspect = naturalW / naturalH;

  if (imageAspect > containerAspect) {
    // Bars top/bottom — the image fills the full width.
    const width = containerW;
    const height = containerW / imageAspect;
    return { offsetX: 0, offsetY: (containerH - height) / 2, width, height };
  } else {
    // Bars left/right — the image fills the full height.
    const height = containerH;
    const width = containerH * imageAspect;
    return { offsetX: (containerW - width) / 2, offsetY: 0, width, height };
  }
}

export default function ImageEditorScreen() {
  const { pendingImageUri, setPendingImage } = useReceiptStore();

  const [imageUri] = useState(pendingImageUri ?? "");
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Crop box as fraction of displayed image area (0–1)
  const cropRef = useRef<CropBox>({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 });
  const [cropBox, setCropBox] = useState<CropBox>(cropRef.current);

  // Snapshot of cropRef taken at gesture start — the fixed base for all
  // delta math during that gesture, so mid-gesture re-renders (which can
  // race the frame where cropRef is updated) never perturb the calculation.
  const grantSnapshot = useRef<CropBox>(cropRef.current);

  // Actual pixel size of the image display CONTAINER (set via onLayout). Kept as both
  // a ref (for synchronous reads inside PanResponder callbacks, which are created once
  // and never see fresh React state) and mirrored into state below to trigger re-renders.
  const imageBoundsRef = useRef({ w: SCREEN_W, h: SCREEN_W * 1.4 });
  const [containerSize, setContainerSize] = useState({ w: SCREEN_W, h: SCREEN_W * 1.4 });

  // The rect the image itself occupies within that container (resizeMode="contain" can
  // letterbox). Crop fractions are relative to THIS, not the raw container. Ref for the
  // same reason as imageBoundsRef — PanResponder callbacks need a synchronous fresh read.
  const displayedRectRef = useRef<DisplayedRect>({
    offsetX: 0,
    offsetY: 0,
    width: imageBoundsRef.current.w,
    height: imageBoundsRef.current.h,
  });

  useEffect(() => {
    if (!imageUri) return;
    Image.getSize(
      imageUri,
      (w, h) => setNaturalSize({ w, h }),
      () => setNaturalSize(null)
    );
  }, [imageUri]);

  // Recompute the displayed image rect whenever the natural image size resolves or the
  // container is laid out/resized (containerSize state changes track imageBoundsRef).
  useEffect(() => {
    const { w: bw, h: bh } = imageBoundsRef.current;
    displayedRectRef.current = naturalSize
      ? computeDisplayedImageRect(bw, bh, naturalSize.w, naturalSize.h)
      : { offsetX: 0, offsetY: 0, width: bw, height: bh };
  }, [naturalSize, containerSize]);

  // ── Crop PanResponder helpers ────────────────────────────────────────────────

  function makePanResponder(
    corner: "TL" | "TR" | "BL" | "BR"
  ) {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        grantSnapshot.current = { ...cropRef.current };
      },
      onPanResponderMove: (_, gs) => {
        const { width: dw, height: dh } = displayedRectRef.current;
        const c = grantSnapshot.current; // fixed for the whole gesture
        const dx = gs.dx / dw;
        const dy = gs.dy / dh;

        let { x, y, w, h } = c;

        if (corner === "TL" || corner === "BL") {
          const newX = Math.max(0, Math.min(x + w - MIN_CROP, x + dx));
          w = w - (newX - x);
          x = newX;
        }
        if (corner === "TR" || corner === "BR") {
          w = Math.max(MIN_CROP, Math.min(1 - x, w + dx));
        }
        if (corner === "TL" || corner === "TR") {
          const newY = Math.max(0, Math.min(y + h - MIN_CROP, y + dy));
          h = h - (newY - y);
          y = newY;
        }
        if (corner === "BL" || corner === "BR") {
          h = Math.max(MIN_CROP, Math.min(1 - y, h + dy));
        }

        const next: CropBox = { x, y, w, h };
        cropRef.current = next;
        setCropBox({ ...next });
      },
    });
  }

  // Create once (refs are stable across renders)
  const panTL = useRef(makePanResponder("TL")).current;
  const panTR = useRef(makePanResponder("TR")).current;
  const panBL = useRef(makePanResponder("BL")).current;
  const panBR = useRef(makePanResponder("BR")).current;

  // ── Crop + normalize, then hand off to receipt-preview ──────────────────────

  const finalizeAndContinue = useCallback(
    async (useCrop: boolean) => {
      if (isProcessing || !imageUri) return;
      setIsProcessing(true);
      try {
        const actions: ImageManipulator.Action[] = [];
        let baseW = naturalSize?.w ?? 0;
        let baseH = naturalSize?.h ?? 0;

        if (useCrop) {
          if (!naturalSize) throw new Error("SIZE_UNAVAILABLE");
          const c = cropRef.current;
          const originX = Math.round(c.x * naturalSize.w);
          const originY = Math.round(c.y * naturalSize.h);
          // Clamp so rounding can never push the crop rectangle past the image bounds.
          const cropWidth = Math.min(Math.round(c.w * naturalSize.w), naturalSize.w - originX);
          const cropHeight = Math.min(Math.round(c.h * naturalSize.h), naturalSize.h - originY);
          actions.push({ crop: { originX, originY, width: cropWidth, height: cropHeight } });
          baseW = cropWidth;
          baseH = cropHeight;
        }

        if (baseW > 0 && baseH > 0) {
          const resizeWidth = computeResizeWidth(baseW, baseH);
          if (resizeWidth !== null) {
            actions.push({ resize: { width: resizeWidth } });
          }
        }

        const result = await ImageManipulator.manipulateAsync(
          imageUri,
          actions,
          { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true }
        );

        setPendingImage(result.uri, `data:image/jpeg;base64,${result.base64}`);
        router.push("/(app)/receipt-preview");
      } catch {
        showDialog(
          "Couldn't Process Image",
          "Something went wrong preparing this photo. Please try again.",
          [{ text: "OK" }]
        );
      } finally {
        setIsProcessing(false);
      }
    },
    [imageUri, naturalSize, isProcessing, setPendingImage]
  );

  if (!imageUri) {
    router.back();
    return null;
  }

  // ── Crop overlay geometry ────────────────────────────────────────────────────
  const bw = containerSize.w;
  const bh = containerSize.h;
  const displayedRect: DisplayedRect = naturalSize
    ? computeDisplayedImageRect(bw, bh, naturalSize.w, naturalSize.h)
    : { offsetX: 0, offsetY: 0, width: bw, height: bh };
  const cx = displayedRect.offsetX + cropBox.x * displayedRect.width;
  const cy = displayedRect.offsetY + cropBox.y * displayedRect.height;
  const cw = cropBox.w * displayedRect.width;
  const ch = cropBox.h * displayedRect.height;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: "#000" }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="close" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Edit Receipt Photo</Text>
        <View style={{ width: 26 }} />
      </View>

      {/* Image with crop overlay */}
      <View
        style={styles.imageContainer}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          imageBoundsRef.current = { w: width, h: height };
          setContainerSize({ w: width, h: height });
        }}
      >
        <Image
          source={{ uri: imageUri }}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
        />

        {/* Dim outside crop box — bounded to the displayed image rect, not the raw
            container, so the letterbox bars (already black) are left alone rather
            than being treated as part of the selectable area. */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {/* Top */}
          <View
            style={[
              styles.dimOverlay,
              { top: displayedRect.offsetY, left: displayedRect.offsetX, width: displayedRect.width, height: cy - displayedRect.offsetY },
            ]}
          />
          {/* Bottom */}
          <View
            style={[
              styles.dimOverlay,
              {
                top: cy + ch,
                left: displayedRect.offsetX,
                width: displayedRect.width,
                height: displayedRect.offsetY + displayedRect.height - (cy + ch),
              },
            ]}
          />
          {/* Left */}
          <View style={[styles.dimOverlay, { top: cy, left: displayedRect.offsetX, width: cx - displayedRect.offsetX, height: ch }]} />
          {/* Right */}
          <View
            style={[
              styles.dimOverlay,
              { top: cy, left: cx + cw, width: displayedRect.offsetX + displayedRect.width - (cx + cw), height: ch },
            ]}
          />
          {/* Crop box border */}
          <View style={[styles.cropBorder, { left: cx, top: cy, width: cw, height: ch }]} />
        </View>

        {/* Corner handles */}
        {!isProcessing && (
          <>
            <View style={[styles.cornerHandle, { left: cx - CORNER / 2, top: cy - CORNER / 2 }]} {...panTL.panHandlers} />
            <View style={[styles.cornerHandle, { left: cx + cw - CORNER / 2, top: cy - CORNER / 2 }]} {...panTR.panHandlers} />
            <View style={[styles.cornerHandle, { left: cx - CORNER / 2, top: cy + ch - CORNER / 2 }]} {...panBL.panHandlers} />
            <View style={[styles.cornerHandle, { left: cx + cw - CORNER / 2, top: cy + ch - CORNER / 2 }]} {...panBR.panHandlers} />
          </>
        )}

        {isProcessing && (
          <View style={styles.processingOverlay} pointerEvents="none">
            <ActivityIndicator color="#fff" size="large" />
            <Text style={styles.processingOverlayText}>Preparing image…</Text>
          </View>
        )}
      </View>

      {/* Toolbar */}
      <View style={styles.toolbar}>
        <ToolBtn
          icon="refresh"
          label="Reset Crop"
          disabled={isProcessing}
          onPress={() => {
            const init: CropBox = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
            cropRef.current = init;
            setCropBox(init);
          }}
        />
      </View>

      {/* Actions */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.skipBtn, { borderColor: "rgba(255,255,255,0.3)" }, isProcessing && { opacity: 0.5 }]}
          onPress={() => finalizeAndContinue(false)}
          disabled={isProcessing}
          activeOpacity={0.8}
        >
          <Ionicons name="image-outline" size={16} color="rgba(255,255,255,0.85)" />
          <Text style={styles.skipBtnText}>Skip Crop — Use Full Image</Text>
        </TouchableOpacity>

        <View style={styles.footerRow}>
          <TouchableOpacity
            style={[styles.cancelBtn, { borderColor: "rgba(255,255,255,0.3)" }, isProcessing && { opacity: 0.5 }]}
            onPress={() => router.back()}
            disabled={isProcessing}
          >
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.confirmBtn, isProcessing && { opacity: 0.6 }]}
            onPress={() => finalizeAndContinue(true)}
            disabled={isProcessing}
            activeOpacity={0.85}
          >
            {isProcessing ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                <Text style={styles.confirmBtnText}>Confirm Crop</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

function ToolBtn({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity style={[styles.toolBtn, disabled && { opacity: 0.5 }]} onPress={onPress} activeOpacity={0.7} disabled={disabled}>
      <Ionicons name={icon as any} size={22} color="#fff" />
      <Text style={styles.toolBtnLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#000",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  imageContainer: {
    flex: 1,
    position: "relative",
    backgroundColor: "#111",
  },
  dimOverlay: {
    position: "absolute",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  cropBorder: {
    position: "absolute",
    borderWidth: 2,
    borderColor: "#fff",
  },
  cornerHandle: {
    position: "absolute",
    width: CORNER,
    height: CORNER,
    backgroundColor: "transparent",
    borderWidth: 3,
    borderColor: Colors.primary,
    borderRadius: 4,
  },
  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
    gap: 12,
  },
  processingOverlayText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  toolbar: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingVertical: 12,
    paddingHorizontal: 8,
    backgroundColor: "#111",
  },
  toolBtn: {
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  toolBtnLabel: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 10,
    textAlign: "center",
  },
  footer: {
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 24,
    paddingTop: 12,
    backgroundColor: "#000",
  },
  skipBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  skipBtnText: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 13,
    fontWeight: "600",
  },
  footerRow: {
    flexDirection: "row",
    gap: 12,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  confirmBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: Colors.primary,
  },
  confirmBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
});
