import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { NetworkInterfaceItem, QosRule, QosTierDef, StreamingProfile } from '../types/netfusion';

interface StreamingQosViewProps {
  profiles: StreamingProfile[];
  tiers: QosTierDef[];
  rules: QosRule[];
  interfaces: NetworkInterfaceItem[];
  onActivateProfile: (id: string) => void;
  onToggleRule: (id: string, enabled: boolean) => void;
  onCreateRule: (input: {
    app_name: string;
    match_pattern: string;
    tier: QosRule['tier'];
    preferred_interface_id: string | null;
  }) => Promise<void>;
  onDeleteRule: (id: string) => void;
}

export function StreamingQosView({
  profiles,
  tiers,
  rules,
  interfaces,
  onActivateProfile,
  onToggleRule,
  onCreateRule,
  onDeleteRule,
}: StreamingQosViewProps) {
  const [appName, setAppName] = useState('');
  const [pattern, setPattern] = useState('');
  const [tier, setTier] = useState<QosRule['tier']>('P1');
  const [preferredIface, setPreferredIface] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!appName.trim() || !pattern.trim()) return;
    setSubmitting(true);
    try {
      await onCreateRule({
        app_name: appName.trim(),
        match_pattern: pattern.trim(),
        tier,
        preferred_interface_id: preferredIface || null,
      });
      setAppName('');
      setPattern('');
      setPreferredIface('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Streaming Profiles */}
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Streaming & Traffic Profiles
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Select how NetFusion prioritizes real-time calls, gaming, OTT video, and background downloads.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {profiles.map((profile) => {
            const active = Boolean(profile.is_active);
            return (
              <button
                key={profile.id}
                type="button"
                onClick={() => onActivateProfile(profile.id)}
                className={`text-left p-5 rounded-xl border transition-colors ${
                  active
                    ? 'bg-blue-50/70 dark:bg-blue-950/30 border-blue-600 dark:border-blue-500'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {profile.name}
                  </h3>
                  <span
                    className={`text-xs font-semibold ${
                      active ? 'text-blue-700 dark:text-blue-400' : 'text-slate-400 dark:text-slate-500'
                    }`}
                  >
                    {active ? 'Active' : 'Select'}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                  {profile.description}
                </p>
                <div className="mt-3 pt-3 border-t border-slate-200/70 dark:border-slate-800 flex flex-wrap gap-4 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  <span>P0 {profile.realtime_priority}</span>
                  <span>P1 {profile.gaming_priority}</span>
                  <span>P2 {profile.video_priority}</span>
                  <span>P3 {profile.normal_priority}</span>
                  <span>P4 {profile.background_priority}</span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* P0-P4 Priority Reference */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-3">
          Five-Tier Scheduling Weights
        </h2>
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {tiers.map((t) => (
            <div key={t.tier} className="py-2.5 flex items-center justify-between gap-4 text-sm">
              <div className="flex items-baseline gap-3">
                <span className="font-mono font-semibold text-slate-900 dark:text-slate-100 w-8">
                  {t.tier}
                </span>
                <span className="font-medium text-slate-900 dark:text-slate-100">{t.label}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400 hidden sm:inline">
                  {t.description}
                </span>
              </div>
              <span className="font-mono tabular-nums text-xs font-semibold text-slate-700 dark:text-slate-300">
                {t.weight}/100
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Manual Application Rules */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Application QoS Rules
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Assign explicit priority tiers and preferred uplinks for encrypted streams or specific applications.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <input
            type="text"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            placeholder="Application name (e.g., OBS Studio)"
            required
            className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
          />
          <input
            type="text"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="Match (e.g., rtmp:1935,obs)"
            required
            className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
          />
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value as QosRule['tier'])}
            className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
          >
            <option value="P0">P0 · Real-time (100)</option>
            <option value="P1">P1 · Gaming (90)</option>
            <option value="P2">P2 · Video (70)</option>
            <option value="P3">P3 · Normal (50)</option>
            <option value="P4">P4 · Background (30)</option>
          </select>
          <select
            value={preferredIface}
            onChange={(e) => setPreferredIface(e.target.value)}
            className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
          >
            <option value="">Auto (Weighted Health)</option>
            {interfaces.map((i) => (
              <option key={i.id} value={i.id}>
                {i.display_name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>Add Rule</span>
          </button>
        </form>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-2.5 pr-4">Application</th>
                <th className="py-2.5 px-4">Match Pattern</th>
                <th className="py-2.5 px-4">Tier / Weight</th>
                <th className="py-2.5 px-4">Preferred Uplink</th>
                <th className="py-2.5 pl-4 text-right">Controls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
              {rules.map((rule) => {
                const ifaceName =
                  interfaces.find((i) => i.id === rule.preferred_interface_id)?.display_name ??
                  'Auto Scheduler';
                return (
                  <tr key={rule.id}>
                    <td className="py-3 pr-4 font-medium text-slate-900 dark:text-slate-100">
                      {rule.app_name}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-600 dark:text-slate-300">
                      {rule.match_pattern}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100">
                      {rule.tier} · {rule.priority_weight}/100
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-600 dark:text-slate-300">
                      {ifaceName}
                    </td>
                    <td className="py-3 pl-4 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onToggleRule(rule.id, !rule.enabled)}
                          className="px-2.5 py-1 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                        >
                          {rule.enabled ? 'Enabled' : 'Paused'}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteRule(rule.id)}
                          aria-label={`Delete rule ${rule.app_name}`}
                          className="p-1.5 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
