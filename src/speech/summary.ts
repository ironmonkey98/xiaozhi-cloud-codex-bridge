/** 从 Codex 最终回复中提取适合语音播报的短中文摘要：取首个非空行，去 Markdown，截断。 */
export function toSpokenSummary(finalResponse: string, maxChars: number): string {
  const firstLine =
    finalResponse
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('```')) ?? '';
  const plain = firstLine
    .replace(/^#+\s*/, '')
    .replace(/^[-*>]\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
  if (!plain) return '分析已完成，但没有得到可播报的结论，详细结果保存在电脑上。';
  const chars = Array.from(plain);
  return chars.length <= maxChars ? plain : chars.slice(0, maxChars - 1).join('') + '…';
}
