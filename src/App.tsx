import { useState } from 'react';
import { DashboardView } from './components/DashboardView';
import { DevicesView } from './components/DevicesView';
import { NetworksView } from './components/NetworksView';
import { QrAddDeviceModal } from './components/QrAddDeviceModal';
import { SettingsView } from './components/SettingsView';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { useNetFusion } from './hooks/useNetFusion';
import type { NavSection } from './types/netfusion';

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSection>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);

  const {
    apiBaseUrl,
    setApiBaseUrl,
    lanAddresses,
    publicUrl,
    backendMode,
    snapshot,
    clients,
    clientsLoading,
    clientsError,
    pairingStatus,
    adminAuthStatus,
    isAdminAuthenticated,
    claimAdminPasscode,
    loginAdmin,
    logoutAdmin,
    refreshClients,
    generatePairingCode,
    revokeClient,
    sseConnected,
    loading,
    error,
    checkingNetwork,
    checkNetworkNow,
    updateSettings,
  } = useNetFusion();

  const currentTheme = snapshot?.settings.theme ?? 'system';

  const handleToggleTheme = () => {
    const isCurrentlyDark =
      currentTheme === 'dark' ||
      (currentTheme === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    void updateSettings({ theme: isCurrentlyDark ? 'light' : 'dark' });
  };

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <Sidebar
        activeSection={activeSection}
        onSelect={setActiveSection}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
        connectedDevicesCount={snapshot?.devices_summary.connected ?? 0}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          activeSection={activeSection}
          sseConnected={sseConnected}
          theme={currentTheme}
          onToggleTheme={handleToggleTheme}
          onAddDevice={() => setAddDeviceOpen(true)}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />

        <main className="flex-1 p-4 sm:p-6 max-w-6xl w-full mx-auto">
          {loading && !snapshot ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                {[0, 1, 2, 3].map((k) => (
                  <div
                    key={k}
                    className="h-28 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 animate-pulse"
                  />
                ))}
              </div>
              <div className="h-48 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 animate-pulse" />
            </div>
          ) : error && !snapshot ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 max-w-lg space-y-2">
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                NetFusion Server Unreachable
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400">{error}</p>
            </div>
          ) : snapshot ? (
            <>
              {activeSection === 'dashboard' && (
                <DashboardView
                  snapshot={snapshot}
                  lanAddresses={lanAddresses}
                  publicUrl={publicUrl}
                  backendMode={backendMode}
                  clients={clients}
                  isAdminAuthenticated={isAdminAuthenticated}
                  checkingNetwork={checkingNetwork}
                  onAddDevice={() => setAddDeviceOpen(true)}
                  onOpenDevices={() => setActiveSection('devices')}
                  onOpenSettings={() => setActiveSection('settings')}
                  onCheckNetwork={() => void checkNetworkNow()}
                />
              )}

              {activeSection === 'devices' && (
                <DevicesView
                  clients={clients}
                  clientsLoading={clientsLoading}
                  clientsError={clientsError}
                  pairingStatus={pairingStatus}
                  adminAuthStatus={adminAuthStatus}
                  isAdminAuthenticated={isAdminAuthenticated}
                  onClaimAdmin={claimAdminPasscode}
                  onLoginAdmin={loginAdmin}
                  onLogoutAdmin={logoutAdmin}
                  onRefreshClients={refreshClients}
                  onOpenAddDevice={() => setAddDeviceOpen(true)}
                  onRevokeClient={revokeClient}
                />
              )}

              {activeSection === 'networks' && (
                <NetworksView
                  interfaces={snapshot.interfaces}
                  internetStatus={snapshot.internet_status}
                  internetLatencyMs={snapshot.internet_latency_ms}
                  checkingNetwork={checkingNetwork}
                  onCheckNetwork={() => void checkNetworkNow()}
                />
              )}

              {activeSection === 'settings' && (
                <SettingsView
                  settings={snapshot.settings}
                  events={snapshot.events}
                  apiBaseUrl={apiBaseUrl}
                  publicUrl={publicUrl}
                  backendMode={backendMode}
                  onChangeApiBaseUrl={setApiBaseUrl}
                  onUpdateSettings={(patch) => void updateSettings(patch)}
                />
              )}
            </>
          ) : null}
        </main>
      </div>

      <QrAddDeviceModal
        open={addDeviceOpen}
        onClose={() => setAddDeviceOpen(false)}
        apiBaseUrl={apiBaseUrl}
        publicUrl={publicUrl}
        serverPort={snapshot?.settings.server_port ?? 8080}
        lanAddresses={lanAddresses}
        adminAuthStatus={adminAuthStatus}
        isAdminAuthenticated={isAdminAuthenticated}
        pairingStatus={pairingStatus}
        onClaimAdmin={claimAdminPasscode}
        onLoginAdmin={loginAdmin}
        onGeneratePairingCode={generatePairingCode}
      />
    </div>
  );
}
