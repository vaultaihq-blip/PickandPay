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
import { WebQRCamera, isWebCameraSupported } from "./WebQRCamera";

interface QRScannerProps {
  onScan: (data: string) => void;
  onClose: () => void;
  /** R8 — the session code typed by hand (normalised by the caller's RPC). */
  onCode: (code: string) => void;
  codeBusy?: boolean;
  /** Stays on screen until the next attempt. */
  codeError?: string | null;
}

type NoCamera = "denied" | "device" | null;

// R8 — the session code field, the same on native and on the web.
function CodePanel({
  onCode, codeBusy, codeError, reason, title, children,
}: Pick<QRScannerProps, "onCode" | "codeBusy" | "codeError"> & { reason: string | null; title: string; children?: React.ReactNode }) {
  const { t } = useI18nStore();
  const [code, setCode] = useState("");
  const submit = () => {
    const c = normalizeJoinCode(code);
    if (!c || codeBusy) return;
    onCode(c);
  };
  return (
    <View style={styles.panel}>
      {reason && (
        <View style={styles.reasonRow}>
          <Ionicons name="videocam-off-outline" size={16} color={Colors.warning} />
          <Text style={styles.reasonText}>{reason}</Text>
        </View>
      )}
      <Text style={styles.panelTitle}>{title}</Text>
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
      {children}
    </View>
  );
}

// R8 — one screen, two ways in: the camera and the session code.
export function QRScanner(props: QRScannerProps) {
  return Platform.OS === "web" ? <WebScanner {...props} /> : <NativeScanner {...props} />;
}

// Web: the camera (getUserMedia + BarcodeDetector / jsQR) opens by default
// when the browser can; "Enter session code instead" switches to the code
// panel, which links back to the camera. Whatever the camera reads goes to
// the same onScan as on native.
function WebScanner({ onScan, onClose, onCode, codeBusy, codeError }: QRScannerProps) {
  const { t, language } = useI18nStore();
  void language;
  const cameraOk = isWebCameraSupported();
  const [mode, setMode] = useState<"camera" | "code">(cameraOk ? "camera" : "code");
  useEffect(() => {
    if (!cameraOk) console.log("[join] no camera (browser) — showing the session code field");
  }, [cameraOk]);

  if (mode === "camera") {
    return <WebQRCamera onScan={onScan} onClose={onClose} onUseCode={() => setMode("code")} />;
  }
  return (
    <KeyboardAvoidingView style={styles.container}>
      <View style={styles.cameraArea}>
        <View style={styles.noCameraArt}>
          <Ionicons name="keypad-outline" size={64} color={Colors.primary} />
        </View>
        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
          <Ionicons name="close" size={28} color="#fff" />
        </TouchableOpacity>
      </View>
      <CodePanel
        onCode={onCode}
        codeBusy={codeBusy}
        codeError={codeError}
        reason={cameraOk ? null : t("join_no_camera_browser")}
        title={t("join_code_label")}
      >
        {cameraOk && (
          <TouchableOpacity style={[styles.linkBtn, styles.linkRow]} onPress={() => setMode("camera")}>
            <Ionicons name="camera-outline" size={18} color={Colors.primary} />
            <Text style={styles.linkText}>{t("join_scan_with_camera")}</Text>
          </TouchableOpacity>
        )}
      </CodePanel>
    </KeyboardAvoidingView>
  );
}

// Native: expo-camera on top, the code panel always below it. Without a
// camera — permission refused or no device — the code field is what shows,
// with a line saying why.
function NativeScanner({ onScan, onClose, onCode, codeBusy, codeError }: QRScannerProps) {
  const { t, language } = useI18nStore();
  void language;
  const [scanned, setScanned] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [mountFailed, setMountFailed] = useState(false);

  // Ask once, straight away, when the OS still lets us.
  useEffect(() => {
    if (!permission) return;
    if (!permission.granted && permission.canAskAgain && permission.status === "undetermined") {
      void requestPermission();
    }
  }, [permission?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const noCamera: NoCamera = mountFailed
    ? "device"
    : permission && !permission.granted && permission.status === "denied"
      ? "denied"
      : null;
  const cameraOn = !noCamera && !!permission?.granted;

  useEffect(() => {
    if (noCamera) console.log(`[join] no camera (${noCamera}) — showing the session code field`);
  }, [noCamera]);

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);
    onScan(data);
  };

  const reason =
    noCamera === "denied" ? t("join_no_camera_denied")
    : noCamera === "device" ? t("join_no_camera_device")
    : null;

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : "height"}>
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
            {!permission ? (
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
      <CodePanel
        onCode={onCode}
        codeBusy={codeBusy}
        codeError={codeError}
        reason={reason}
        title={cameraOn ? t("join_code_or") : t("join_code_label")}
      >
        {noCamera === "denied" && (
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={() => (permission?.canAskAgain ? void requestPermission() : void Linking.openSettings())}
          >
            <Text style={styles.linkText}>{permission?.canAskAgain ? t("join_camera_allow") : t("join_camera_settings")}</Text>
          </TouchableOpacity>
        )}
      </CodePanel>
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
  linkRow: { flexDirection: "row", alignItems: "center", gap: 8 },
});
