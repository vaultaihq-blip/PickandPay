import { Stack } from "expo-router";
import { useColorScheme } from "react-native";
import { Colors } from "@/constants/colors";

export default function AuthLayout() {
  const isDark = useColorScheme() === "dark";
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: {
          backgroundColor: isDark ? Colors.bgDark : Colors.bgLight,
        },
      }}
    >
      <Stack.Screen name="welcome" />
      <Stack.Screen name="profile-setup" />
      <Stack.Screen name="forgot-password" />
      <Stack.Screen name="reset-password" />
    </Stack>
  );
}
