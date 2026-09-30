import type {
  AlertsResponse,
  UserItem,
  AnalysisResult,
  CheckRecord,
  DashboardData,
  LlmChannel,
  LlmModel,
  LlmProfile,
  LlmTestResult,
  MonitorSummary,
  ScreenData,
  SettingsMap,
  SsoTestResult,
  SystemInfo,
  SystemMetricsPayload,
  ChannelMetricsPayload,
  SystemRow,
  SystemStatusPayload,
  TestResult,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch {
    throw new ApiError(0, '无法连接到服务器，请检查后端是否已启动');
  }
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new CustomEvent('xm:unauthorized'));
  }
  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string; message?: string };
      if (data?.error) message = data.error;
      else if (data?.message) message = data.message;
    } catch {
      // 非 JSON 错误响应，保留默认信息
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
}

export const api = {
  dashboard: () => request<DashboardData>('/api/dashboard'),
  screen: () => request<ScreenData>('/api/screen'),

  createSystem: (body: { name: string; base_url: string; use_sso?: boolean }) =>
    post<SystemInfo>('/api/systems', body),
  getSystem: (id: number) => request<SystemRow | { system: SystemRow }>(`/api/systems/${id}`),
  getSystemMetrics: (id: number, range: '24h' | '7d' | '30d' = '24h') =>
    request<SystemMetricsPayload>(`/api/systems/${id}/metrics?range=${range}`),
  getLlmChannelMetrics: (id: number, range: '24h' | '7d' | '30d' = '24h') =>
    request<ChannelMetricsPayload>(`/api/llm-channels/${id}/metrics?range=${range}`),
  getLlmModelChecks: (id: number, hours = 24) =>
    request<CheckRecord[] | { checks: CheckRecord[] }>(`/api/llm-models/${id}/checks?hours=${hours}`),
  patchSystem: (id: number, patch: { name?: string; base_url?: string; use_sso?: boolean; auth_token?: string }) =>
    request<unknown>(`/api/systems/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteSystem: (id: number) =>
    request<unknown>(`/api/systems/${id}`, { method: 'DELETE' }),
  startAnalysis: (systemId: number) =>
    post<unknown>(`/api/systems/${systemId}/analyze`),
  getAnalysis: (systemId: number) =>
    request<AnalysisResult>(`/api/systems/${systemId}/analysis`),
  createMonitors: (systemId: number, candidateIds: number[]) =>
    post<unknown>(`/api/systems/${systemId}/monitors`, { candidate_ids: candidateIds }),

  patchMonitor: (id: number, patch: { enabled?: boolean; expect_mode?: 'up' | 'down' }) =>
    request<unknown>(`/api/monitors/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteMonitor: (id: number) =>
    request<unknown>(`/api/monitors/${id}`, { method: 'DELETE' }),
  setSystemReverse: (systemId: number, enabled: boolean, monitorIds?: number[]) =>
    post<{
      ok: boolean;
      expect_mode: string;
      reverse_count: number;
      total: number;
      monitors: MonitorSummary[];
    }>(`/api/systems/${systemId}/reverse`, {
      enabled,
      ...(monitorIds ? { monitor_ids: monitorIds } : {}),
    }),
  getChecks: (id: number, hours = 24) =>
    request<CheckRecord[] | { checks: CheckRecord[] }>(
      `/api/monitors/${id}/checks?hours=${hours}`,
    ),

  getAlerts: () => request<AlertsResponse>('/api/alerts'),
  ackAlert: (id: number) => post<unknown>(`/api/alerts/${id}/ack`),

  getSettings: () => request<SettingsMap>('/api/settings'),
  putSettings: (settings: SettingsMap) =>
    request<unknown>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  getLlmProfiles: () => request<{ profiles: LlmProfile[] }>('/api/llm-profiles'),
  createLlmProfile: (body: {
    name: string;
    base_url: string;
    api_key: string;
    model: string;
    multimodal: boolean;
  }) => post<LlmProfile>('/api/llm-profiles', body),
  updateLlmProfile: (
    id: number,
    patch: Partial<{
      name: string;
      base_url: string;
      api_key: string;
      model: string;
      multimodal: boolean;
    }>,
  ) =>
    request<unknown>(`/api/llm-profiles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteLlmProfile: (id: number) =>
    request<unknown>(`/api/llm-profiles/${id}`, { method: 'DELETE' }),
  activateLlmProfile: (id: number) =>
    post<unknown>(`/api/llm-profiles/${id}/activate`),
  testLlmProfile: (profileId?: number) =>
    post<LlmTestResult>(
      '/api/llm-profiles/test',
      profileId === undefined ? {} : { profile_id: profileId },
    ),

  getLlmChannels: () => request<{ channels: LlmChannel[] }>('/api/llm-channels'),
  createLlmChannel: (body: { name: string; base_url: string; api_key?: string }) =>
    post<LlmChannel>('/api/llm-channels', body),
  listUpstreamModels: (body: { base_url: string; api_key?: string; channel_id?: number }) =>
    post<{ ok: boolean; models?: { id: string; owned_by?: string }[]; error?: string }>(
      '/api/llm-channels/list-models',
      body,
    ),
  updateLlmChannel: (
    id: number,
    patch: Partial<{ name: string; base_url: string; api_key: string; enabled: boolean }>,
  ) =>
    request<LlmChannel>(`/api/llm-channels/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteLlmChannel: (id: number) =>
    request<unknown>(`/api/llm-channels/${id}`, { method: 'DELETE' }),
  testLlmChannel: (id: number) => post<LlmTestResult>(`/api/llm-channels/${id}/test`),
  createLlmModel: (
    channelId: number,
    body: {
      name?: string;
      model: string;
      multimodal?: boolean;
      monitor_enabled?: boolean;
      probe_mode?: string;
      interval_sec?: number;
      timeout_sec?: number;
    },
  ) => post<LlmModel>(`/api/llm-channels/${channelId}/models`, body),
  updateLlmModel: (
    id: number,
    patch: Partial<{
      name: string;
      model: string;
      multimodal: boolean;
      monitor_enabled: boolean;
      probe_mode: string;
      interval_sec: number;
      timeout_sec: number;
      slow_threshold_ms: number | null;
      expect_mode: string;
      channel_id: number;
    }>,
  ) =>
    request<LlmModel>(`/api/llm-models/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteLlmModel: (id: number) =>
    request<unknown>(`/api/llm-models/${id}`, { method: 'DELETE' }),
  testLlmModel: (id: number) => post<LlmTestResult>(`/api/llm-models/${id}/test`),

  testSso: (url: string, creds?: { username?: string; password?: string }) =>
    post<SsoTestResult>('/api/sso/test', { url, ...creds }),

  renewToken: (systemId: number) => post<SsoTestResult>(`/api/systems/${systemId}/renew-token`),

  obscuraHealth: () => request<TestResult>('/api/health/obscura'),
  systemStatus: () => request<SystemStatusPayload>('/api/system-status'),

  getCaptcha: () => request<{ captcha_id: string; captcha_svg: string }>('/api/auth/captcha'),
  login: (username: string, password: string, captcha_id: string, captcha_code: string) =>
    post<{
      user: { id: number; username: string; role: 'admin' | 'operator' | 'viewer' };
      permissions: string[];
    }>('/api/auth/login', { username, password, captcha_id, captcha_code }),
  logout: () => post<unknown>('/api/auth/logout'),
  me: () =>
    request<{
      user: { id: number; username: string; role: 'admin' | 'operator' | 'viewer' };
      permissions: string[];
    }>('/api/auth/me'),
  changePassword: (old_password: string, new_password: string) =>
    post<unknown>('/api/auth/change-password', { old_password, new_password }),

  getUsers: () => request<{ users: UserItem[] }>('/api/users'),
  createUser: (body: { username: string; password: string; role: string }) =>
    post<{ users: UserItem[] }>('/api/users', body),
  updateUser: (id: number, patch: { role?: string; password?: string }) =>
    request<{ users: UserItem[] }>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteUser: (id: number) => request<{ users: UserItem[] }>(`/api/users/${id}`, { method: 'DELETE' }),

  getRolePermissions: () =>
    request<{
      permissions: { key: string; label: string; desc: string }[];
      roles: Record<string, string>;
      role_permissions: Record<string, string[]>;
    }>('/api/roles/permissions'),
  updateRolePermissions: (body: { operator?: string[]; viewer?: string[] }) =>
    request<{
      permissions: { key: string; label: string; desc: string }[];
      roles: Record<string, string>;
      role_permissions: Record<string, string[]>;
    }>('/api/roles/permissions', { method: 'PUT', body: JSON.stringify(body) }),
};
