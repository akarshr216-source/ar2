import {
  Activity,
  FolderCode,
  GitFork,
  Layers,
  Network,
  Settings,
  Smartphone,
  X,
} from 'lucide-react';
import type { NavSection } from '../types/netfusion';

interface SidebarProps {
  activeSection: NavSection;
  onSelect: (section: NavSection) => void;
  gatewayMode: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: Array<{ id: NavSection; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'interfaces', label: 'Interfaces', icon: Network },
  { id: 'streaming', label: 'Streaming & QoS', icon: Layers },
  { id: 'clients', label: 'Clients & Pairing', icon: Smartphone },
  { id: 'bonding', label: 'Bonding Engine', icon: GitFork },
  { id: 'repository', label: 'Go v0.1 Source', icon: FolderCode },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({
  activeSection,
  onSelect,
  gatewayMode,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const navContent = (
    <div className="flex h-full flex-col justify-between bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800">
      <div>
        <div className="flex h-14 items-center justify-between px-5 border-b border-slate-200 dark:border-slate-800">
          <span className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
            NetFusion
          </span>
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close navigation"
            className="lg:hidden p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav aria-label="Primary navigation" className="p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelect(item.id);
                  onCloseMobile();
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                  isActive
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800/70'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-1.5">
        <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Routing State
        </div>
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {gatewayMode ? 'Gateway Mode Active' : 'Monitoring Mode'}
        </div>
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {gatewayMode
            ? 'Forwarding paired LAN client traffic across healthy uplinks.'
            : 'Observing host NICs and upstream links without altering OS routes.'}
        </p>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block w-60 shrink-0 h-screen sticky top-0">
        {navContent}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/50"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative z-50 w-64 max-w-[80vw] h-full">
            {navContent}
          </aside>
        </div>
      )}
    </>
  );
}
