import { AlertButton, AlertOptions } from "react-native";
import { create } from "zustand";

// Drop-in replacement for Alert.alert, rendered by <DialogHost /> (mounted
// once in app/_layout.tsx) on every platform. Web needs it because
// react-native-web implements Alert.alert as a no-op; native uses it too so
// dialogs follow the app's design instead of the system Alert.

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
  useDialogStore.getState().push({
    id: nextId++,
    title,
    message,
    buttons: buttons && buttons.length > 0 ? buttons : [{ text: "OK" }],
    onDismiss: options?.onDismiss,
    cancelable: options?.cancelable ?? false,
  });
}
