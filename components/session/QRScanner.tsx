import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
  useColorScheme,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";

interface QRScannerProps {
  onScan: (data: string) => void;
  onClose: () => void;
}

// Web fallback — camera APIs aren't available in the browser
function WebManualInput({ onScan, onClose }: QRScannerProps) {
  const [code, setCode] = useState("");
  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  return (
    <View style={[web.container, { backgroundColor: bgColor }]}>
      <TouchableOpacity style={web.closeBtn} onPress={onClose}>
        <Ionicons name="close" size={28} color={textColor} />
      </TouchableOpacity>

      <Ionicons name="qr-code-outline" size={72} color={Colors.primary} />
      <Text style={[web.title, { color: textColor }]}>Enter Session Code</Text>
      <Text style={[web.subtitle, { color: mutedColor }]}>
        Camera scanning isn't available on web. Paste or type the session code
        shared with you.
      </Text>

      <TextInput
        style={[web.input, { color: textColor, backgroundColor: cardColor, borderColor: Colors.primary }]}
        placeholder="e.g. session_1234abcd"
        placeholderTextColor={mutedColor}
        value={code}
        onChangeText={setCode}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={() => code.trim() && onScan(code.trim())}
        returnKeyType="join"
      />

      <TouchableOpacity
        style={[web.joinBtn, !code.trim() && { opacity: 0.4 }]}
        onPress={() => code.trim() && onScan(code.trim())}
        disabled={!code.trim()}
      >
        <Text style={web.joinBtnText}>Join Session</Text>
      </TouchableOpacity>
    </View>
  );
}

export function QRScanner({ onScan, onClose }: QRScannerProps) {
  const [scanned, setScanned] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  if (Platform.OS === "web") {
    return <WebManualInput onScan={onScan} onClose={onClose} />;
  }

  // Permission not yet determined
  if (!permission) {
    return (
      <View style={styles.centered}>
        <Text style={styles.centeredText}>Requesting camera permission…</Text>
      </View>
    );
  }

  // Permission denied — offer grant + cancel
  if (!permission.granted) {
    return (
      <View style={styles.centered}>
        <Ionicons name="camera-outline" size={48} color="rgba(255,255,255,0.5)" />
        <Text style={[styles.centeredText, { marginTop: 16, marginBottom: 24, paddingHorizontal: 40, textAlign: "center" }]}>
          Camera access is needed to scan QR codes.
        </Text>
        <TouchableOpacity style={styles.grantBtn} onPress={requestPermission}>
          <Text style={styles.grantBtnText}>Grant Permission</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cancelLink} onPress={onClose}>
          <Text style={styles.cancelLinkText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);
    onScan(data);
  };

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
      />

      <View style={styles.overlay}>
        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
          <Ionicons name="close" size={28} color="#fff" />
        </TouchableOpacity>

        <View style={styles.scanArea}>
          <View style={[styles.corner, styles.topLeft]} />
          <View style={[styles.corner, styles.topRight]} />
          <View style={[styles.corner, styles.bottomLeft]} />
          <View style={[styles.corner, styles.bottomRight]} />
        </View>

        <Text style={styles.hint}>Point camera at a Pick&Pay QR code</Text>

        {scanned && (
          <TouchableOpacity
            style={styles.rescanBtn}
            onPress={() => setScanned(false)}
          >
            <Text style={styles.rescanText}>Tap to Scan Again</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ─── Camera scanner styles ─────────────────────────────────────────────────────

const CORNER_SIZE = 24;
const CORNER_THICKNESS = 3;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000",
  },
  centeredText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 15,
  },
  grantBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
  },
  grantBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  cancelLink: {
    marginTop: 16,
    padding: 8,
  },
  cancelLinkText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 14,
  },
  overlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  closeBtn: {
    position: "absolute",
    top: 60,
    right: 24,
    padding: 8,
  },
  scanArea: {
    width: 240,
    height: 240,
    position: "relative",
  },
  corner: {
    position: "absolute",
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderColor: Colors.primary,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderTopLeftRadius: 4,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderTopRightRadius: 4,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderBottomLeftRadius: 4,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderBottomRightRadius: 4,
  },
  hint: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 14,
    marginTop: 32,
    textAlign: "center",
    paddingHorizontal: 40,
  },
  rescanBtn: {
    marginTop: 24,
    backgroundColor: Colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  rescanText: {
    color: "#fff",
    fontWeight: "600",
  },
});

// ─── Web manual-input styles ───────────────────────────────────────────────────

const web = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 16,
  },
  closeBtn: {
    position: "absolute",
    top: 48,
    right: 24,
    padding: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  input: {
    width: "100%",
    maxWidth: 400,
    borderWidth: 1.5,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    marginTop: 8,
  },
  joinBtn: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
  },
  joinBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
