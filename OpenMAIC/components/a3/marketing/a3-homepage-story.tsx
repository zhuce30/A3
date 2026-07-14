import Link from 'next/link';
import { A3_HOMEPAGE_EVIDENCE, A3_HOMEPAGE_FOOTER, A3_HOMEPAGE_STORY } from './a3-homepage-content';
import { A3HomepageClassroomIsland } from './a3-homepage-classroom-island';
import { A3HomepageProductMedia } from './a3-homepage-product-media';
import { A3HomepageResourceShowcase } from './a3-homepage-resource-showcase';
import { A3HomepageTeacherStage } from './a3-homepage-teacher-stage';
import styles from './a3-product-homepage.module.css';

type StoryItem = (typeof A3_HOMEPAGE_STORY)[number];
type StoryAction = { href: string; label: string; prefetch?: boolean };

function ProductStorySection({
  item,
  actions = [],
  sectionId,
}: {
  item: StoryItem;
  actions?: StoryAction[];
  sectionId?: string;
}) {
  return (
    <section
      id={sectionId ?? item.id}
      className={styles.storySection}
      data-story={item.id}
      data-testid={`a3-homepage-${item.id}`}
    >
      <div className={styles.storyCopy}>
        <p className={styles.eyebrow}>{item.index}</p>
        <h2>{item.title}</h2>
        <p>{item.summary}</p>
        {actions.length ? (
          <div className={styles.sectionActions}>
            {actions.map((action) => (
              <Link
                key={action.href}
                className={styles.sectionLink}
                href={action.href}
                prefetch={action.prefetch}
              >
                {action.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
      <figure className={styles.fullProductFrame}>
        <A3HomepageProductMedia
          src={item.media}
          alt={item.alt}
          sizes="(max-width: 767px) calc(100vw - 36px), 64vw"
        />
      </figure>
    </section>
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

function EvidenceSection() {
  return (
    <section id="evidence" className={styles.evidenceSection} data-testid="a3-homepage-evidence">
      <div className={styles.evidenceCopy}>
        <p className={styles.eyebrow}>11 / VERIFIABLE</p>
        <h2>主张可以被复现，限制也应该被说明。</h2>
        <p>
          以下数据是 2026-07-14 的工程回归快照，用于说明当前链路可验证，不代表永久不变的产品承诺。
        </p>
        <Link className={styles.sectionLink} href="/a3/capabilities" prefetch={false}>
          查看能力与验证方式
        </Link>
      </div>
      <div className={styles.evidenceGrid}>
        {A3_HOMEPAGE_EVIDENCE.map((evidence) => (
          <div key={evidence.value}>
            <span>{evidence.label}</span>
            <strong>{evidence.value}</strong>
            <p>{evidence.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function TrustSection() {
  return (
    <section className={styles.trustSection} aria-labelledby="a3-homepage-trust-title">
      <div>
        <p className={styles.eyebrow}>12 / PRIVACY & SAFETY</p>
        <h2 id="a3-homepage-trust-title">个性化需要数据，也需要清楚的边界。</h2>
      </div>
      <div className={styles.trustPoints}>
        <p>上传资料只用于授权范围内的检索、引用和学习资源生成。</p>
        <p>引用不足时标记未验证，危险、作弊和越权请求会被拦截。</p>
        <p>学生学习记录与教师权限分开管理，公开首页只展示脱敏界面。</p>
      </div>
      <div className={styles.sectionActions}>
        <Link className={styles.sectionLink} href="/a3/privacy" prefetch={false}>
          查看隐私说明
        </Link>
        <Link className={styles.sectionLink} href="/a3/help" prefetch={false}>
          查看产品帮助
        </Link>
      </div>
    </section>
  );
}

const faqItems = [
  {
    question: '智学引擎和普通 AI 对话工具有什么不同？',
    answer:
      '它不只回答当前问题，还把画像、诊断、计划、资料、测评和复习连接起来，让学习结果进入下一次安排。',
  },
  {
    question: '必须上传自己的资料吗？',
    answer:
      '不是。可以先使用已有课程内容；上传个人资料后，课堂和辅导会优先引用已完成索引的授权资料。',
  },
  {
    question: '系统如何知道我是否真的学会？',
    answer:
      '测评会记录正确性、解释和错因，错题进入间隔复习；掌握度、复习结果和任务完成情况会继续更新计划与报告。',
  },
  {
    question: '教师可以看到什么？',
    answer:
      '教师工作台聚合课程进度、风险、薄弱点和资源效果，并在权限范围内下发学习任务，不公开学生个人资料。',
  },
] as const;

function FaqSection() {
  return (
    <section className={styles.faqSection} aria-labelledby="a3-homepage-faq-title">
      <div>
        <p className={styles.eyebrow}>13 / FAQ</p>
        <h2 id="a3-homepage-faq-title">开始之前，你可能还会关心这些。</h2>
      </div>
      <div className={styles.faqList}>
        {faqItems.map((item) => (
          <details key={item.question}>
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function ClosingSection() {
  return (
    <>
      <section id="contact" className={styles.closingSection}>
        <p>你的下一次学习，可以从一份清楚的今日计划开始。</p>
        <h2>让每一次完成，都真正改变下一步。</h2>
        <Link className={styles.primaryCta} href="/a3/register">
          开始体验智学引擎
        </Link>
      </section>
      <footer className={styles.footer}>
        <div>
          <strong>{A3_HOMEPAGE_FOOTER.product}</strong>
          <span>{A3_HOMEPAGE_FOOTER.copyright}</span>
        </div>
        <nav aria-label="页脚导航">
          <Link href="/a3/help" prefetch={false}>
            {A3_HOMEPAGE_FOOTER.contactLabel}
          </Link>
          <Link href="/a3/privacy" prefetch={false}>
            隐私说明
          </Link>
          <Link href="/a3/login">登录</Link>
        </nav>
      </footer>
    </>
  );
}

export function A3HomepageStory() {
  const [
    today,
    profile,
    diagnostic,
    knowledge,
    resources,
    classroom,
    coaching,
    assessmentReview,
    progressRefresh,
    teacher,
  ] = A3_HOMEPAGE_STORY;

  if (
    !today ||
    !profile ||
    !diagnostic ||
    !knowledge ||
    !resources ||
    !classroom ||
    !coaching ||
    !assessmentReview ||
    !progressRefresh ||
    !teacher
  ) {
    return null;
  }

  return (
    <div id="capabilities" className={styles.story}>
      <ProductStorySection
        item={today}
        sectionId="daily-learning"
        actions={[
          { href: '/a3/today', label: '查看今日任务', prefetch: false },
          { href: '/a3/study-plan', label: '查看周期计划', prefetch: false },
        ]}
      />

      <div className={styles.foundationBand} aria-label="个性化学习起点">
        <ProductStorySection item={profile} />
        <ProductStorySection item={diagnostic} />
      </div>

      <div id="product-evidence" className={styles.knowledgeBand}>
        <div id="learning-loop">
          <ProductStorySection item={knowledge} />
        </div>
        <KnowledgeFlow />
      </div>

      <A3HomepageResourceShowcase item={resources} />

      <div className={styles.classroomBand}>
        <ProductStorySection item={classroom} />
        <A3HomepageClassroomIsland />
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
          <Link className={styles.sectionLink} href="/a3/coaching" prefetch={false}>
            进入实时辅导
          </Link>
        </div>
        <A3HomepageTeacherStage />
      </section>

      <div className={styles.feedbackBand} aria-label="测评与学习反馈闭环">
        <ProductStorySection
          item={assessmentReview}
          actions={[
            { href: '/a3/assessment', label: '进入测评', prefetch: false },
            { href: '/a3/wrong-notebook', label: '查看错题复习', prefetch: false },
          ]}
        />
        <ProductStorySection
          item={progressRefresh}
          actions={[
            { href: '/a3/report', label: '查看学习报告', prefetch: false },
            { href: '/a3/study-plan', label: '查看更新后的计划', prefetch: false },
          ]}
        />
      </div>

      <ProductStorySection
        item={teacher}
        actions={[{ href: '/a3/teacher', label: '进入教师工作台', prefetch: false }]}
      />
      <EvidenceSection />
      <TrustSection />
      <FaqSection />
      <ClosingSection />
    </div>
  );
}
