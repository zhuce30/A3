export function prepareA3SpeechText(markdown: string) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) => ` ${speakLatex(latex)} `)
    .replace(/\$([^$\n]+)\$/g, (_, latex) => ` ${speakLatex(latex)} `)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, latex) => ` ${speakLatex(latex)} `)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, latex) => ` ${speakLatex(latex)} `)
    .replace(/([A-Za-z0-9_{}^()+\-*/=.,\s]+\\[a-zA-Z]+[A-Za-z0-9_{}^()+\-*/=.,\s\\]*)/g, (_, latex) => ` ${speakLatex(latex)} `)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function speakLatex(latex: string) {
  return String(latex || '')
    .replace(/\\mathcal\s*\{L\}/g, ' 拉普拉斯变换 ')
    .replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, ' 分式 $1 除以 $2 ')
    .replace(/\\cdotp|\\cdot|\\times/g, ' 乘以 ')
    .replace(/\\sqrt\s*\{([^{}]+)\}/g, ' 根号 $1 ')
    .replace(/\\pm/g, ' 正负 ')
    .replace(/\\rightarrow|\\Rightarrow/g, ' 推出 ')
    .replace(/\\left|\\right/g, '')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
