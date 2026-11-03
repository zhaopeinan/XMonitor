/** 台账「操作系统」级联选项：先选发行版/产品，再选版本号 */
export interface OsFamily {
  name: string;
  versions: string[];
}

export const OS_FAMILIES: OsFamily[] = [
  {
    name: 'CentOS',
    versions: ['6', '7', '7.9', '8', 'Stream 8', 'Stream 9'],
  },
  {
    name: 'RHEL',
    versions: ['7', '8', '9', '10'],
  },
  {
    name: 'Rocky Linux',
    versions: ['8', '9', '10'],
  },
  {
    name: 'AlmaLinux',
    versions: ['8', '9', '10'],
  },
  {
    name: 'Ubuntu',
    versions: ['18.04 LTS', '20.04 LTS', '22.04 LTS', '24.04 LTS'],
  },
  {
    name: 'Debian',
    versions: ['10', '11', '12', '13'],
  },
  {
    name: 'openEuler',
    versions: ['20.03 LTS', '22.03 LTS', '24.03 LTS'],
  },
  {
    name: 'Anolis OS',
    versions: ['7', '8'],
  },
  {
    name: '银河麒麟',
    versions: ['V10', 'V10 SP1', 'V10 SP2', 'V10 SP3'],
  },
  {
    name: '统信 UOS',
    versions: ['V20', 'Desktop 20', 'Server 20'],
  },
  {
    name: 'SLES',
    versions: ['12', '15', '15 SP4', '15 SP5', '15 SP6'],
  },
  {
    name: 'openSUSE',
    versions: ['Leap 15.5', 'Leap 15.6', 'Tumbleweed'],
  },
  {
    name: 'Fedora',
    versions: ['39', '40', '41', '42'],
  },
  {
    name: 'Windows Server',
    versions: ['2012 R2', '2016', '2019', '2022', '2025'],
  },
  {
    name: 'Windows',
    versions: ['10', '11'],
  },
  {
    name: 'FreeBSD',
    versions: ['13', '14'],
  },
  {
    name: '其他',
    versions: [],
  },
];

export const OS_FAMILY_NAMES = OS_FAMILIES.map((f) => f.name);

export function versionsOf(osName: string): string[] {
  return OS_FAMILIES.find((f) => f.name === osName)?.versions ?? [];
}

/** 运维类型 */
export const OPS_TYPE_OPTIONS = [
  { value: 'long_term', label: '长期运维' },
  { value: 'phased', label: '阶段性运维' },
] as const;

export type OpsTypeValue = (typeof OPS_TYPE_OPTIONS)[number]['value'] | '';

export function opsTypeLabel(value: string | null | undefined): string {
  if (!value) return '';
  return OPS_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/** 安全域（单选）；VLAN 仅作展示参考，710 对应两个不同域 */
export const SECURITY_DOMAIN_OPTIONS = [
  { value: 'data_mid_1', label: '数据中台安全域-1', vlan: 630 },
  { value: 'data_mid_2', label: '数据中台安全域-2', vlan: 635 },
  { value: 'sensitive_data', label: '敏感数据系统安全域', vlan: 610 },
  { value: 'general_app', label: '普通应用安全域', vlan: 615 },
  { value: 'phy_oob', label: '物理机带外管理', vlan: 710 },
  { value: 'external_ops', label: '外部运维安全域', vlan: 620 },
  { value: 'server_oob', label: '服务器带外管理域', vlan: 710 },
] as const;

export type SecurityDomainValue = (typeof SECURITY_DOMAIN_OPTIONS)[number]['value'] | '';

export function securityDomainLabel(value: string | null | undefined): string {
  if (!value) return '';
  return SECURITY_DOMAIN_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function securityDomainOptionLabel(opt: (typeof SECURITY_DOMAIN_OPTIONS)[number]): string {
  return `${opt.label}（VLAN ${opt.vlan}）`;
}

/** 列表里一行展示的服务器配置摘要，例如 8C / 16G / 500G */
export function serverSpecSummary(entry: {
  cpu_cores?: number | null;
  memory_gb?: number | null;
  disk_gb?: number | null;
}): string {
  const parts: string[] = [];
  if (entry.cpu_cores != null && Number.isFinite(entry.cpu_cores)) parts.push(`${entry.cpu_cores}C`);
  if (entry.memory_gb != null && Number.isFinite(entry.memory_gb)) parts.push(`${entry.memory_gb}G`);
  if (entry.disk_gb != null && Number.isFinite(entry.disk_gb)) parts.push(`${entry.disk_gb}G`);
  return parts.join(' / ');
}

export function osSummary(entry: { os_name?: string; os_version?: string }): string {
  const name = (entry.os_name ?? '').trim();
  const ver = (entry.os_version ?? '').trim();
  if (!name && !ver) return '';
  if (!ver) return name;
  if (!name) return ver;
  return `${name} ${ver}`;
}
