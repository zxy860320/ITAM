/* EdgeRouter —— 正交连线路由配置（G6 polyline + orth router + process-parallel-edges）
 * 依据 G6 5.1.1 实测 API：edge type 'polyline'，style.router = { type:'orth', padding }；
 * 平行链路错开由 transforms: [{ type:'process-parallel-edges', mode:'bundle'|'distance' }] 完成。 */

export const EDGE_STYLE = {
  type: 'polyline',
  router: { type: 'orth', padding: 24 },
  style: {
    lineWidth: 1.4,
    stroke: '#5A5B60',
    endArrow: false,
  },
};

/** 链路证据状态 → 视觉（与旧版 topo-canvas 色板一致：confirmed 绿 / half 黄 / conflict 红） */
export function edgeVisual(status: string, source?: string) {
  switch (status) {
    case 'confirmed': return { stroke: '#4CAF50', lineWidth: 1.6 };
    case 'manual': return { stroke: '#4CAF50', lineWidth: 1.6, lineDash: [6, 4] };
    case 'half': return { stroke: '#F2C94C', lineWidth: 1.6, lineDash: [4, 4] };
    case 'conflict': return { stroke: '#FF5252', lineWidth: 1.8 };
    case 'stale': return { stroke: '#6B7280', lineWidth: 1.2, lineDash: [2, 4] };
    default: return { stroke: '#5A5B60', lineWidth: 1.4 };
  }
}

/** G6 graph spec 的 transforms：同一对节点间的平行链路自动 bundle 错开 */
export const PARALLEL_EDGE_TRANSFORM = {
  type: 'process-parallel-edges',
  mode: 'bundle',
  distance: 12,
};
