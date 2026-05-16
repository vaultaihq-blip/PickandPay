import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  useColorScheme,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { Colors } from "@/constants/colors";
import { AVATAR_OPTIONS } from "@/constants/avatars";
import { useAuthStore } from "@/store/authStore";

export default function AvatarPickerScreen() {
  const isDark = useColorScheme() === "dark";
  const { updateAvatar, profile } = useAuthStore();

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;

  const handleIconSelect = async (iconId: string) => {
    await updateAvatar(undefined, iconId);
    router.back();
  };

  const handleTakePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera Access", "Allow camera access in Settings to take photos.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      await updateAvatar(result.assets[0].uri, undefined);
      router.back();
    }
  };

  const handleUploadPhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      await updateAvatar(result.assets[0].uri, undefined);
      router.back();
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.title, { color: textColor }]}>Choose Avatar</Text>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="close" size={26} color={mutedColor} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Icon grid — shown first */}
        <Text style={[styles.sectionLabel, { color: mutedColor }]}>ICONS</Text>
        <View style={styles.iconGrid}>
          {AVATAR_OPTIONS.map((icon) => {
            const isSelected = profile?.avatarIcon === icon.id;
            return (
              <TouchableOpacity
                key={icon.id}
                style={[
                  styles.iconCell,
                  { backgroundColor: cardColor, borderColor: isSelected ? Colors.primary : borderColor },
                  isSelected && styles.iconCellSelected,
                ]}
                onPress={() => handleIconSelect(icon.id)}
                activeOpacity={0.7}
              >
                <Text style={styles.iconEmoji}>{icon.emoji}</Text>
                <Text style={[styles.iconLabel, { color: isSelected ? Colors.primary : mutedColor }]}>
                  {icon.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Photo options — shown below icons */}
        <Text style={[styles.sectionLabel, { color: mutedColor }]}>PHOTO</Text>
        <View style={styles.photoRow}>
          <TouchableOpacity
            style={[styles.photoBtn, { backgroundColor: cardColor, borderColor }]}
            onPress={handleTakePhoto}
            activeOpacity={0.7}
          >
            <Ionicons name="camera-outline" size={28} color={Colors.primary} />
            <Text style={[styles.photoBtnLabel, { color: textColor }]}>Take Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.photoBtn, { backgroundColor: cardColor, borderColor }]}
            onPress={handleUploadPhoto}
            activeOpacity={0.7}
          >
            <Ionicons name="image-outline" size={28} color={Colors.primary} />
            <Text style={[styles.photoBtnLabel, { color: textColor }]}>Upload Photo</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
  },
  scroll: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    gap: 12,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginTop: 8,
    marginBottom: 4,
  },
  photoRow: {
    flexDirection: "row",
    gap: 12,
  },
  photoBtn: {
    flex: 1,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 20,
    alignItems: "center",
    gap: 8,
  },
  photoBtnLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
  iconGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  iconCell: {
    width: "22%",
    aspectRatio: 1,
    borderRadius: 14,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  iconCellSelected: {
    backgroundColor: Colors.primary + "18",
  },
  iconEmoji: {
    fontSize: 30,
  },
  iconLabel: {
    fontSize: 10,
    fontWeight: "600",
  },
});
