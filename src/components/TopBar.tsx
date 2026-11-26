import { Menu, Moon, QrCode, Sun } from 'lucide-react';
import type { NavSection, NetFusionSettings } from '../types/netfusion';

interface TopBarProps {
  activeSection: NavSection;
  sseConnected: boolean;
  theme: NetFusionSettings['theme'];
  onToggleTheme: () => void;
  onAddDevice: () => void;
  onOpenMobileNav: () => void;
}

const SECTION_LABELS: Record<NavSection, string> = {
  dashboard: 'Dashboard',
  devices: 'Devices',
  networks: 'Networks',
  settings: 'Settings',
};

export function TopBar({
  activeSection,
  sseConnected,
  theme,
  onToggleTheme,
  onAddDevice,
  onOpenMobileNav,
}: TopBarProps) {
  const isDark =
    theme === 'dark' ||
    (theme === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <header className="h-14 sticky top-0 z-20 flex items-center justify-between gap-6 px-4 sm:px-6 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm border-b border-slate-200 dark:border-slate-800">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation"
          className="lg:hidden p-2 -ml-2 rounded-lg text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2 text-sm min-w-0 truncate">
          <span className="text-slate-500 dark:text-slate-400 whitespace-nowrap">NetFusion</span>
          <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">/</span>
          <h1 className="font-semibold text-slate-900 dark:text-slate-100 truncate">
            {SECTION_LABELS[activeSection]}
          </h1>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <span className="hidden sm:inline text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
          {sseConnected ? 'Live updates on' : 'Reconnecting'}
        </span>

        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
        >
          {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          <span>{isDark ? 'Light' : 'Dark'}</span>
        </button>

        <button
          type="button"
          onClick={onAddDevice}
          className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap shrink-0"
        >
          <QrCode className="w-3.5 h-3.5" />
          <span>Add Device</span>
        </button>
      </div>
    </header>
  );
}
