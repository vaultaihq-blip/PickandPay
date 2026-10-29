import { useCallback, useState } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  Modal,
  ScrollView,
  TextInput,
  Share,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { BottomNavBar } from '@/components/ui/BottomNavBar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '@/components/ui/Avatar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore } from '@/store/authStore';
import { useI18nStore } from '@/store/i18nStore';
import { supabase, deleteAccount } from '@/lib/supabase';
import { showDialog } from '@/lib/dialog';
import { LANGUAGE_META, Language } from '@/constants/translations';

const THEME = {
  bg: '#0A0A0F',
  card: '#1A1B26',
  border: '#252A32',
  text: '#FFFFFF',
  muted: '#8B8FA3',
  primary: '#5B68F4',
  danger: '#EF4444',
};

export default function ProfileScreen() {
  const router = useRouter();
  const { profile, user, loadProfile } = useAuthStore();
  const { language, setLanguage, t } = useI18nStore();
  const [loading, setLoading] = useState(true);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [showLangModal, setShowLangModal] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  useFocusEffect(
    useCallback(() => {
      if (user?.id) loadProfile(user.id).finally(() => setLoading(false));
      else setLoading(false);
    }, [user?.id])
  );

  useFocusEffect(
    useCallback(() => {
      setName(profile?.name ?? '');
      setPhone(profile?.phone ?? '');
    }, [profile?.name, profile?.phone])
  );

  async function handleSaveProfile() {
    if (!user?.id) return;
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ name, phone })
        .eq('id', user.id);
      if (error) throw error;
      await loadProfile(user.id);
      setIsEditing(false);
      showDialog(t('profile_saved'), t('profile_saved_msg'));
    } catch {
      showDialog(t('error'), t('profile_error'));
    }
  }

  async function shareApp() {
    const referralLink = user?.id
      ? `pickandpay://join?ref=${user.id}`
      : 'https://play.google.com/store/apps/details?id=com.pickandpay.app';
    await Share.share({
      message: `Join me on Pick&Pay and split bills effortlessly!\n\nUse my link to get free credits when you sign up:\n${referralLink}`,
      title: 'Join Pick&Pay',
    });
  }

  function handleLogout() {
    showDialog(t('profile_logout'), t('profile_logout_confirm'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('profile_logout'),
        style: 'destructive',
        onPress: async () => {
          try {
            await AsyncStorage.clear();
            await supabase.auth.signOut();
            router.replace('/(auth)/welcome');
          } catch {
            showDialog(t('error'), t('profile_logout_error'));
          }
        },
      },
    ]);
  }

  function handleDeleteAccount() {
    showDialog(
      'Eliminar Conta',
      'Tens a certeza? Esta ação é permanente e irá apagar todos os teus dados, sessões e créditos.',
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: 'Continuar',
          onPress: () => {
            showDialog(
              'Confirmação Final',
              'Todos os teus dados serão apagados definitivamente. Não é possível recuperar a conta.',
              [
                { text: t('cancel'), style: 'cancel' },
                {
                  text: 'Eliminar',
                  style: 'destructive',
                  onPress: async () => {
                    setDeletingAccount(true);
                    try {
                      const { error } = await deleteAccount();
                      if (error) throw error;
                      await supabase.auth.signOut();
                      router.replace('/(auth)/welcome');
                    } catch {
                      showDialog(
                        'Erro',
                        'Erro ao eliminar conta. Tenta novamente ou contacta vault.ai.hq@gmail.com'
                      );
                    } finally {
                      setDeletingAccount(false);
                    }
                  },
                },
              ]
            );
          },
        },
      ]
    );
  }

  function handleLanguage() {
    setShowLangModal(true);
  }

  const langLabel = LANGUAGE_META[language]?.label ?? 'English';
  const displayName = profile?.name || user?.email?.split('@')[0] || 'User';
  const displayEmail = user?.email ?? '';

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.centered}>
          <Text style={styles.mutedText}>{t('loading')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.safe}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.centered}>
          <Text style={styles.dangerText}>{t('profile_not_signed')}</Text>
          <Pressable style={styles.primaryBtn} onPress={() => router.replace('/(auth)/welcome')}>
            <Text style={styles.primaryBtnText}>{t('profile_go_login')}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('profile_title')}</Text>
        <TouchableOpacity onPress={() => router.push('/onboarding')} hitSlop={8}>
          <Ionicons name="settings-outline" size={24} color={THEME.text} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* User section */}
        <View style={styles.userSection}>
          <TouchableOpacity
            onPress={() => router.push('/(app)/avatar-picker')}
            activeOpacity={0.85}
          >
            <Avatar
              name={profile?.name || user.email}
              avatarIcon={profile?.avatarIcon}
              avatarUrl={profile?.avatarUrl}
              color={profile?.color}
              size={96}
            />
          </TouchableOpacity>
          <Text style={styles.userName}>{displayName}</Text>
          <Text style={styles.userEmail}>{displayEmail}</Text>

          {!isEditing ? (
            <TouchableOpacity
              style={styles.editBtn}
              onPress={() => setIsEditing(true)}
              activeOpacity={0.85}
            >
              <Text style={styles.editBtnText}>{t('profile_edit_btn')}</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.editForm}>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder={t('profile_name')}
                placeholderTextColor={THEME.muted}
              />
              <TextInput
                style={styles.input}
                value={phone}
                onChangeText={setPhone}
                placeholder={t('profile_phone')}
                placeholderTextColor={THEME.muted}
                keyboardType="phone-pad"
              />
              <View style={styles.editActions}>
                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={() => setIsEditing(false)}
                >
                  <Text style={styles.cancelBtnText}>{t('cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveBtn} onPress={handleSaveProfile}>
                  <Text style={styles.saveBtnText}>{t('save')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* Credits card */}
        <TouchableOpacity
          style={styles.creditsCard}
          onPress={() => router.push('/(app)/pricing')}
          activeOpacity={0.85}
        >
          <Image source={require('@/assets/images/token.png')} style={styles.tokenIcon} />
          <View style={styles.creditsInfo}>
            <Text style={styles.creditsLabel}>{t('profile_bill_credits_label')}</Text>
            <Text style={styles.creditsCount}>{profile?.billCredits ?? 0} {t('profile_credits_available')}</Text>
          </View>
          <View style={styles.getMoreBtn}>
            <Text style={styles.getMoreBtnText}>{t('profile_get_more')}</Text>
          </View>
        </TouchableOpacity>

        {/* Settings list */}
        <View style={styles.card}>
          <SettingsRow
            icon="globe-outline"
            label={t('profile_language')}
            value={langLabel}
            onPress={handleLanguage}
          />
          <Separator />
          <SettingsRow
            icon="wallet-outline"
            label={t('profile_buy_credits')}
            onPress={() => router.push('/(app)/pricing')}
          />
          <Separator />
          <SettingsRow
            icon="play-circle-outline"
            label={t('home_how_it_works')}
            badge={t('profile_app_tour')}
            onPress={() => router.push('/onboarding')}
          />
          <Separator />
          <SettingsRow
            icon="help-circle-outline"
            label={t('profile_help_center')}
            onPress={() =>
              showDialog(t('profile_help_center'), 'support@pickandpay.app')
            }
          />
          <Separator />
          <SettingsRow
            icon="person-add-outline"
            label={t('profile_invite_friends_short')}
            badge={t('profile_earn_free')}
            onPress={shareApp}
          />
          <Separator />
          <SettingsRow
            icon="information-circle-outline"
            label={t('profile_about')}
            onPress={() =>
              showDialog(
                t('profile_about'),
                'Version 1.0.0\nSplit bills fair. Pay only what you consumed.'
              )
            }
          />
          <Separator />
          <SettingsRow
            icon="shield-checkmark-outline"
            label="Privacy Policy"
            onPress={() => Linking.openURL('https://vaultaihq.org/privacy')}
          />
          <Separator />
          <SettingsRow
            icon="document-text-outline"
            label="Terms of Service"
            onPress={() => Linking.openURL('https://vaultaihq.org/terms')}
          />
        </View>

        {/* Logout + Delete Account */}
        <View style={[styles.card, styles.logoutCard]}>
          <TouchableOpacity
            style={styles.logoutRow}
            onPress={handleLogout}
            activeOpacity={0.7}
          >
            <Ionicons name="log-out-outline" size={22} color={THEME.danger} />
            <Text style={styles.logoutText}>{t('profile_logout')}</Text>
          </TouchableOpacity>
          <View style={styles.separator} />
          <TouchableOpacity
            style={styles.logoutRow}
            onPress={handleDeleteAccount}
            activeOpacity={0.7}
            disabled={deletingAccount}
          >
            <Ionicons name="trash-outline" size={22} color={THEME.danger} />
            <Text style={[styles.logoutText, { opacity: deletingAccount ? 0.5 : 1 }]}>
              {deletingAccount ? 'A eliminar...' : 'Eliminar Conta'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>

      <BottomNavBar activeTab="profile" />

      {/* Language picker modal */}
      <Modal
        visible={showLangModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowLangModal(false)}
      >
        <TouchableOpacity
          style={styles.langOverlay}
          activeOpacity={1}
          onPress={() => setShowLangModal(false)}
        />
        <View style={styles.langSheet}>
          <Text style={styles.langTitle}>{t('profile_choose_language')}</Text>
          {(Object.keys(LANGUAGE_META) as Language[]).map((lang) => (
            <TouchableOpacity
              key={lang}
              style={[styles.langOption, language === lang && styles.langOptionActive]}
              onPress={() => { setLanguage(lang); setShowLangModal(false); }}
              activeOpacity={0.7}
            >
              <Text style={styles.langFlag}>{LANGUAGE_META[lang].flag}</Text>
              <Text style={styles.langLabel}>{LANGUAGE_META[lang].label}</Text>
              {language === lang && (
                <Ionicons name="checkmark-circle" size={22} color={THEME.primary} />
              )}
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.langCancel} onPress={() => setShowLangModal(false)}>
            <Text style={styles.langCancelText}>{t('cancel')}</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function SettingsRow({
  icon,
  label,
  value,
  badge,
  onPress,
}: {
  icon: string;
  label: string;
  value?: string;
  badge?: string;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity style={styles.settingsRow} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={icon as any} size={20} color={THEME.muted} />
      <Text style={styles.settingsLabel}>{label}</Text>
      <View style={styles.settingsRight}>
        {badge && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        )}
        {value && <Text style={styles.settingsValue}>{value}</Text>}
        <Ionicons name="chevron-forward" size={16} color={THEME.muted} />
      </View>
    </TouchableOpacity>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: THEME.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  mutedText: { color: THEME.muted, fontSize: 16 },
  dangerText: { color: THEME.danger, fontSize: 18, marginBottom: 20 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: { fontSize: 22, fontWeight: '700', color: THEME.text },

  scroll: { paddingHorizontal: 16, paddingTop: 4, gap: 16 },

  userSection: { alignItems: 'center', paddingVertical: 24, gap: 6 },
  userName: { fontSize: 20, fontWeight: '700', color: THEME.text, marginTop: 10 },
  userEmail: { fontSize: 14, color: THEME.muted },

  editBtn: {
    backgroundColor: THEME.primary,
    paddingVertical: 11,
    paddingHorizontal: 36,
    borderRadius: 10,
    marginTop: 10,
  },
  editBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  editForm: { width: '100%', gap: 10, marginTop: 12 },
  input: {
    backgroundColor: THEME.card,
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 14,
    fontSize: 15,
    color: THEME.text,
  },
  editActions: { flexDirection: 'row', gap: 10 },
  cancelBtn: {
    flex: 1,
    backgroundColor: THEME.card,
    borderWidth: 1,
    borderColor: THEME.border,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  cancelBtnText: { color: THEME.muted, fontSize: 15, fontWeight: '600' },
  saveBtn: {
    flex: 1,
    backgroundColor: THEME.primary,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  card: {
    backgroundColor: THEME.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: THEME.border,
    overflow: 'hidden',
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 15,
    gap: 14,
  },
  settingsLabel: { flex: 1, fontSize: 15, color: THEME.text, fontWeight: '500' },
  settingsRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  settingsValue: { fontSize: 14, color: THEME.muted },
  badge: {
    backgroundColor: 'rgba(91,104,244,0.15)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  badgeText: { fontSize: 11, color: THEME.primary, fontWeight: '600' },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: THEME.border,
    marginLeft: 50,
  },

  logoutCard: {},
  logoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 15,
    gap: 14,
  },
  logoutText: { fontSize: 15, color: THEME.danger, fontWeight: '600' },

  primaryBtn: {
    backgroundColor: THEME.primary,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  // ── Language modal ────────────────────────────────────────────────────────────
  langOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  langSheet: {
    backgroundColor: THEME.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 36,
    gap: 6,
  },
  langTitle: { fontSize: 16, fontWeight: '700', color: THEME.text, marginBottom: 8 },
  langOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  langOptionActive: { backgroundColor: THEME.primary + '22' },
  langFlag: { fontSize: 24 },
  langLabel: { flex: 1, fontSize: 16, color: THEME.text, fontWeight: '500' },
  langCancel: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
  langCancelText: { color: THEME.muted, fontSize: 15, fontWeight: '600' },

  creditsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: THEME.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: THEME.primary,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  tokenIcon: { width: 40, height: 40, resizeMode: 'contain' },
  creditsInfo: { flex: 1 },
  creditsLabel: { fontSize: 13, color: THEME.muted, fontWeight: '600', marginBottom: 2 },
  creditsCount: { fontSize: 20, fontWeight: '800', color: '#F9FAFB' },
  getMoreBtn: {
    backgroundColor: THEME.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  getMoreBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
