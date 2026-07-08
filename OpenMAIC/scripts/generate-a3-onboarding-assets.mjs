import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const outputDir = path.resolve('public/a3/assets/onboarding');

const commonDefs = `
  <defs>
    <linearGradient id="blueViolet" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2F80FF"/>
      <stop offset="100%" stop-color="#8B5CF6"/>
    </linearGradient>
    <linearGradient id="softBlue" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#EFF6FF"/>
      <stop offset="100%" stop-color="#DBEAFE"/>
    </linearGradient>
    <linearGradient id="mint" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#D1FAE5"/>
      <stop offset="100%" stop-color="#A7F3D0"/>
    </linearGradient>
    <filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#2563EB" flood-opacity="0.18"/>
    </filter>
    <filter id="tinyShadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#0F172A" flood-opacity="0.10"/>
    </filter>
  </defs>
`;

function shellRobot({ width = 407, height = 222, body = '#FFFFFF', hoodie = false } = {}) {
  const cx = width * 0.5;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
  ${commonDefs}
  <path d="M44 ${height - 34} C95 ${height - 78}, 283 ${height - 80}, 354 ${height - 36}" stroke="#BFDBFE" stroke-width="3" stroke-linecap="round" opacity=".55"/>
  <circle cx="91" cy="50" r="7" fill="#60A5FA" opacity=".65"/>
  <circle cx="332" cy="62" r="5" fill="#8B5CF6" opacity=".55"/>
  <rect x="${cx - 66}" y="48" width="132" height="86" rx="40" fill="${body}" stroke="#BFDBFE" stroke-width="4" filter="url(#softShadow)"/>
  <rect x="${cx - 42}" y="70" width="84" height="42" rx="21" fill="#0F172A"/>
  <circle cx="${cx - 18}" cy="91" r="7" fill="#67E8F9"/>
  <circle cx="${cx + 18}" cy="91" r="7" fill="#67E8F9"/>
  <path d="M${cx - 16} 111 C${cx - 5} 119 ${cx + 8} 119 ${cx + 18} 111" stroke="#67E8F9" stroke-width="4" stroke-linecap="round"/>
  <path d="M${cx - 56} 68 C${cx - 90} 70 ${cx - 105} 99 ${cx - 102} 126" stroke="#60A5FA" stroke-width="12" stroke-linecap="round"/>
  <path d="M${cx + 56} 68 C${cx + 100} 75 ${cx + 114} 45 ${cx + 126} 26" stroke="#60A5FA" stroke-width="12" stroke-linecap="round"/>
  <circle cx="${cx - 109}" cy="129" r="14" fill="#FFFFFF" stroke="#60A5FA" stroke-width="5"/>
  <circle cx="${cx + 130}" cy="24" r="13" fill="#FFFFFF" stroke="#60A5FA" stroke-width="5"/>
  <path d="M${cx - 80} 146 C${cx - 54} 132 ${cx + 55} 132 ${cx + 84} 146 L${cx + 104} ${height - 26} H${cx - 104} L${cx - 80} 146Z" fill="${hoodie ? 'url(#blueViolet)' : '#FFFFFF'}" stroke="#BFDBFE" stroke-width="4" filter="url(#tinyShadow)"/>
  <path d="M${cx - 18} 158 H${cx + 18}" stroke="${hoodie ? '#BFDBFE' : '#60A5FA'}" stroke-width="5" stroke-linecap="round"/>
  <text x="${cx}" y="${height - 43}" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="${hoodie ? '#FFFFFF' : '#3B82F6'}">A</text>
</svg>`;
}

function privacyShield() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="410" height="210" viewBox="0 0 410 210" fill="none">
  ${commonDefs}
  <ellipse cx="210" cy="116" rx="136" ry="46" fill="#DBEAFE" opacity=".48"/>
  <path d="M70 119 C124 48, 278 33, 348 100" stroke="#BFDBFE" stroke-width="3" opacity=".75"/>
  <path d="M78 137 C159 185, 278 171, 340 91" stroke="#C4B5FD" stroke-width="3" opacity=".55"/>
  <circle cx="84" cy="121" r="8" fill="#60A5FA"/>
  <circle cx="340" cy="92" r="9" fill="#8B5CF6"/>
  <path d="M204 24 L290 54 V106 C290 149 257 178 204 194 C151 178 118 149 118 106 V54 L204 24Z" fill="url(#blueViolet)" filter="url(#softShadow)"/>
  <path d="M204 41 L270 64 V106 C270 137 247 160 204 174 C161 160 138 137 138 106 V64 L204 41Z" fill="#EFF6FF" opacity=".22"/>
  <rect x="170" y="92" width="68" height="52" rx="12" fill="#FFFFFF" opacity=".94"/>
  <path d="M184 92 V78 C184 66 193 57 204 57 C215 57 224 66 224 78 V92" stroke="#3B82F6" stroke-width="10" stroke-linecap="round"/>
  <circle cx="204" cy="119" r="7" fill="#3B82F6"/>
  <path d="M204 124 V135" stroke="#3B82F6" stroke-width="6" stroke-linecap="round"/>
  <circle cx="286" cy="151" r="28" fill="#FFFFFF" stroke="#60A5FA" stroke-width="5" filter="url(#tinyShadow)"/>
  <path d="M274 151 L284 161 L302 137" stroke="#2563EB" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

function profileCardArt() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="292" height="205" viewBox="0 0 292 205" fill="none">
  ${commonDefs}
  <ellipse cx="146" cy="178" rx="98" ry="14" fill="#DBEAFE" opacity=".7"/>
  <rect x="82" y="25" width="128" height="150" rx="18" fill="#FFFFFF" stroke="#93C5FD" stroke-width="4" filter="url(#softShadow)"/>
  <rect x="115" y="12" width="62" height="28" rx="14" fill="url(#blueViolet)"/>
  <circle cx="123" cy="75" r="16" fill="#3B82F6" opacity=".86"/>
  <path d="M98 116 C108 96 138 96 148 116" stroke="#60A5FA" stroke-width="12" stroke-linecap="round"/>
  ${[96,124,152].map((y) => `<rect x="156" y="${y}" width="34" height="8" rx="4" fill="#BFDBFE"/><circle cx="110" cy="${y + 4}" r="5" fill="#93C5FD"/>`).join('')}
  <rect x="14" y="60" width="72" height="34" rx="17" fill="#EFF6FF" stroke="#BFDBFE"/>
  <text x="50" y="82" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#2563EB">目标</text>
  <rect x="199" y="78" width="78" height="34" rx="17" fill="#ECFDF5" stroke="#A7F3D0"/>
  <text x="238" y="100" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#059669">偏好</text>
</svg>`;
}

function pathCardArt() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="292" height="205" viewBox="0 0 292 205" fill="none">
  ${commonDefs}
  <ellipse cx="145" cy="176" rx="106" ry="15" fill="#DBEAFE" opacity=".66"/>
  <path d="M56 154 C76 102, 124 128, 142 82 C158 42, 207 42, 232 24" stroke="#60A5FA" stroke-width="5" stroke-linecap="round" stroke-dasharray="11 10"/>
  <circle cx="58" cy="154" r="14" fill="url(#blueViolet)" stroke="#FFFFFF" stroke-width="5" filter="url(#tinyShadow)"/>
  <circle cx="142" cy="82" r="14" fill="url(#blueViolet)" stroke="#FFFFFF" stroke-width="5" filter="url(#tinyShadow)"/>
  <circle cx="232" cy="24" r="14" fill="url(#blueViolet)" stroke="#FFFFFF" stroke-width="5" filter="url(#tinyShadow)"/>
  <rect x="24" y="44" width="105" height="48" rx="14" fill="#FFFFFF" stroke="#BFDBFE" filter="url(#tinyShadow)"/>
  <text x="77" y="68" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#2563EB">阶段目标</text>
  <text x="77" y="84" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#64748B">知识掌握 70%</text>
  <rect x="152" y="126" width="112" height="48" rx="14" fill="#FFFFFF" stroke="#BFDBFE" filter="url(#tinyShadow)"/>
  <text x="208" y="151" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#2563EB">智能推荐</text>
  <text x="208" y="167" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#64748B">优先学习重点</text>
  <path d="M218 62 L255 50 V92 L218 80Z" fill="url(#blueViolet)"/>
  <path d="M218 62 V113" stroke="#3B82F6" stroke-width="5" stroke-linecap="round"/>
</svg>`;
}

function classroomCardArt() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="292" height="205" viewBox="0 0 292 205" fill="none">
  ${commonDefs}
  <ellipse cx="146" cy="178" rx="110" ry="14" fill="#DBEAFE" opacity=".64"/>
  <rect x="68" y="52" width="138" height="96" rx="18" fill="#FFFFFF" stroke="#BFDBFE" stroke-width="4" filter="url(#softShadow)"/>
  <rect x="86" y="72" width="58" height="46" rx="12" fill="#DBEAFE"/>
  <circle cx="115" cy="95" r="16" fill="url(#blueViolet)"/>
  <path d="M110 87 L126 95 L110 103Z" fill="#FFFFFF"/>
  <rect x="156" y="76" width="28" height="58" rx="8" fill="#93C5FD"/>
  <rect x="193" y="100" width="28" height="34" rx="8" fill="#60A5FA"/>
  <rect x="218" y="129" width="48" height="36" rx="8" fill="#3B82F6"/>
  <rect x="199" y="142" width="48" height="36" rx="8" fill="#60A5FA"/>
  <rect x="179" y="155" width="48" height="36" rx="8" fill="#BFDBFE"/>
  <rect x="28" y="70" width="54" height="32" rx="16" fill="#EEF2FF" stroke="#C4B5FD"/>
  <text x="55" y="91" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#7C3AED">AI课堂</text>
  <rect x="206" y="62" width="60" height="32" rx="16" fill="#ECFDF5" stroke="#A7F3D0"/>
  <text x="236" y="83" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#059669">资源</text>
</svg>`;
}

const assets = [
  ['welcome-robot.webp', shellRobot({ width: 407, height: 222, hoodie: false })],
  ['privacy-shield-hero.webp', privacyShield()],
  ['profile-avatar-robot.webp', shellRobot({ width: 250, height: 174, hoodie: true })],
  ['welcome-profile-card-art.webp', profileCardArt()],
  ['welcome-path-card-art.webp', pathCardArt()],
  ['welcome-classroom-card-art.webp', classroomCardArt()],
];

await fs.mkdir(outputDir, { recursive: true });

for (const [fileName, svg] of assets) {
  await sharp(Buffer.from(svg)).webp({ quality: 96, lossless: false, effort: 6 }).toFile(path.join(outputDir, fileName));
}

console.log(`Generated ${assets.length} A3 onboarding assets in ${outputDir}`);
