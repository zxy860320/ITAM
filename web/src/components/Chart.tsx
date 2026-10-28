import React from 'react';
import * as echarts from 'echarts';

export function Chart({ option, height = 240, onEvents }: { option: any; height?: number | string; onEvents?: Record<string, (p: any) => void> }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const inst = React.useRef<echarts.ECharts | null>(null);
  const evRef = React.useRef(onEvents);
  evRef.current = onEvents;
  React.useEffect(() => {
    if (!ref.current) return;
    inst.current = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    for (const name of ['click', 'dblclick', 'mouseover', 'mouseout']) {
      inst.current.on(name, p => evRef.current?.[name]?.(p));
    }
    const ro = new ResizeObserver(() => inst.current?.resize());
    ro.observe(ref.current);
    return () => { ro.disconnect(); inst.current?.dispose(); };
  }, []);
  React.useEffect(() => { inst.current?.setOption(option, true); }, [option]);
  return <div ref={ref} style={{ width: '100%', height }} />;
}

/** 深色 ECharts 基础配置（设计稿 dark-monitoring-ops 基调） */
export const darkBase = {
  backgroundColor: 'transparent',
  textStyle: { fontFamily: 'JetBrains Mono, Noto Sans SC, sans-serif', color: '#A1A1AA' },
  grid: { left: 42, right: 16, top: 28, bottom: 24 },
  tooltip: {
    backgroundColor: '#1F1F23', borderColor: '#27272A',
    textStyle: { color: '#FAFAFA', fontSize: 12 },
  },
};

export const axisStyle = {
  axisLine: { lineStyle: { color: '#27272A' } },
  axisLabel: { color: '#71717A', fontSize: 10 },
  splitLine: { lineStyle: { color: '#1F1F23' } },
};
