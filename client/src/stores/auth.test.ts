import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from './auth';

const {
  changePasswordProtectionMock,
  disablePasswordProtectionMock,
  enablePasswordProtectionMock,
  fetchAuthStatusMock,
  loginWithPasswordMock,
  logoutMock,
  unlockAdminSessionMock,
  updateViewerAccessMock
} = vi.hoisted(() => ({
  changePasswordProtectionMock: vi.fn(),
  disablePasswordProtectionMock: vi.fn(),
  enablePasswordProtectionMock: vi.fn(),
  fetchAuthStatusMock: vi.fn(),
  loginWithPasswordMock: vi.fn(),
  logoutMock: vi.fn(),
  unlockAdminSessionMock: vi.fn(),
  updateViewerAccessMock: vi.fn()
}));

vi.mock('../api/gallery', () => ({
  changePasswordProtection: changePasswordProtectionMock,
  disablePasswordProtection: disablePasswordProtectionMock,
  enablePasswordProtection: enablePasswordProtectionMock,
  fetchAuthStatus: fetchAuthStatusMock,
  loginWithPassword: loginWithPasswordMock,
  logout: logoutMock,
  unlockAdmin: unlockAdminSessionMock,
  updateViewerAccess: updateViewerAccessMock
}));

describe('auth store locale status', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    changePasswordProtectionMock.mockReset();
    disablePasswordProtectionMock.mockReset();
    enablePasswordProtectionMock.mockReset();
    fetchAuthStatusMock.mockReset();
    loginWithPasswordMock.mockReset();
    logoutMock.mockReset();
    unlockAdminSessionMock.mockReset();
    updateViewerAccessMock.mockReset();
  });

  it('stores the saved app default locale from public auth status', async () => {
    fetchAuthStatusMock.mockResolvedValue({
      enabled: true,
      authenticated: false,
      role: 'anonymous',
      accessMode: 'password',
      likesMode: 'local',
      defaultLocale: 'zh',
      capabilities: {
        canManageLibrary: false,
        canDeleteMedia: false,
        canAccessSettings: false,
        canUseSharedLikes: false,
        canUseLocalFavorites: true,
        canUseSharedCollections: false,
        canUseLocalCollections: true
      }
    });

    const authStore = useAuthStore();
    await authStore.initialize();

    expect(authStore.defaultLocale).toBe('zh');
    expect(authStore.requiresLogin).toBe(true);
  });

  it('preserves the saved app default locale when a session becomes unauthorized', () => {
    const authStore = useAuthStore();
    authStore.$patch({
      enabled: true,
      authenticated: true,
      role: 'viewer',
      accessMode: 'password',
      likesMode: 'shared',
      defaultLocale: 'zh',
      capabilities: {
        canManageLibrary: false,
        canDeleteMedia: false,
        canAccessSettings: false,
        canUseSharedLikes: true,
        canUseLocalFavorites: false,
        canUseSharedCollections: true,
        canUseLocalCollections: false
      }
    });

    authStore.handleUnauthorized();

    expect(authStore.authenticated).toBe(false);
    expect(authStore.defaultLocale).toBe('zh');
    expect(authStore.requiresLogin).toBe(true);
  });

  it('does not allow sign out when password protection is disabled', () => {
    const authStore = useAuthStore();
    authStore.$patch({
      enabled: false,
      authenticated: true,
      role: 'admin',
      accessMode: 'off',
      likesMode: 'shared',
      defaultLocale: null,
      capabilities: {
        canManageLibrary: true,
        canDeleteMedia: true,
        canAccessSettings: true,
        canUseSharedLikes: true,
        canUseLocalFavorites: false,
        canUseSharedCollections: true,
        canUseLocalCollections: false
      }
    });

    expect(authStore.canSignOut).toBe(false);
  });

  it('allows sign out for authenticated admin and viewer sessions', () => {
    const authStore = useAuthStore();

    authStore.$patch({
      enabled: true,
      authenticated: true,
      role: 'admin',
      accessMode: 'off',
      likesMode: 'shared',
      defaultLocale: null,
      capabilities: {
        canManageLibrary: true,
        canDeleteMedia: true,
        canAccessSettings: true,
        canUseSharedLikes: true,
        canUseLocalFavorites: false,
        canUseSharedCollections: true,
        canUseLocalCollections: false
      }
    });

    expect(authStore.canSignOut).toBe(true);

    authStore.$patch({
      role: 'viewer',
      accessMode: 'password',
      capabilities: {
        canManageLibrary: false,
        canDeleteMedia: false,
        canAccessSettings: false,
        canUseSharedLikes: true,
        canUseLocalFavorites: false,
        canUseSharedCollections: true,
        canUseLocalCollections: false
      }
    });

    expect(authStore.canSignOut).toBe(true);
  });

  it('only allows sign out in public mode after an authenticated admin unlock', () => {
    const authStore = useAuthStore();

    authStore.$patch({
      enabled: true,
      authenticated: false,
      role: 'anonymous',
      accessMode: 'public',
      likesMode: 'local',
      defaultLocale: null,
      capabilities: {
        canManageLibrary: false,
        canDeleteMedia: false,
        canAccessSettings: false,
        canUseSharedLikes: false,
        canUseLocalFavorites: true,
        canUseSharedCollections: false,
        canUseLocalCollections: true
      }
    });

    expect(authStore.canSignOut).toBe(false);

    authStore.$patch({
      authenticated: true,
      role: 'admin',
      likesMode: 'shared',
      capabilities: {
        canManageLibrary: true,
        canDeleteMedia: true,
        canAccessSettings: true,
        canUseSharedLikes: true,
        canUseLocalFavorites: false,
        canUseSharedCollections: true,
        canUseLocalCollections: false
      }
    });

    expect(authStore.canSignOut).toBe(true);
  });
});
