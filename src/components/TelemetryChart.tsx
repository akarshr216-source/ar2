import { useMemo, useState } from 'react';
import type { NetworkInterfaceItem, NetworkMetric } from '../types/netfusion';

interface TelemetryChartProps {
  interfaces: NetworkInterfaceItem[];
  history: NetworkMetric[];
}

const SERIES_COLORS = ['#2563EB', '#16A34A', '#D97706', '#0EA5E9', '#8B5CF6'];

export function TelemetryChart({ interfaces, history }: TelemetryChartProps) {
  const [metricMode, setMetricMode] = useState<'download_mbps' | 'upload_mbps' | 'latency_ms'>('download_mbps');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const chartedInterfaces = useMemo(
    () => interfaces.filter((i) => i.enabled).slice(0, 4),
    [interfaces],
  );

  const seriesData = useMemo(() => {
    return chartedInterfaces.map((iface, idx) => {
      const points = history
        .filter((h) => h.interface_id === iface.id)
        .slice(-24);
      return {
        iface,
        color: SERIES_COLORS[idx % SERIES_COLORS.length],
        points,
      };
    });
  }, [chartedInterfaces, history]);

  const maxPoints = useMemo(
    () => Math.max(2, ...seriesData.map((s) => s.points.length)),
    [seriesData],
  );

  const maxValue = useMemo(() => {
    let peak = metricMode === 'latency_ms' ? 40 : 25;
    for (const s of seriesData) {
      for (const p of s.points) {
        const val = p[metricMode];
        if (val > peak) peak = val;
      }
    }
    return Math.ceil(peak * 1.15);
  }, [seriesData, metricMode]);

  const width = 760;
  const height = 220;
  const padLeft = 48;
  const padRight = 16;
  const padTop = 14;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    y: padTop + plotH * (1 - ratio),
    label: Math.round(maxValue * ratio),
  }));

  const unit = metricMode === 'latency_ms' ? 'ms' : 'Mbps';

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Live Interface Telemetry
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Individual uplink measurements over the last {maxPoints} monitoring intervals
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg self-start">
          {(
            [
              { id: 'download_mbps', label: 'Download' },
              { id: 'upload_mbps', label: 'Upload' },
              { id: 'latency_ms', label: 'Latency' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setMetricMode(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                metricMode === tab.id
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-56 select-none"
          role="img"
          aria-label={`Live ${metricMode} telemetry chart`}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {yTicks.map((tick) => (
            <g key={tick.label}>
              <line
                x1={padLeft}
                x2={width - padRight}
                y1={tick.y}
                y2={tick.y}
                className="stroke-slate-200 dark:stroke-slate-800"
                strokeWidth="1"
              />
              <text
                x={padLeft - 8}
                y={tick.y + 4}
                textAnchor="end"
                className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono tabular-nums"
              >
                {tick.label}
              </text>
            </g>
          ))}

          {seriesData.map((series) => {
            if (series.points.length < 2) return null;
            const pathD = series.points
              .map((pt, i) => {
                const x = padLeft + (i / Math.max(1, series.points.length - 1)) * plotW;
                const y = padTop + plotH - (pt[metricMode] / maxValue) * plotH;
                return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
              })
              .join(' ');

            return (
              <g key={series.iface.id}>
                <path
                  d={pathD}
                  fill="none"
                  stroke={series.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {hoverIdx !== null && series.points[hoverIdx] && (
                  <circle
                    cx={padLeft + (hoverIdx / Math.max(1, series.points.length - 1)) * plotW}
                    cy={padTop + plotH - (series.points[hoverIdx][metricMode] / maxValue) * plotH}
                    r="3.5"
                    fill={series.color}
                  />
                )}
              </g>
            );
          })}

          {Array.from({ length: maxPoints }).map((_, idx) => {
            const x = padLeft + (idx / Math.max(1, maxPoints - 1)) * plotW;
            const colWidth = plotW / Math.max(1, maxPoints - 1);
            return (
              <rect
                key={idx}
                x={x - colWidth / 2}
                y={padTop}
                width={colWidth}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(idx)}
              />
            );
          })}
        </svg>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 pt-3 mt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
        <div className="flex flex-wrap items-center gap-5">
          {seriesData.map((series) => {
            const point =
              hoverIdx !== null && series.points[hoverIdx]
                ? series.points[hoverIdx]
                : series.points[series.points.length - 1];
            const val = point ? point[metricMode] : 0;
            return (
              <div key={series.iface.id} className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-0.5 rounded-full"
                  style={{ backgroundColor: series.color }}
                  aria-hidden="true"
                />
                <span className="text-slate-600 dark:text-slate-300 font-medium">
                  {series.iface.display_name}
                </span>
                <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100 font-semibold">
                  {val.toFixed(1)} {unit}
                </span>
              </div>
            );
          })}
        </div>
        <div className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
          Scale: 0–{maxValue} {unit}
        </div>
      </div>
    </section>
  );
}
