import { Stack, Redirect } from "expo-router";
import { useAuthStore } from "@/store/authStore";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";

export default function AppLayout() {
  const { initialized, isAuthenticated } = useAuthStore();

  if (!initialized) {
    return <LoadingSpinner fullScreen />;
  }

  if (!isAuthenticated) {
    return <Redirect href="/(auth)/welcome" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: "#0B0D10" },
        animation: "none",
      }}
    />
  );
}
