// 统一的乱码检测。
// 此前 hasMojibake 在 5 个文件里各写一份，且分成两套实现：完整版覆盖 25 个乱码码点，
// 简版只判 10 个字符——导致同样内容在不同页面判定结果不一致。这里统一为完整版（超集），
// 各处引用此模块，避免再次漂移。
const MOJIBAKE_CODE_POINTS = [
  0xfffd, 0x951b, 0x7ee1, 0x93ba, 0x74a7, 0x938d, 0x9422, 0x7470, 0x93c1, 0x701b,
  0x94d6, 0x95c5, 0x68f0, 0x9352, 0x935b, 0x942d, 0x95bf, 0x7f01, 0x93cc, 0x6fb6,
  0x9369, 0x59e3, 0x52ec, 0x9301, 0x20ac,
];

const MOJIBAKE_CODE_POINT_SET = new Set(MOJIBAKE_CODE_POINTS);

/** 文本是否包含已知的乱码标记码点（UTF-8/GBK 错配后的典型残留字符）。 */
export function hasMojibake(text: string): boolean {
  return [...text].some((char) => MOJIBAKE_CODE_POINT_SET.has(char.codePointAt(0) ?? 0));
}
