import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
// 去 emoji 化: 用 Phosphor 图标替换手绘 SVG / emoji 视觉符号
import { Copy, Trash, Books, CaretRight, HandWaving } from '@phosphor-icons/react';
import { useAuthStore } from '../store/auth-store.js';
import { useProjectStore } from '../store/project-store.js';
import CreateProjectModal from '../components/create-project-modal.js';
import OfflineGraceBanner from '../components/offline-grace-banner.js';
import { useToast } from '../components/ui/toast.js';
import { useConfirm } from '../components/ui/confirm-dialog.js';
import { CardSkeleton } from '../components/ui/skeleton.js';
import Spinner from '../components/ui/spinner.js';
import { FOCUS_RING, DISABLED } from '../lib/ui.js';
import CountUp from '../components/ui/reactbits/count-up.js';
import AnimatedContent from '../components/ui/reactbits/animated-content.js';
import type { Project } from '../env.js';

// Why: 把原始英文 status 映射为中文，提升可读性；本文件自带一份，避免跨文件 import。
const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  materializing: '上传素材',
  extracting: 'AI 提取中',
  needs_review: '待审核',
  ready: '就绪',
  exported: '已导出',
  archived: '已归档',
};

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - new Date(date).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

function ProjectCard({
  project,
  cloning,
  deleting,
  onOpen,
  onClone,
  onDelete,
}: {
  project: Project;
  cloning: boolean;
  deleting: boolean;
  onOpen: () => void;
  onClone: () => void;
  onDelete: () => void;
}) {
  const isActive = project.status === 'ready' || project.status === 'needs_review';
  return (
    <div className="relative group h-full">
      <button
        onClick={onOpen}
        // Why: h-full + flex-col 让卡片填满网格行高，配合时间戳 mt-auto，使同行/同列卡片等高且底部对齐，不再因描述行数不同而高矮不一。hover 轻微 scale 提供可点击反馈。
        className={`w-full h-full flex flex-col text-left bg-white border border-gray-100 rounded-2xl p-5 hover:border-gray-300 hover:shadow-sm hover:scale-[1.01] transition-all ${FOCUS_RING}`}
      >
        <div className="flex items-center gap-2 mb-3">
          <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-green-400' : 'bg-yellow-400'}`} />
          {/* Why: 展示中文状态而非原始英文，无映射时回退原值兜底。 */}
          <span className="text-xs text-gray-400">{STATUS_LABEL[project.status] ?? project.status}</span>
        </div>
        {/* Why: title 显示完整项目名，line-clamp 截断时鼠标悬停可看全名。 */}
        <h3 title={project.name} className="font-semibold text-gray-900 mb-1 line-clamp-1 pr-14">{project.name}</h3>
        <p className="text-sm text-gray-500 line-clamp-2 mb-3">{project.targetRole}</p>
        {/* mt-auto: 把更新时间推到卡片底部，等高卡片的时间戳整齐对齐。 */}
        <p className="text-xs text-gray-400 mt-auto">{formatRelativeTime(project.updatedAt)} 更新</p>
      </button>
      {/* Hover 操作区: 删除 + 复制; 进行中保持可见。点击 stopPropagation 避免触发卡片打开。 */}
      <div className={`absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity ${cloning || deleting ? 'opacity-100' : ''}`}>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          // Why: 删除进行中或克隆进行中禁用，防止重复触发。
          disabled={deleting || cloning}
          title="删除项目（含素材和卡片）"
          aria-label="删除项目（含素材和卡片）"
          className={`p-1.5 rounded-lg text-gray-300 hover:text-red-600 hover:bg-red-50 transition-colors ${FOCUS_RING} ${DISABLED} ${deleting ? 'text-red-600' : ''}`}
        >
          {deleting ? <Spinner className="w-3.5 h-3.5" /> : <Trash size={14} weight="regular" />}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onClone(); }}
          disabled={cloning || deleting}
          title="复制项目（含素材和卡片）"
          aria-label="复制项目（含素材和卡片）"
          className={`p-1.5 rounded-lg text-gray-300 hover:text-gray-600 hover:bg-gray-100 transition-colors ${FOCUS_RING} ${DISABLED} ${cloning ? 'text-gray-600' : ''}`}
        >
          {cloning ? <Spinner className="w-3.5 h-3.5" /> : <Copy size={14} weight="regular" />}
        </button>
      </div>
    </div>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const projectList = useProjectStore((s) => s.projects);
  const setProjects = useProjectStore((s) => s.setProjects);
  const addProject = useProjectStore((s) => s.addProject);
  const removeProject = useProjectStore((s) => s.removeProject);

  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cloning, setCloning] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    window.api.projects.list().then((list) => {
      setProjects(list);
      setLoading(false);
    });
  }, [setProjects]);

  async function handleCreate(input: { name: string; targetRole: string; jdText?: string }) {
    const created = await window.api.projects.create(input);
    addProject(created);
    navigate(`/projects/${created.id}`);
  }

  async function handleClone(id: string) {
    if (cloning) return;
    setCloning(id);
    try {
      const cloned = await window.api.projects.clone(id);
      addProject(cloned);
      // Why: 克隆成功给出明确成功反馈，再跳转到新项目。
      toast('已复制项目', { variant: 'success' });
      navigate(`/projects/${cloned.id}`);
    } finally {
      setCloning(null);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (deleting) return;
    // Why: 删除会级联清除该项目的素材与卡片，破坏性且不可撤销，必须二次确认。
    const ok = await confirm({
      title: `删除项目「${name}」？`,
      body: '将一并删除该项目的所有素材和卡片，此操作不可撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setDeleting(id);
    try {
      await window.api.projects.delete(id);
      removeProject(id);
      toast('已删除项目', { variant: 'success' });
    } catch {
      toast('删除失败，请重试', { variant: 'error' });
    } finally {
      setDeleting(null);
    }
  }

  // Open the reusable personal corpus (resume/theses/past projects). Lazily created.
  async function openProfile() {
    const profile = await window.api.projects.getOrCreateProfile();
    navigate(`/projects/${profile.id}`);
  }

  async function handleLogout() {
    await window.api.auth.logout();
    setUser(null);
    navigate('/login');
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-100 pl-20 pr-6 py-4 flex items-center justify-between select-none" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <span className="font-semibold text-gray-900">问答匹配</span>
        <div className="flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <span className="text-sm text-gray-500">{user?.email}</span>
          <button onClick={handleLogout} className={`text-sm text-gray-400 hover:text-gray-700 transition-colors rounded ${FOCUS_RING}`}>
            退出
          </button>
        </div>
      </header>

      <OfflineGraceBanner />

      <main className="flex-1 px-8 py-8 max-w-5xl mx-auto w-full">
        {/* Personal corpus entry — fill once, reused across every application. */}
        <button
          onClick={() => { void openProfile(); }}
          // Why: 资料库是「先填一次、全局复用」的核心入口，用 bg-gray-50 + 重字重做视觉提权，引导用户优先填写。
          className={`w-full mb-6 flex items-center gap-3 text-left bg-gray-50 border border-gray-200 rounded-2xl px-5 py-4 hover:bg-gray-100 hover:border-gray-300 hover:shadow-sm transition-all ${FOCUS_RING}`}
        >
          {/* 去 emoji 化: 📚 换 Books 图标 */}
          <Books size={24} weight="regular" />
          <span className="flex-1">
            <span className="block text-base font-bold text-gray-900">我的资料库</span>
            {/* 去符号: 双中点 · 改顿号、, em-dash —— 改逗号， */}
            <span className="block text-sm text-gray-500">个人资料、文档、做过的项目，一次填写，所有会议自动复用</span>
          </span>
          {/* 去 emoji 化: → 换 CaretRight 图标 */}
          <CaretRight size={18} weight="regular" className="text-gray-300" />
        </button>

        {loading ? (
          /* Why: 用卡片骨架占位贴合真实项目网格，避免内容到达时布局跳动。 */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : projectList.length === 0 ? (
          /* S03: 空状态 — 三层结构（标题 / 说明 / 行动），用「建议」语气避免像硬卡点 */
          <div className="flex flex-col items-center justify-center h-64 text-center">
            {/* 去 emoji 化: 👋 换 HandWaving 图标, 放文案前, 容器 inline-flex 对齐 */}
            <p className="inline-flex items-center gap-2 text-2xl font-semibold text-gray-900 mb-2">
              <HandWaving size={28} weight="regular" />
              欢迎，{user?.displayName ?? user?.email?.split('@')[0]}
            </p>
            <p className="text-gray-500 mb-8 max-w-md">
              建议先填好上面的「我的资料库」，之后每个项目都能自动复用，省去重复录入。也可以现在就为某场会议创建第一个项目。
            </p>
            <button
              onClick={() => setModalOpen(true)}
              className={`px-6 py-3 bg-gray-900 text-white rounded-xl font-medium hover:bg-gray-700 transition-colors ${FOCUS_RING}`}
            >
              ＋ 创建第一个项目
            </button>
          </div>
        ) : (
          /* S04: 项目列表 */
          <>
            <div className="flex items-center justify-between mb-6">
              <h1 className="text-xl font-semibold text-gray-900">
                我的项目 <span className="text-gray-400 font-normal text-base">(<CountUp to={projectList.length} duration={0.6} />)</span>
              </h1>
              <button
                onClick={() => setModalOpen(true)}
                className={`px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors ${FOCUS_RING}`}
              >
                ＋ 新项目
              </button>
            </div>
            {/* AnimatedContent: 项目卡片按序淡入上移(stagger), 给首屏列表一点活力。
                注意它基于 gsap ScrollTrigger, 首屏在视口内会自动触发。 */}
            {/* auto-rows-fr: 每行等高，配合卡片 h-full，所有项目框尺寸统一。 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-fr gap-4">
              {projectList.map((p, i) => (
                <AnimatedContent key={p.id} distance={30} duration={0.5} delay={i * 0.05}>
                  <ProjectCard
                    project={p}
                    cloning={cloning === p.id}
                    deleting={deleting === p.id}
                    onOpen={() => navigate(`/projects/${p.id}`)}
                    onClone={() => { void handleClone(p.id); }}
                    onDelete={() => { void handleDelete(p.id, p.name); }}
                  />
                </AnimatedContent>
              ))}
            </div>
          </>
        )}
      </main>

      <CreateProjectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}
