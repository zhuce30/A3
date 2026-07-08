import type { LucideIcon } from 'lucide-react';
import type { A3UserRole } from './auth-types';

export type A3NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  roles?: A3UserRole[];
  children?: Array<{
    href: string;
    label: string;
  }>;
};

export type A3Metric = {
  label: string;
  value: string;
  delta?: string;
  tone?: 'blue' | 'green' | 'violet' | 'orange' | 'red';
};

export type A3Agent = {
  id: string;
  name: string;
  role: string;
  status: 'active' | 'waiting' | 'idle';
  description: string;
  color: string;
};

export type A3KnowledgeSource = {
  title: string;
  type: '教材' | '课件' | '问答' | '论文';
  location: string;
  score: string;
};

export type A3Task = {
  title: string;
  subtitle: string;
  progress: number;
  status: '已完成' | '进行中' | '待开始';
};

export type A3Resource = {
  title: string;
  kind: '视频' | '练习' | '文档' | '知识卡片';
  meta: string;
  progress?: number;
};

export type A3AssessmentItem = {
  title: string;
  difficulty: '基础' | '进阶' | '挑战';
  state: '已练' | '未练';
};

export type A3KnowledgeFile = {
  name: string;
  type: string;
  tags: string[];
  chunks: number;
  status: string;
  updatedAt: string;
};

export type A3GraphNode = {
  label: string;
  state: '已掌握' | '掌握中' | '待加强' | '薄弱' | '未学习';
  x: number;
  y: number;
};
