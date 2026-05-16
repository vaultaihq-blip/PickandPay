import { Stack, Redirect } from "expo-router";
import { useAuthStore } from "@/store/authStore";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";

export default function AppLayout() {
  const { initialized, isAuthenticated, isGuest } = useAuthStore();

  if (!initialized) {
    return <LoadingSpinner fullScreen />;
  }

  if (!isAuthenticated && !isGuest) {
    return <Redirect href="/(auth)/welcome" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
