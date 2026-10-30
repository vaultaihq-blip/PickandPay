// Web-only QR scanner: live camera via getUserMedia, decoded with the
// browser's BarcodeDetector when it supports QR (Chrome/Android) and with
// jsQR everywhere else (Safari/iOS, Firefox). Needs HTTPS (or localhost).
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import jsQR from "jsqr";
import { Colors } from "@/constants/colors";
import { useI18nStore } from "@/store/i18nStore";

type Status = "starting" | "scanning" | "scanned" | "denied" | "unavailable";

interface Props {
  onScan: (data: string) => void;
  onClose: () => void;
  onUseCode: () => void;
}

export function isWebCameraSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    window.isSecureContext !== false
  );
}

async function makeNativeDetector(): Promise<any | null> {
  const BD = (globalThis as any).BarcodeDetector;
  if (!BD) return null;
  try {
    const formats: string[] = (await BD.getSupportedFormats?.()) ?? [];
    if (!formats.includes("qr_code")) return null;
    return new BD({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

export function WebQRCamera({ onScan, onClose, onUseCode }: Props) {
  const { t, language } = useI18nStore();
  void language;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<number | null>(null);
  const doneRef = useRef(false);
  const [status, setStatus] = useState<Status>("starting");
  const [attempt, setAttempt] = useState(0);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const stop = useCallback(() => {
    if (loopRef.current != null) cancelAnimationFrame(loopRef.current);
    loopRef.current = null;
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!isWebCameraSupported()) {
      setStatus("unavailable");
      return;
    }
    let cancelled = false;
    doneRef.current = false;
    setStatus("starting");

    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (err: any) {
        if (cancelled) return;
        const name = err?.name ?? "";
        console.log(`[join] web camera refused: ${name || "unknown"}`);
        setStatus(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable");
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      streamRef.current = stream;
      for (let i = 0; i < 20 && !videoRef.current && !cancelled; i++) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      const video = videoRef.current;
      if (!video || cancelled) return;
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      video.muted = true;
      try { await video.play(); } catch {}
      if (cancelled) return;
      setStatus("scanning");

      const detector = await makeNativeDetector();
      console.log(`[join] web camera on (${detector ? "BarcodeDetector" : "jsQR"})`);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
      let last = 0;
      let busy = false;

      const found = (data: string) => {
        if (doneRef.current || !data) return;
        doneRef.current = true;
        stop();
        setStatus("scanned");
        onScanRef.current(data);
      };

      const tick = async (now: number) => {
        if (cancelled || doneRef.current) return;
        loopRef.current = requestAnimationFrame(tick);
        if (busy || now - last < 150 || video.readyState < 2 || !video.videoWidth) return;
        last = now;
        busy = true;
        try {
          if (detector) {
            const codes = await detector.detect(video);
            if (codes?.[0]?.rawValue) found(codes[0].rawValue);
          } else if (ctx) {
            const scale = Math.min(1, 640 / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (code?.data) found(code.data);
          }
        } catch {}
        busy = false;
      };
      loopRef.current = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [attempt, stop]);

  const close = () => { stop(); onClose(); };
  const useCode = () => { stop(); onUseCode(); };

  if (status === "denied" || status === "unavailable") {
    return (
      <View style={styles.centered}>
        <TouchableOpacity style={styles.closeBtn} onPress={close}>
          <Ionicons name="close" size={28} color="#fff" />
        </TouchableOpacity>
        <Ionicons name="camera-outline" size={48} color="rgba(255,255,255,0.5)" />
        <Text style={styles.message}>
          {status === "denied" ? t("join_web_camera_denied") : t("join_no_camera_browser")}
        </Text>
        {status === "denied" && (
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setAttempt((a) => a + 1)}>
            <Text style={styles.primaryBtnText}>{t("join_try_again")}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={status === "denied" ? styles.secondaryBtn : styles.primaryBtn} onPress={useCode}>
          <Text style={status === "denied" ? styles.secondaryBtnText : styles.primaryBtnText}>{t("join_enter_code_btn")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {React.createElement("video", {
        ref: videoRef,
        autoPlay: true,
        muted: true,
        playsInline: true,
        style: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "cover", backgroundColor: "#000" },
      })}

      <View style={styles.overlay}>
        <TouchableOpacity style={styles.closeBtn} onPress={close}>
          <Ionicons name="close" size={28} color="#fff" />
        </TouchableOpacity>

        <View style={styles.scanArea}>
          <View style={[styles.corner, styles.topLeft]} />
          <View style={[styles.corner, styles.topRight]} />
          <View style={[styles.corner, styles.bottomLeft]} />
          <View style={[styles.corner, styles.bottomRight]} />
        </View>

        <Text style={styles.hint}>
          {status === "starting" ? t("join_web_camera_opening") : t("join_scan_hint")}
        </Text>

        {status === "scanned" && (
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setAttempt((a) => a + 1)}>
            <Text style={styles.primaryBtnText}>{t("join_scan_again")}</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.codeLink} onPress={useCode}>
          <Ionicons name="keypad-outline" size={18} color="rgba(255,255,255,0.85)" />
          <Text style={styles.codeLinkText}>{t("join_use_code_instead")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const CORNER_SIZE = 24;
const CORNER_THICKNESS = 3;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000", overflow: "hidden" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#000", paddingHorizontal: 40, gap: 16 },
  message: { color: "rgba(255,255,255,0.8)", fontSize: 15, textAlign: "center", lineHeight: 21, marginBottom: 8 },
  overlay: { flex: 1, alignItems: "center", justifyContent: "center" },
  closeBtn: { position: "absolute", top: 60, right: 24, padding: 8, zIndex: 2 },
  scanArea: { width: 240, height: 240, position: "relative" },
  corner: { position: "absolute", width: CORNER_SIZE, height: CORNER_SIZE, borderColor: Colors.primary },
  topLeft: { top: 0, left: 0, borderTopWidth: CORNER_THICKNESS, borderLeftWidth: CORNER_THICKNESS, borderTopLeftRadius: 4 },
  topRight: { top: 0, right: 0, borderTopWidth: CORNER_THICKNESS, borderRightWidth: CORNER_THICKNESS, borderTopRightRadius: 4 },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: CORNER_THICKNESS, borderLeftWidth: CORNER_THICKNESS, borderBottomLeftRadius: 4 },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: CORNER_THICKNESS, borderRightWidth: CORNER_THICKNESS, borderBottomRightRadius: 4 },
  hint: { color: "rgba(255,255,255,0.7)", fontSize: 14, marginTop: 32, textAlign: "center", paddingHorizontal: 40 },
  primaryBtn: { marginTop: 24, backgroundColor: Colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  primaryBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  secondaryBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" },
  secondaryBtnText: { color: "rgba(255,255,255,0.85)", fontWeight: "600", fontSize: 15 },
  codeLink: { position: "absolute", bottom: 56, flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12, paddingHorizontal: 20, borderRadius: 24, backgroundColor: "rgba(0,0,0,0.55)" },
  codeLinkText: { color: "rgba(255,255,255,0.85)", fontSize: 14, fontWeight: "600" },
});
