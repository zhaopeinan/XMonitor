import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth, type Permission } from '../auth';
import { Spinner } from '../components/ui';
import { errMsg } from '../utils';

export default function Login() {
  const { markLoggedIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const [captchaSvg, setCaptchaSvg] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [captchaLoading, setCaptchaLoading] = useState(false);

  const refreshCaptcha = useCallback(async () => {
    setCaptchaLoading(true);
    try {
      const res = await api.getCaptcha();
      setCaptchaId(res.captcha_id);
      setCaptchaSvg(res.captcha_svg);
      setCaptchaCode('');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setCaptchaLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCaptcha();
  }, [refreshCaptcha]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending || !username.trim() || !password || !captchaCode.trim()) return;
    setPending(true);
    setError(null);
    try {
      const res = await api.login(username.trim(), password, captchaId, captchaCode.trim());
      markLoggedIn(res.user, res.permissions as Permission[]);
    } catch (err) {
      setError(errMsg(err));
      void refreshCaptcha();
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 text-lg font-bold text-white">
            XM
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">XMonitor</h1>
          <p className="mt-1 text-sm text-slate-400">系统接口监控平台</p>
        </div>

        <form
          onSubmit={(e) => void submit(e)}
          className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <label className="mb-1 block text-xs font-medium text-slate-500">用户名</label>
          <input
            className="mb-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="请输入用户名"
            autoComplete="username"
            autoFocus
          />
          <label className="mb-1 block text-xs font-medium text-slate-500">密码</label>
          <input
            className="mb-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入密码"
            autoComplete="current-password"
          />
          <label className="mb-1 block text-xs font-medium text-slate-500">验证码</label>
          <div className="mb-4 flex items-center gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm uppercase tracking-widest text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
              value={captchaCode}
              onChange={(e) => setCaptchaCode(e.target.value)}
              placeholder="输入右侧字符"
              autoComplete="off"
              maxLength={8}
            />
            <button
              type="button"
              title="点击刷新验证码"
              onClick={() => void refreshCaptcha()}
              disabled={captchaLoading}
              className="h-10 w-[140px] shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 transition hover:border-slate-300 disabled:opacity-50"
            >
              {captchaSvg ? (
                <span
                  className="block h-full w-full [&>svg]:h-full [&>svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: captchaSvg }}
                />
              ) : (
                <span className="flex h-full items-center justify-center text-xs text-slate-400">加载中…</span>
              )}
            </button>
          </div>
          {error && (
            <p className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={pending || !username.trim() || !password || !captchaCode.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-40"
          >
            {pending && <Spinner className="border-white/40 border-t-white" />}
            登 录
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-slate-300">接口状态持续巡检 · 异常实时预警</p>
      </div>
    </div>
  );
}
