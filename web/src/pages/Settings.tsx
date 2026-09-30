import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import LlmProfilesSection from '../components/LlmProfilesSection';
import { StatusDot } from '../components/StatusDot';
import { Card, ErrorBanner, PageHeader, Skeleton, Spinner, Toggle } from '../components/ui';
import type { SettingsMap, SsoTestResult, TestResult } from '../types';
import { errMsg, isTruthy } from '../utils';

const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200';

const DEFAULTS: SettingsMap = {
  obscura_endpoint: '',
  sso_enabled: 'false',
  sso_username: '',
  sso_password: '',
  webhook_url: '',
  webhook_template: 'generic',
  default_interval_sec: '60',
  default_timeout_sec: '15',
  slow_threshold_ms: '3000',
  llm_timeout_sec: '3600',
};

// 旧的单模型 llm_* 配置已由「模型档案」接管，PUT 时不再回传这些键
const LEGACY_LLM_KEYS = ['llm_base_url', 'llm_api_key', 'llm_model', 'llm_multimodal'];

const SSO_LEVEL_DOT: Record<string, string> = {
  info: 'bg-slate-300',
  success: 'bg-emerald-500',
  warn: 'bg-amber-400',
  error: 'bg-rose-500',
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export default function Settings() {
  const [form, setForm] = useState<SettingsMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [obscura, setObscura] = useState<TestResult | null>(null);
  const [ssoTestUrl, setSsoTestUrl] = useState('');
  const [ssoTest, setSsoTest] = useState<{ testing: boolean; result?: SsoTestResult }>({
    testing: false,
  });

  const load = useCallback(async () => {
    try {
      const res = await api.getSettings();
      const cleaned = { ...res };
      for (const key of LEGACY_LLM_KEYS) delete cleaned[key];
      setForm({ ...DEFAULTS, ...cleaned });
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  const loadObscura = useCallback(async () => {
    try {
      setObscura(await api.obscuraHealth());
    } catch (e) {
      setObscura({ ok: false, error: errMsg(e) });
    }
  }, []);

  useEffect(() => {
    void load();
    void loadObscura();
  }, [load, loadObscura]);

  const set =
    (key: keyof SettingsMap) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((prev) => (prev ? { ...prev, [key]: e.target.value } : prev));
      setSaved(false);
    };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      // sso_password 留空或保持打码值回传，后端识别后保留原值
      await api.putSettings(form);
      setSaved(true);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const testSso = async () => {
    if (!ssoTestUrl.trim()) return;
    setSsoTest({ testing: true });
    try {
      // 直接用表单当前值测试（未保存也能测）；密码为打码值时省略，由后端回落到已保存值
      const username = form?.sso_username?.trim() || undefined;
      const pwd = form?.sso_password || '';
      const password = pwd && !pwd.startsWith('****') ? pwd : undefined;
      const result = await api.testSso(ssoTestUrl.trim(), { username, password });
      setSsoTest({ testing: false, result });
    } catch (e) {
      setSsoTest({ testing: false, result: { ok: false, message: errMsg(e) } });
    }
  };

  if (!form && !error) {
    return (
      <div>
        <Skeleton className="mb-4 h-8 w-32" />
        <Skeleton className="mb-4 h-56" />
        <Skeleton className="h-56" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader title="设置" description="大模型、浏览器与告警的全局配置" />

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {form && (
        <div className="flex flex-col gap-5">
          {/* 大模型（多档案 + 激活切换） */}
          <LlmProfilesSection />

          {/* 大模型请求超时 */}
          <Card className="p-5">
            <h3 className="mb-4 text-sm font-semibold text-slate-900">大模型请求</h3>
            <Field
              label="请求超时（秒）"
              hint="AI 分析和验证码识别的单次请求最长等待时间。多模态模型处理截图较慢，建议保持较大值；默认 3600 秒。"
            >
              <input
                className={inputCls}
                type="number"
                min={5}
                max={14400}
                value={form.llm_timeout_sec}
                onChange={set('llm_timeout_sec')}
              />
            </Field>
          </Card>

          {/* 统一身份认证（SSO） */}
          <Card className="p-5">
            <h3 className="mb-1 text-sm font-semibold text-slate-900">统一身份认证（SSO）</h3>
            <p className="mb-4 text-xs text-slate-400">
              用于需要统一身份认证登录的系统。分析和巡检时自动完成登录；验证码识别需要当前激活的
              LLM 档案开启多模态。
            </p>
            <div className="flex flex-col gap-4">
              <label className="flex items-center gap-2.5 text-sm text-slate-700">
                <Toggle
                  on={isTruthy(form.sso_enabled)}
                  onChange={() => {
                    setForm((prev) =>
                      prev
                        ? { ...prev, sso_enabled: isTruthy(prev.sso_enabled) ? 'false' : 'true' }
                        : prev,
                    );
                    setSaved(false);
                  }}
                />
                启用统一身份认证
              </label>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="用户名">
                  <input
                    className={inputCls}
                    autoComplete="off"
                    value={form.sso_username}
                    onChange={set('sso_username')}
                  />
                </Field>
                <Field label="密码" hint="留空或保持打码值表示不修改">
                  <input
                    className={inputCls}
                    type="password"
                    autoComplete="new-password"
                    value={form.sso_password}
                    onChange={set('sso_password')}
                  />
                </Field>
              </div>

              {/* 测试 SSO 登录 */}
              <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
                <p className="mb-2.5 text-xs font-medium uppercase tracking-wide text-slate-400">
                  测试 SSO 登录
                </p>
                <div className="flex gap-2">
                  <input
                    className={inputCls}
                    type="url"
                    placeholder="填系统网址，如 https://example.com"
                    value={ssoTestUrl}
                    onChange={(e) => setSsoTestUrl(e.target.value)}
                  />
                  <button
                    onClick={() => void testSso()}
                    disabled={ssoTest.testing || !ssoTestUrl.trim()}
                    className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
                  >
                    {ssoTest.testing && <Spinner className="border-white/40 border-t-white" />}
                    测试登录
                  </button>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-slate-400">
                  输入业务系统的网址即可，系统会自动跟随跳转到统一身份认证页（跳转参数每次不同，无需关心），完成登录后再跳回系统。测试使用上方表单中当前填写的账号密码（未保存也能测）；日常分析和巡检使用的是「保存设置」后的凭据。
                </p>
                {ssoTest.result && (
                  <div className="mt-3">
                    {ssoTest.result.steps && ssoTest.result.steps.length > 0 && (
                      <ol className="relative mb-2.5 ml-1 border-l border-slate-200">
                        {ssoTest.result.steps.map((s, i) => (
                          <li key={i} className="relative mb-2 ml-4 last:mb-0">
                            <span
                              className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full border border-white ${
                                SSO_LEVEL_DOT[s.level] ?? SSO_LEVEL_DOT.info
                              }`}
                            />
                            <span
                              className={`text-xs ${
                                s.level === 'error'
                                  ? 'text-rose-600'
                                  : s.level === 'warn'
                                    ? 'text-amber-600'
                                    : 'text-slate-600'
                              }`}
                            >
                              {s.message}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                    <p
                      className={`text-sm font-medium ${
                        ssoTest.result.ok ? 'text-emerald-600' : 'text-rose-600'
                      }`}
                    >
                      {ssoTest.result.ok ? '登录成功' : '登录失败'}
                      {ssoTest.result.message ? `：${ssoTest.result.message}` : ''}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* obscura 浏览器 */}
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">obscura 浏览器</h3>
              <span className="flex items-center gap-2 text-xs text-slate-500">
                <StatusDot status={obscura ? (obscura.ok ? 'up' : 'down') : 'unknown'} size="h-2 w-2" />
                {obscura ? (obscura.ok ? '连接正常' : `异常${obscura.error ? `：${obscura.error}` : ''}`) : '检测中…'}
              </span>
            </div>
            <Field label="CDP 端点" hint="例如 ws://127.0.0.1:9222/devtools/browser">
              <input className={inputCls} value={form.obscura_endpoint} onChange={set('obscura_endpoint')} />
            </Field>
          </Card>

          {/* 告警 */}
          <Card className="p-5">
            <h3 className="mb-4 text-sm font-semibold text-slate-900">告警通知</h3>
            <div className="flex flex-col gap-4">
              <Field label="Webhook URL" hint="状态变化时向该地址推送告警，留空则不推送">
                <input className={inputCls} value={form.webhook_url} onChange={set('webhook_url')} />
              </Field>
              <Field label="Webhook 模板">
                <select className={inputCls} value={form.webhook_template} onChange={set('webhook_template')}>
                  <option value="generic">通用 JSON</option>
                  <option value="dingtalk">钉钉</option>
                  <option value="wecom">企业微信</option>
                </select>
              </Field>
            </div>
          </Card>

          {/* 默认值 */}
          <Card className="p-5">
            <h3 className="mb-4 text-sm font-semibold text-slate-900">探测默认值</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="检查间隔（秒）">
                <input
                  className={inputCls}
                  type="number"
                  min={5}
                  value={form.default_interval_sec}
                  onChange={set('default_interval_sec')}
                />
              </Field>
              <Field label="超时时间（秒）">
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  value={form.default_timeout_sec}
                  onChange={set('default_timeout_sec')}
                />
              </Field>
              <Field label="缓慢阈值（毫秒）">
                <input
                  className={inputCls}
                  type="number"
                  min={100}
                  value={form.slow_threshold_ms}
                  onChange={set('slow_threshold_ms')}
                />
              </Field>
            </div>
          </Card>

          <div className="flex items-center justify-end gap-3">
            {saved && <span className="text-sm text-emerald-600">已保存</span>}
            <button
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
            >
              {saving && <Spinner className="border-white/40 border-t-white" />}
              保存设置
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
