import React from "react";
import { AlertButton, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Colors } from "@/constants/colors";
import { useDialogStore } from "@/lib/dialog";

// Renderer for showDialog() on every platform (web and native), so dialogs
// share the app's design. Android back closes it only when cancelable.
export function DialogHost() {
  const dialog = useDialogStore((s) => s.queue[0]);
  const shift = useDialogStore((s) => s.shift);

  if (!dialog) return null;

  const press = (button: AlertButton) => {
    shift();
    button.onPress?.();
  };

  const dismiss = () => {
    if (!dialog.cancelable) return;
    shift();
    dialog.onDismiss?.();
  };

  return (
    <Modal transparent visible statusBarTranslucent animationType="fade" onRequestClose={dismiss}>
      <Pressable style={styles.backdrop} onPress={dismiss}>
        <Pressable style={styles.card} onPress={() => {}} accessibilityRole="alert">
          <Text style={styles.title}>{dialog.title}</Text>
          {dialog.message ? <Text style={styles.message}>{dialog.message}</Text> : null}
          <View style={[styles.buttons, dialog.buttons.length > 2 && styles.buttonsStacked]}>
            {dialog.buttons.map((button, i) => (
              <Pressable
                key={`${dialog.id}-${i}`}
                onPress={() => press(button)}
                style={({ pressed }) => [
                  styles.button,
                  dialog.buttons.length > 2 && styles.buttonStacked,
                  button.style !== "cancel" && styles.buttonPrimary,
                  button.style === "destructive" && styles.buttonDestructive,
                  pressed && styles.buttonPressed,
                ]}
              >
                <Text
                  style={[
                    styles.buttonText,
                    button.style === "cancel" && styles.buttonTextCancel,
                  ]}
                >
                  {button.text ?? "OK"}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: Colors.overlay,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  card: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: Colors.cardDark,
    borderColor: Colors.cardBorderDark,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    gap: 12,
  },
  title: { color: Colors.textPrimaryDark, fontSize: 17, fontWeight: "700" },
  message: { color: Colors.textSecondaryDark, fontSize: 15, lineHeight: 21 },
  buttons: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  buttonsStacked: { flexDirection: "column-reverse", alignItems: "stretch" },
  button: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.cardBorderDark,
  },
  buttonStacked: { width: "100%" },
  buttonPrimary: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  buttonDestructive: { backgroundColor: Colors.error, borderColor: Colors.error },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: Colors.white, fontSize: 15, fontWeight: "600" },
  buttonTextCancel: { color: Colors.textSecondaryDark },
});
