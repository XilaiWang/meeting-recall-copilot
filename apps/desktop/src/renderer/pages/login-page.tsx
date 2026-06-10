import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth-store.js';
// Why: 复用共享 a11y 原语与 Spinner，保证焦点环/禁用态/loading 表现与全应用一致。
import Spinner from '../components/ui/spinner.js';
import { FOCUS_RING, DISABLED } from '../lib/ui.js';

type Mode = 'login' | 'signup';

export default function LoginPage() {
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    const res =
      mode === 'login'
        ? await window.api.auth.login(email, password)
        : await window.api.auth.signup(email, password, displayName || undefined);

    setSubmitting(false);

    if (!res.ok || !res.data) {
      setError(res.error?.message ?? '请求失败，请重试');
      return;
    }

    setUser({
      userId: res.data.user.id,
      email: res.data.user.email,
      displayName: res.data.user.displayName ?? undefined,
      licenseStatus: res.data.user.licenseStatus,
      // Why: fresh login = verified online at this moment; no grace period needed.
      offlineDaysLeft: null,
    });
    navigate('/');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
        <h1 className="text-2xl font-semibold text-center mb-1">问答匹配</h1>
        <p className="text-sm text-gray-500 text-center mb-8">
          {mode === 'login' ? '登录你的账户' : '创建新账户'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Why: 错误提示放表单顶部更易被立即看到；role/aria 让屏幕阅读器即时播报。 */}
          {error && (
            <p
              role="alert"
              aria-live="polite"
              className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg"
            >
              {error}
            </p>
          )}

          {mode === 'signup' && (
            <div>
              {/* Why: 文案点明昵称用途与可选性，降低注册时填写顾虑。 */}
              <label className="block text-sm font-medium text-gray-700 mb-1">昵称（用于展示，可不填）</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 ${FOCUS_RING}`}
                placeholder="你的名字"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 ${FOCUS_RING}`}
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 ${FOCUS_RING}`}
              placeholder="至少 8 位，含数字"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className={`w-full py-2.5 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors flex items-center justify-center gap-2 ${DISABLED} ${FOCUS_RING}`}
          >
            {/* Why: 提交中内嵌 Spinner 给出明确进行态反馈，文案同步切换。 */}
            {submitting && <Spinner className="w-4 h-4" />}
            {submitting ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500 mt-6">
          {mode === 'login' ? '还没有账户？' : '已有账户？'}
          {/* Why: 切换按钮降权(灰->深 hover)，与主 CTA 拉开视觉层级，避免抢焦点。 */}
          <button
            type="button"
            onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); }}
            className={`ml-1 text-gray-600 hover:text-gray-900 font-medium hover:underline rounded ${FOCUS_RING}`}
          >
            {mode === 'login' ? '注册' : '登录'}
          </button>
        </p>
      </div>
    </div>
  );
}
