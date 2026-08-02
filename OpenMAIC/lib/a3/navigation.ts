import {
  BrainCircuit,
  CalendarDays,
  ClipboardCheck,
  Database,
  LineChart,
  NotebookPen,
  PlayCircle,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { A3NavItem } from './types';

export const a3NavItems: A3NavItem[] = [
  {
    href: '/a3/today',
    label: '今日学习',
    icon: PlayCircle,
    children: [
      { href: '/a3/today', label: '今日任务' },
      { href: '/a3/dashboard', label: '首页' },
      { href: '/a3/notifications', label: '通知消息' },
    ],
  },
  {
    href: '/a3/study-plan',
    label: '学习规划',
    icon: CalendarDays,
    children: [
      { href: '/a3/study-plan', label: '计划总览' },
      { href: '/a3/admission-diagnostic', label: '入学诊断' },
      { href: '/a3/profile-setup', label: '学习画像' },
      { href: '/a3/learning-path', label: '学习路径' },
      { href: '/a3/courses', label: '课程学习' },
    ],
  },
  {
    href: '/a3/assessment',
    label: '练习复盘',
    icon: ClipboardCheck,
    children: [
      { href: '/a3/assessment', label: '练习中心' },
      { href: '/a3/wrong-notebook', label: '错题本' },
      { href: '/a3/labs', label: '交互实验' },
    ],
  },
  {
    href: '/a3/classroom',
    label: 'AI 学习',
    icon: BrainCircuit,
    children: [
      { href: '/a3/classroom', label: 'AI 课堂' },
      { href: '/a3/coaching', label: '面对面辅导' },
      { href: '/a3/recommendations', label: '资源包生成' },
      { href: '/a3/library', label: '系统资料' },
      { href: '/a3/resources', label: '资源记录' },
      { href: '/a3/favorites', label: '我的收藏' },
    ],
  },
  {
    href: '/a3/notes',
    label: '个人笔记',
    icon: NotebookPen,
    roles: ['student'],
  },
  {
    href: '/a3/knowledge-base',
    label: '知识库',
    icon: Database,
    children: [
      { href: '/a3/knowledge-base', label: '知识库首页' },
      { href: '/a3/knowledge-graph', label: '知识图谱' },
    ],
  },
  { href: '/a3/report', label: '学习报告', icon: LineChart },
  { href: '/a3/teacher', label: '教师工作台', icon: Users, roles: ['teacher', 'admin'] },
  {
    href: '/a3/admin/overview',
    label: '系统管理',
    icon: ShieldCheck,
    roles: ['admin'],
    children: [
      { href: '/a3/admin/overview', label: '运行总览' },
      { href: '/a3/admin/users', label: '用户管理' },
    ],
  },
];

export function a3GetNavItemsForRole(role: 'student' | 'teacher' | 'admin' | null | undefined) {
  return a3NavItems.filter((item) => !item.roles || Boolean(role && item.roles.includes(role)));
}

const secondaryNavOwners: Array<{ prefix: string; owner: string }> = [
  { prefix: '/a3/dashboard', owner: '/a3/today' },
  { prefix: '/a3/notifications', owner: '/a3/today' },
  { prefix: '/a3/admission-diagnostic', owner: '/a3/study-plan' },
  { prefix: '/a3/profile-setup', owner: '/a3/study-plan' },
  { prefix: '/a3/learning-path', owner: '/a3/study-plan' },
  { prefix: '/a3/courses', owner: '/a3/study-plan' },
  { prefix: '/a3/wrong-notebook', owner: '/a3/assessment' },
  { prefix: '/a3/labs', owner: '/a3/assessment' },
  { prefix: '/a3/coaching', owner: '/a3/classroom' },
  { prefix: '/a3/recommendations', owner: '/a3/classroom' },
  { prefix: '/a3/library', owner: '/a3/classroom' },
  { prefix: '/a3/resources', owner: '/a3/classroom' },
  { prefix: '/a3/favorites', owner: '/a3/classroom' },
  { prefix: '/a3/knowledge-graph', owner: '/a3/knowledge-base' },
  { prefix: '/a3/admin', owner: '/a3/admin/overview' },
];

export function a3GetActiveNavHref(pathname: string) {
  const direct = a3NavItems.find((item) => item.href === pathname);
  if (direct) return direct.href;

  const match = secondaryNavOwners.find((item) => pathname === item.prefix || pathname.startsWith(`${item.prefix}/`));
  return match?.owner ?? pathname;
}
