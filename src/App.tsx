import { useState } from 'react';
import { BondingView } from './components/BondingView';
import { ClientsView } from './components/ClientsView';
import { InterfacesView } from './components/InterfacesView';
import { OverviewView } from './components/OverviewView';
import { RepositoryView } from './components/RepositoryView';
import { SettingsView } from './components/SettingsView';
import { Sidebar } from './components/Sidebar';
import { StreamingQosView } from './components/StreamingQosView';
import { TopBar } from './components/TopBar';
import { useNetFusion } from './hooks/useNetFusion';
import type { NavSection } from './types/netfusion';

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSection>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const {
    apiBaseUrl,
    setApiBaseUrl,
    lanAddresses,
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
    profiles,
    qosRules,
    qosTiers,
    bondingStatus,
    bondingPaths,
    sseConnected,
    loading,
    error,
    probingId,
    updateInterface,
    probeInterface,
    updateSettings,
    setGatewayMode,
    activateStreamingProfile,
    toggleQosRule,
    createQosRule,
    deleteQosRule,
  } = useNetFusion();

  const currentTheme = snapshot?.settings.theme ?? 'system';

  const handleToggleTheme = () => {
    const isCurrentlyDark =
      currentTheme === 'dark' ||
      (currentTheme === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    void updateSettings({ theme: isCurrentlyDark ? 'light' : 'dark' });
  };

  const handleGlobalProbe = () => {
    const target = snapshot?.interfaces.find((i) => i.enabled) ?? snapshot?.interfaces[0];
    if (target) {
      void probeInterface(target.id);
    }
  };

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <Sidebar
        activeSection={activeSection}
        onSelect={setActiveSection}
        gatewayMode={snapshot?.settings.gateway_mode ?? false}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          activeSection={activeSection}
          sseConnected={sseConnected}
          intervalSeconds={snapshot?.settings.monitor_interval_seconds ?? 3}
          theme={currentTheme}
          probing={probingId !== null}
          onToggleTheme={handleToggleTheme}
          onRunProbe={handleGlobalProbe}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />

        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">
          {loading && !snapshot ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                {[0, 1, 2, 3].map((k) => (
                  <div
                    key={k}
                    className="h-24 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 animate-pulse"
                  />
                ))}
              </div>
              <div className="h-64 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 animate-pulse" />
            </div>
          ) : error && !snapshot ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 max-w-lg">
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                NetFusion Server Unreachable
              </h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{error}</p>
            </div>
          ) : snapshot ? (
            <>
              {activeSection === 'overview' && (
                <OverviewView
                  snapshot={snapshot}
                  clients={clients}
                  isAdminAuthenticated={isAdminAuthenticated}
                  probingId={probingId}
                  onProbeInterface={(id) => void probeInterface(id)}
                  onToggleInterface={(id, enabled) => void updateInterface(id, { enabled })}
                  onToggleSimulateDown={(id, simulated_down) =>
                    void updateInterface(id, { simulated_down })
                  }
                  onSetGatewayMode={(enabled) => void setGatewayMode(enabled)}
                  onNavigateClients={() => setActiveSection('clients')}
                />
              )}

              {activeSection === 'interfaces' && (
                <InterfacesView
                  interfaces={snapshot.interfaces}
                  usage={snapshot.usage}
                  probingId={probingId}
                  onUpdateWeight={(id, weight) => void updateInterface(id, { weight })}
                  onToggleEnabled={(id, enabled) => void updateInterface(id, { enabled })}
                  onToggleSimDown={(id, simulated_down) =>
                    void updateInterface(id, { simulated_down })
                  }
                  onProbe={(id) => void probeInterface(id)}
                />
              )}

              {activeSection === 'streaming' && (
                <StreamingQosView
                  profiles={profiles}
                  tiers={qosTiers}
                  rules={qosRules}
                  interfaces={snapshot.interfaces}
                  onActivateProfile={(id) => void activateStreamingProfile(id)}
                  onToggleRule={(id, enabled) => void toggleQosRule(id, enabled)}
                  onCreateRule={createQosRule}
                  onDeleteRule={(id) => void deleteQosRule(id)}
                />
              )}

              {activeSection === 'clients' && (
                <ClientsView
                  clients={clients}
                  clientsLoading={clientsLoading}
                  clientsError={clientsError}
                  pairingStatus={pairingStatus}
                  adminAuthStatus={adminAuthStatus}
                  isAdminAuthenticated={isAdminAuthenticated}
                  serverPort={snapshot.settings.server_port}
                  lanAddresses={lanAddresses}
                  onClaimAdmin={claimAdminPasscode}
                  onLoginAdmin={loginAdmin}
                  onLogoutAdmin={logoutAdmin}
                  onRefreshClients={refreshClients}
                  onGeneratePairingCode={generatePairingCode}
                  onRevokeClient={revokeClient}
                />
              )}

              {activeSection === 'bonding' && (
                <BondingView status={bondingStatus} paths={bondingPaths} />
              )}

              {activeSection === 'repository' && <RepositoryView apiBaseUrl={apiBaseUrl} />}

              {activeSection === 'settings' && (
                <SettingsView
                  settings={snapshot.settings}
                  events={snapshot.events}
                  apiBaseUrl={apiBaseUrl}
                  onChangeApiBaseUrl={setApiBaseUrl}
                  onUpdateSettings={(patch) => void updateSettings(patch)}
                  onSetGatewayMode={(enabled) => void setGatewayMode(enabled)}
                />
              )}
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
