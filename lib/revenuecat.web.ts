// Web stub — react-native-purchases is not available in browsers.
// Metro automatically picks this file over revenuecat.ts on web builds.
// All exported functions are no-ops that return safe empty values so the
// rest of the app (pricing screen, auth flow) compiles and runs without change.

export async function initRevenueCat(_userId: string): Promise<void> {
  // no-op on web
}

export async function getOfferings(): Promise<null> {
  return null;
}

export async function purchasePackage(
  _pkg: unknown
): Promise<{ success: false; cancelled: true }> {
  return { success: false, cancelled: true };
}

export async function restorePurchases(): Promise<{ success: false }> {
  return { success: false };
}

export async function getCustomerInfo(): Promise<null> {
  return null;
}
