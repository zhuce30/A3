'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { A3_HOMEPAGE_EVIDENCE, A3_HOMEPAGE_FOOTER, A3_HOMEPAGE_STORY } from './a3-homepage-content';
import { A3HomepageTeacherStage } from './a3-homepage-teacher-stage';
import styles from './a3-product-homepage.module.css';

type StoryItem = (typeof A3_HOMEPAGE_STORY)[number];
type ProductStoryItem = StoryItem & { media: string };
type ClassroomMode = 'lesson' | 'citations';

function isProductStoryItem(item: StoryItem): item is ProductStoryItem {
  return item.media !== null;
}

function ProductStorySection({
  item,
  action,
}: {
  item: ProductStoryItem;
  action?: { href: string; label: string };
}) {
  return (
    <section
      id={item.id}
      className={styles.storySection}
      data-story={item.id}
      data-testid={`a3-homepage-${item.id}`}
    >
      <div className={styles.storyCopy}>
        <p className={styles.eyebrow}>{item.index}</p>
        <h2>{item.title}</h2>
        <p>{item.summary}</p>
        {action ? (
          <Link className={styles.sectionLink} href={action.href}>
            {action.label}
          </Link>
        ) : null}
      </div>
      <figure className={styles.fullProductFrame}>
        <Image src={item.media} alt={item.alt} fill sizes="(max-width: 768px) 92vw, 64vw" />
      </figure>
    </section>
  );
}

export function A3ClassroomModeControl({
  mode,
  onChange,
}: {
  mode: ClassroomMode;
  onChange: (mode: ClassroomMode) => void;
}) {
  return (
    <div role="group" aria-label="课堂展示模式" className={styles.segmentedControl}>
      <button type="button" aria-pressed={mode === 'lesson'} onClick={() => onChange('lesson')}>
        讲解
      </button>
      <button
        type="button"
        aria-pressed={mode === 'citations'}
        onClick={() => onChange('citations')}
      >
        引用
      </button>
    </div>
  );
}

export function A3ClassroomModeDetails({ mode }: { mode: ClassroomMode }) {
  if (mode === 'citations') {
    return (
      <div className={styles.citationLabels} aria-live="polite">
        <span>操作系统 / 第 3 章 / 课程 PPT</span>
        <span>进程调度 / 知识总结</span>
      </div>
    );
  }

  return (
    <p className={styles.lessonFocus} aria-live="polite">
      当前讲解：进程调度中的饥饿与公平性
    </p>
  );
}

function KnowledgeFlow() {
  return (
    <div className={styles.knowledgeFlow} aria-label="知识库学习依据流向">
      <div className={styles.knowledgeInputs}>
        <span>操作系统课本</span>
        <span>课程 PPT</span>
        <span>知识总结</span>
      </div>
      <strong>本地知识库</strong>
      <div className={styles.knowledgeOutputs}>
        <span>课堂</span>
        <span>引用</span>
        <span>学习计划</span>
      </div>
    </div>
  );
}

function EvidenceSection({ item }: { item: StoryItem }) {
  return (
    <section id="evidence" className={styles.evidenceSection} data-testid="a3-homepage-evidence">
      <div className={styles.evidenceCopy}>
        <p className={styles.eyebrow}>{item.index}</p>
        <h2>
          每一步，
          <br />
          都有据可循。
        </h2>
        <p>{item.summary}</p>
      </div>
      <div className={styles.evidenceGrid}>
        {A3_HOMEPAGE_EVIDENCE.map((evidence) => (
          <div key={evidence.value}>
            <span>{evidence.label}</span>
            <strong>{evidence.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function ClosingSection() {
  return (
    <>
      <section id="contact" className={styles.closingSection}>
        <h2>
          开启你的
          <br />
          智学旅程。
        </h2>
        <Link className={styles.primaryCta} href="/a3/register">
          开启我的智学旅程
        </Link>
      </section>
      <footer className={styles.footer}>
        <span>团队：{A3_HOMEPAGE_FOOTER.team}</span>
        <span>比赛：{A3_HOMEPAGE_FOOTER.competition}</span>
        <a href={`mailto:${A3_HOMEPAGE_FOOTER.email}`}>邮箱：{A3_HOMEPAGE_FOOTER.email}</a>
      </footer>
    </>
  );
}

export function A3HomepageStory() {
  const [classroomMode, setClassroomMode] = useState<ClassroomMode>('lesson');
  const [profile, diagnostic, knowledge, classroom, coaching, evidence, teacher] =
    A3_HOMEPAGE_STORY;

  if (
    !profile ||
    !diagnostic ||
    !knowledge ||
    !classroom ||
    !coaching ||
    !evidence ||
    !teacher ||
    !isProductStoryItem(profile) ||
    !isProductStoryItem(diagnostic) ||
    !isProductStoryItem(knowledge) ||
    !isProductStoryItem(classroom) ||
    !isProductStoryItem(teacher)
  ) {
    return null;
  }

  return (
    <div id="capabilities" className={styles.story}>
      <ProductStorySection item={profile} />
      <ProductStorySection item={diagnostic} />

      <div id="learning-loop" className={styles.knowledgeBand}>
        <ProductStorySection item={knowledge} />
        <KnowledgeFlow />
      </div>

      <div className={styles.classroomBand}>
        <ProductStorySection item={classroom} />
        <div className={styles.classroomControls}>
          <A3ClassroomModeControl mode={classroomMode} onChange={setClassroomMode} />
          <A3ClassroomModeDetails mode={classroomMode} />
        </div>
      </div>

      <section
        id={coaching.id}
        className={styles.coachingSection}
        data-testid="a3-homepage-coaching"
      >
        <div className={styles.storyCopy}>
          <p className={styles.eyebrow}>{coaching.index}</p>
          <h2>{coaching.title}</h2>
          <p>{coaching.summary}</p>
        </div>
        <A3HomepageTeacherStage />
      </section>

      <EvidenceSection item={evidence} />
      <ProductStorySection
        item={teacher}
        action={{ href: '/a3/teacher', label: '进入教师工作台' }}
      />
      <ClosingSection />
    </div>
  );
}
