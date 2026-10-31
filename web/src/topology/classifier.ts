/* LayerClassifier + GroupManager —— 网络层级判定与区域分组（纯函数，独立于 G6）
 *
 * 沿用现网钉层规则（用户多次核定的红线）：
 * - 互联网接入区设备（10.25.1.11/12）无论纳管前后必须最上层；
 * - `*-FW<型号>*`（FW6585F/FW6625F…）都是防火墙；EXT/INET/DMZ/OPM/AF 是防火墙所属安全区，不是设备类型；
 * - 层级是显示层推断：语义命名 → 具名层带；无具名语义的设备按真实 LLDP 链路跳数挂靠，
 *   与核心无链路连接的设备不推断位置（进"未关联"区），绝不伪造层级关系。
 * 区域 group_key 稳定标识：internet|firewall|core|dc|office|prod|wireless|other；
 * DB 中人工调整过的 group_key 优先（override），未调整按命名语义推断。 */

export interface ClsNode {
  node_id: number; display_name?: string | null; node_type?: string | null;
  mgmt_ip?: string | null; status?: string;
}
export interface ClsLink { a: number | null; b: number | null; }

export type Band = 'internet' | 'fw' | 'core' | 'agg' | 'access' | 'linked' | 'unlinked';
export const BAND_ORDER: Band[] = ['internet', 'fw', 'core', 'agg', 'access', 'linked', 'unlinked'];
export const BAND_LABEL: Record<Band, string> = {
  internet: '互联网接入区', fw: '防火墙层', core: '核心交换层', agg: '汇聚交换层',
  access: '接入交换层', linked: '其余已互联设备（跳数推断）', unlinked: '未关联设备（无真实链路，不连线）',
};

export type GroupKey = 'internet' | 'firewall' | 'core' | 'dc' | 'office' | 'prod' | 'wireless' | 'other';
export const GROUP_ORDER: GroupKey[] = ['internet', 'firewall', 'core', 'dc', 'office', 'prod', 'wireless', 'other'];
export const GROUP_LABEL: Record<GroupKey, string> = {
  internet: '互联网接入区', firewall: '防火墙区', core: '核心交换区', dc: '数据中心网络区',
  office: '办公网区', prod: '生产网络区', wireless: '无线网络区', other: '其他网络区',
};

/* ---- 命名语义（与 TopoTree 保持一致的判定 + 现网拼音特征补全） ---- */
const RE_FW = /FW\d|FW-|-FW|防火墙|firewall/i;
const RE_INET_MGMT = (n: string) => !RE_FW.test(n) && /互联网|接入区|internet/i.test(n);
const RE_CORE = (n: string) => !RE_FW.test(n) && /核心|core/i.test(n);
const RE_AGG = (n: string) => !RE_FW.test(n) && /汇聚|agg/i.test(n);
// 注意：「接入区」属互联网接入区语义，不能误配成接入交换层
const RE_ACCESS = (n: string) => !RE_FW.test(n) && /接入交换|接入层|acccore|_acc\b|-acc\b|acc_/i.test(n);
const RE_WLAN = (n: string) => /无线|wuxian|wlan|wireless|airengine|WX35\d/i.test(n);
const RE_DC = (n: string) => /数据中心|idc|\bDC\b|dc[-_]|-dc-|CCR-DC/i.test(n);
const RE_OFFICE = (n: string) => /办公|bangong|办公楼|\bBG\b/i.test(n);
// 生产/工业网（现网大量拼音命名：变电所/机柜间/总变/POE/JR/污水厂…）
const RE_PROD = /biandiansuo|变电所|jiguijian|机柜间|zongbian|总变|POE|JR-|anquangongju|安全工具|shuichang|污水|guandian|配电|motorsuo|电机|guangqiance|DCS|PLC|zhumen|门卫|guanqu|园区/i;

/** 区域判定：DB 人工 override 优先，否则命名语义；兜底 other */
export function classifyGroup(n: ClsNode, override?: string | null): GroupKey {
  if (override && GROUP_ORDER.includes(override as GroupKey)) return override as GroupKey;
  const s = n.display_name || '';
  if (RE_INET_MGMT(s)) return 'internet';
  if (RE_FW.test(s)) return 'firewall';
  if (RE_WLAN(s)) return 'wireless';
  if (RE_CORE(s) || RE_AGG(s)) return 'core'; // 汇聚命名归核心交换区（区域只有八类）
  if (RE_ACCESS(s)) return 'other';
  if (RE_DC(s)) return 'dc';
  if (RE_OFFICE(s)) return 'office';
  if (RE_PROD.test(s)) return 'prod';
  return 'other';
}

/** 层级判定：
 * 1) 具名语义直接钉层（internet 置顶 / fw / core）；
 * 2) 其余设备按真实 LLDP 链路 BFS：连到核心 1 跳=agg 语义带、≥2 跳=access 带、
 *    连到互联网/防火墙设备的挂 fw 带之下（linked 带，如实标注"跳数推断"）；
 * 3) 与任何已具层设备无链路 = unlinked（绝不猜位置）。
 * 同组件内 internet 组整体统一深度（互联链不得把组内节点拉开层级——memory 定版规则）。 */
export function classifyBands(nodes: ClsNode[], links: ClsLink[]): Map<number, Band> {
  const byId = new Map(nodes.map(n => [n.node_id, n]));
  const adj = new Map<number, number[]>();
  for (const l of links) {
    if (l.a == null || l.b == null) continue;
    if (!adj.has(l.a)) adj.set(l.a, []);
    if (!adj.has(l.b)) adj.set(l.b, []);
    adj.get(l.a)!.push(l.b);
    adj.get(l.b)!.push(l.a);
  }
  const band = new Map<number, Band>();
  for (const n of nodes) {
    const s = n.display_name || '';
    if (RE_INET_MGMT(s)) band.set(n.node_id, 'internet');
    else if (RE_FW.test(s)) band.set(n.node_id, 'fw');
    else if (RE_CORE(s)) band.set(n.node_id, 'core');
  }
  // BFS：种子=具层设备；hop 决定其余设备落带（只沿真实链路）
  let frontier: number[] = [...band.keys()];
  let hop = 0;
  while (frontier.length && hop < 6) {
    hop++;
    const next: number[] = [];
    for (const nid of frontier) {
      const b = band.get(nid)!;
      for (const nb of (adj.get(nid) || [])) {
        if (band.has(nb)) continue;
        // 邻居语义优先：聚合语义词按词义，否则按"种子带 + 跳数"衰减落位
        let target: Band;
        if (b === 'internet') target = 'fw';
        else if (b === 'fw') target = hop === 1 ? 'core' : 'linked';
        else if (b === 'core') target = hop <= 1 ? 'agg' : 'access';
        else target = 'linked';
        if (target !== 'linked' && hop > 3) target = 'linked';
        band.set(nb, target);
        next.push(nb);
      }
    }
    frontier = next;
  }
  for (const n of nodes) {
    if (band.has(n.node_id)) continue;
    const deg = (adj.get(n.node_id) || []).length;
    band.set(n.node_id, deg > 0 ? 'linked' : 'unlinked');
  }
  // internet 组统一最浅深度：若某 internet 节点被 BFS 判深（互联链导致），拉回置顶组
  const internetNodes = nodes.filter(n => RE_INET_MGMT(n.display_name || ''));
  for (const n of internetNodes) band.set(n.node_id, 'internet');
  return band;
}
