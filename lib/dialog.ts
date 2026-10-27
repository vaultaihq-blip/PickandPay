import { Alert, AlertButton, AlertOptions, Platform } from "react-native";
import { create } from "zustand";

// Drop-in replacement for Alert.alert. react-native-web implements
// Alert.alert as a no-op, so on web every error and confirmation shown
// through it simply vanished. Native keeps the system Alert; web queues the
// dialog for <DialogHost /> (mounted once in app/_layout.tsx).

export interface QueuedDialog {
  id: number;
  title: string;
  message?: string;
  buttons: AlertButton[];
  onDismiss?: () => void;
  cancelable: boolean;
}

interface DialogState {
  queue: QueuedDialog[];
  push: (dialog: QueuedDialog) => void;
  shift: () => void;
}

export const useDialogStore = create<DialogState>((set) => ({
  queue: [],
  push: (dialog) => set((s) => ({ queue: [...s.queue, dialog] })),
  shift: () => set((s) => ({ queue: s.queue.slice(1) })),
}));

let nextId = 1;

export function showDialog(
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions
): void {
  if (Platform.OS !== "web") {
    Alert.alert(title, message, buttons, options);
    return;
  }
  useDialogStore.getState().push({
    id: nextId++,
    title,
    message,
    buttons: buttons && buttons.length > 0 ? buttons : [{ text: "OK" }],
    onDismiss: options?.onDismiss,
    cancelable: options?.cancelable ?? false,
  });
}
