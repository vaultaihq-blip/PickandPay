import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
  Linking,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useI18nStore } from "@/store/i18nStore";
import { formatJoinCode, JOIN_CODE_LENGTH, normalizeJoinCode } from "@/lib/joinCode";

interface QRScannerProps {
  onScan: (data: string) => void;
  onClose: () => void;
  /** R8 — the session code typed by hand (normalised by the caller's RPC). */
  onCode: (code: string) => void;
  codeBusy?: boolean;
  /** Stays on screen until the next attempt. */
  codeError?: string | null;
}

type NoCamera = "denied" | "device" | "browser" | null;

const webHasCamera = () =>
  Platform.OS !== "web" ||
  (typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function");

// R8 — one screen, two ways in: the camera (when there is one) and the
// session code, always below it. Without a camera — permission refused, no
// device, or a browser that can't use one — the code field is what shows,
// with a line saying why.
export function QRScanner({ onScan, onClose, onCode, codeBusy, codeError }: QRScannerProps) {
  const { t, language } = useI18nStore();
  void language;
  const [scanned, setScanned] = useState(false);
  const [code, setCode] = useState("");
  const [permission, requestPermission] = useCameraPermissions();
  const [mountFailed, setMountFailed] = useState(false);
  // On the web the camera is only tried when asked (a prompt on load is unfriendly).
  const [webCameraWanted, setWebCameraWanted] = useState(false);

  // Native: ask once, straight away, when the OS still lets us.
  useEffect(() => {
    if (Platform.OS === "web" || !permission) return;
    if (!permission.granted && permission.canAskAgain && permission.status === "undetermined") {
      void requestPermission();
    }
  }, [permission?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const noCamera: NoCamera = !webHasCamera()
    ? "browser"
    : mountFailed
      ? "device"
      : permission && !permission.granted && permission.status === "denied"
        ? "denied"
        : null;
  const cameraOn =
    !noCamera && !!permission?.granted && (Platform.OS !== "web" || webCameraWanted);

  useEffect(() => {
    if (noCamera) console.log(`[join] no camera (${noCamera}) — showing the session code field`);
  }, [noCamera]);

  const submit = () => {
    const c = normalizeJoinCode(code);
    if (!c || codeBusy) return;
    onCode(c);
  };

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);
    onScan(data);
  };

  const reason =
    noCamera === "denied" ? t("join_no_camera_denied")
    : noCamera === "device" ? t("join_no_camera_device")
    : noCamera === "browser" ? t("join_no_camera_browser")
    : null;

  const codePanel = (
    <View style={styles.panel}>
      {reason && (
        <View style={styles.reasonRow}>
          <Ionicons name="videocam-off-outline" size={16} color={Colors.warning} />
          <Text style={styles.reasonText}>{reason}</Text>
        </View>
      )}
      <Text style={styles.panelTitle}>{cameraOn ? t("join_code_or") : t("join_code_label")}</Text>
      <View style={styles.codeRow}>
        <TextInput
          style={styles.codeInput}
          placeholder="ABC-234"
          placeholderTextColor="rgba(255,255,255,0.3)"
          value={formatJoinCode(code)}
          onChangeText={(v) => setCode(normalizeJoinCode(v).slice(0, JOIN_CODE_LENGTH))}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          maxLength={JOIN_CODE_LENGTH + 2}
          onSubmitEditing={submit}
          returnKeyType="go"
          accessibilityLabel={t("join_code_label")}
        />
        <TouchableOpacity
          style={[styles.codeBtn, (!code || codeBusy) && { opacity: 0.4 }]}
          onPress={submit}
          disabled={!code || codeBusy}
          activeOpacity={0.85}
        >
          {codeBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.codeBtnText}>{t("join_code_btn")}</Text>}
        </TouchableOpacity>
      </View>
      {!!codeError && <Text style={styles.codeError}>{codeError}</Text>}
      {noCamera === "denied" && Platform.OS !== "web" && (
        <TouchableOpacity
          style={styles.linkBtn}
          onPress={() => (permission?.canAskAgain ? void requestPermission() : void Linking.openSettings())}
        >
          <Text style={styles.linkText}>{permission?.canAskAgain ? t("join_camera_allow") : t("join_camera_settings")}</Text>
        </TouchableOpacity>
      )}
      {Platform.OS === "web" && !noCamera && !cameraOn && (
        <TouchableOpacity
          style={styles.linkBtn}
          onPress={async () => {
            const res = await requestPermission();
            if (res.granted) setWebCameraWanted(true);
          }}
        >
          <Text style={styles.linkText}>{t("join_camera_try")}</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.cameraArea}>
        {cameraOn ? (
          <>
            <CameraView
              style={StyleSheet.absoluteFillObject}
              facing="back"
              onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onMountError={(e) => {
                console.log(`[join] camera failed to start: ${e?.message ?? "unknown"}`);
                setMountFailed(true);
              }}
            />
            <View style={styles.overlay}>
              <View style={styles.scanArea}>
                <View style={[styles.corner, styles.topLeft]} />
                <View style={[styles.corner, styles.topRight]} />
                <View style={[styles.corner, styles.bottomLeft]} />
                <View style={[styles.corner, styles.bottomRight]} />
              </View>
              <Text style={styles.hint}>{t("join_scan_hint")}</Text>
              {scanned && (
                <TouchableOpacity style={styles.rescanBtn} onPress={() => setScanned(false)}>
                  <Text style={styles.rescanText}>{t("join_scan_again")}</Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        ) : (
          <View style={styles.noCameraArt}>
            {!permission && Platform.OS !== "web" ? (
              <ActivityIndicator color="rgba(255,255,255,0.6)" />
            ) : (
              <Ionicons name={noCamera ? "keypad-outline" : "qr-code-outline"} size={64} color={Colors.primary} />
            )}
          </View>
        )}
        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
          <Ionicons name="close" size={28} color="#fff" />
        </TouchableOpacity>
      </View>
      {codePanel}
    </KeyboardAvoidingView>
  );
}

const CORNER_SIZE = 24;
const CORNER_THICKNESS = 3;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  cameraArea: { flex: 1, overflow: "hidden" },
  noCameraArt: { flex: 1, alignItems: "center", justifyContent: "center" },
  overlay: { flex: 1, alignItems: "center", justifyContent: "center" },
  closeBtn: { position: "absolute", top: 52, right: 20, padding: 8 },
  scanArea: { width: 220, height: 220, position: "relative" },
  corner: { position: "absolute", width: CORNER_SIZE, height: CORNER_SIZE, borderColor: Colors.primary },
  topLeft: { top: 0, left: 0, borderTopWidth: CORNER_THICKNESS, borderLeftWidth: CORNER_THICKNESS, borderTopLeftRadius: 4 },
  topRight: { top: 0, right: 0, borderTopWidth: CORNER_THICKNESS, borderRightWidth: CORNER_THICKNESS, borderTopRightRadius: 4 },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: CORNER_THICKNESS, borderLeftWidth: CORNER_THICKNESS, borderBottomLeftRadius: 4 },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: CORNER_THICKNESS, borderRightWidth: CORNER_THICKNESS, borderBottomRightRadius: 4 },
  hint: { color: "rgba(255,255,255,0.75)", fontSize: 14, marginTop: 24, textAlign: "center", paddingHorizontal: 40 },
  rescanBtn: { marginTop: 20, backgroundColor: Colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  rescanText: { color: "#fff", fontWeight: "600" },
  panel: {
    backgroundColor: "#15181D",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 34,
    gap: 10,
  },
  reasonRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  reasonText: { flex: 1, color: "#F8FAFC", fontSize: 13, lineHeight: 18 },
  panelTitle: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "600" },
  codeRow: { flexDirection: "row", gap: 10 },
  codeInput: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: "#252A32",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#F8FAFC",
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 3,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  codeBtn: { backgroundColor: Colors.primary, borderRadius: 12, paddingHorizontal: 20, justifyContent: "center", minWidth: 92, alignItems: "center" },
  codeBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  codeError: { color: "#F87171", fontSize: 13, lineHeight: 18 },
  linkBtn: { alignSelf: "flex-start", paddingVertical: 4 },
  linkText: { color: Colors.primary, fontSize: 14, fontWeight: "600" },
});
