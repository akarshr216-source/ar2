import type { BondingPathItem, BondingStatusResponse } from '../types/netfusion';

interface BondingViewProps {
  status: BondingStatusResponse | null;
  paths: BondingPathItem[];
}

export function BondingView({ status, paths }: BondingViewProps) {
  const capRows = [
    {
      feature: 'Network monitoring',
      withoutRelay: 'Supported',
      withRelay: 'Supported',
      active: true,
    },
    {
      feature: 'Per-session load balancing & failover',
      withoutRelay: 'Supported',
      withRelay: 'Supported',
      active: true,
    },
    {
      feature: 'Streaming & QoS prioritization',
      withoutRelay: 'Supported',
      withRelay: 'Supported',
      active: true,
    },
    {
      feature: 'Single-flow bandwidth aggregation',
      withoutRelay: 'Not available locally',
      withRelay: 'Requires remote QUIC relay',
      active: false,
    },
    {
      feature: 'Combined public internet exit IP',
      withoutRelay: 'Not available locally',
      withRelay: 'Requires remote QUIC relay',
      active: false,
    },
  ];

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Multipath Bonding Engine
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Optional remote relay subsystem — disabled in NetFusion v0.1
            </p>
          </div>
          <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
            Disabled (No Remote Relay Configured)
          </span>
        </div>

        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {status?.explanation ??
            'True single-flow bandwidth bonding requires an external QUIC relay endpoint on the internet side of your links. Without a relay, NetFusion performs accurate local monitoring, automatic failover, and per-session load balancing without displaying misleading combined speeds.'}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs">
          <div>
            <div className="text-slate-500 dark:text-slate-400">Transport Baseline</div>
            <div className="mt-1 font-mono font-semibold text-slate-900 dark:text-slate-100">
              quic-go 0.60.0 + TLS 1.3
            </div>
          </div>
          <div>
            <div className="text-slate-500 dark:text-slate-400">Active QUIC Tunnels</div>
            <div className="mt-1 font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
              {status?.active_tunnels ?? 0}
            </div>
          </div>
          <div>
            <div className="text-slate-500 dark:text-slate-400">Candidate Healthy Paths</div>
            <div className="mt-1 font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
              {status?.candidate_paths ?? 0}
            </div>
          </div>
        </div>
      </section>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Capability Matrix: Local Mode vs. Optional Relay
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-3 px-4">Capability</th>
                <th className="py-3 px-4">Without Relay (Current v0.1)</th>
                <th className="py-3 px-4">With Optional Relay (v0.7+)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {capRows.map((row) => (
                <tr key={row.feature}>
                  <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">
                    {row.feature}
                  </td>
                  <td
                    className={`py-3 px-4 text-xs font-medium ${
                      row.active
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {row.withoutRelay}
                  </td>
                  <td className="py-3 px-4 text-xs text-slate-600 dark:text-slate-300">
                    {row.withRelay}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Independent Interface Path Readiness
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-3 px-4">Path</th>
                <th className="py-3 px-4">Tunnel State</th>
                <th className="py-3 px-4 text-right">Latency</th>
                <th className="py-3 px-4 text-right">Jitter</th>
                <th className="py-3 px-4 text-right">Loss</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {paths.map((p) => (
                <tr key={p.interface_id}>
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-900 dark:text-slate-100">{p.display_name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{p.provider}</div>
                  </td>
                  <td className="py-3 px-4 text-xs font-medium">
                    <span
                      className={
                        p.ready_for_quic
                          ? 'text-slate-700 dark:text-slate-300'
                          : 'text-red-600 dark:text-red-400'
                      }
                    >
                      {p.ready_for_quic ? 'Standby (Ready when relay enabled)' : 'Unavailable'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100">
                    {p.latency_ms.toFixed(1)} ms
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100">
                    {p.jitter_ms.toFixed(1)} ms
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100">
                    {p.packet_loss_pct.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
