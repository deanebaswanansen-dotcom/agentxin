const COMPLETE_TAG_BLOCK_RE =
  /<\s*(think|thinking|reasoning)\s*>[\s\S]*?<\s*\/\s*\1\s*>\s*/gi;
const DANGLING_TAG_BLOCK_RE =
  /<\s*(think|thinking|reasoning)\s*>[\s\S]*$/gi;
const BRACKETED_BLOCK_RE =
  /\[(?:思考|推理|thinking|reasoning)\][\s\S]*?\[\/(?:思考|推理|thinking|reasoning)\]\s*/gi;
const FINAL_BODY_LABEL_RE =
  /^\s*(?:正文|最终正文|小说正文|成文)\s*[:：]\s*/gim;
const REASONING_LINE_RE =
  /^\s*(?:思考过程|思考内容|我的思考|推理过程|reasoning|thinking)\s*[:：].*$/gim;

export function stripReasoningArtifacts(input: string): string {
  return input
    .replace(COMPLETE_TAG_BLOCK_RE, '')
    .replace(DANGLING_TAG_BLOCK_RE, '')
    .replace(BRACKETED_BLOCK_RE, '')
    .replace(REASONING_LINE_RE, '')
    .replace(FINAL_BODY_LABEL_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findOpeningTag(text: string): RegExpExecArray | null {
  return /<\s*(think|thinking|reasoning)\s*>/i.exec(text);
}

function findClosingTag(text: string, tag: string): RegExpExecArray | null {
  return new RegExp(`<\\s*\\/\\s*${tag}\\s*>`, 'i').exec(text);
}

function partialOpeningTagStart(text: string): number {
  const tailStart = Math.max(0, text.length - 32);
  const tail = text.slice(tailStart);
  const match = /<\s*(?:t|th|thi|thin|think|thinki|thinkin|thinking|r|re|rea|reas|reaso|reason|reasoni|reasonin|reasoning)?$/i.exec(tail);
  return match?.index === undefined ? -1 : tailStart + match.index;
}

export class ReasoningArtifactFilter {
  private carry = '';
  private hiddenTag: string | null = null;

  push(chunk: string): string {
    let text = this.carry + chunk;
    this.carry = '';
    let output = '';

    while (text.length > 0) {
      if (this.hiddenTag !== null) {
        const close = findClosingTag(text, this.hiddenTag);
        if (close === null) return output;
        text = text.slice(close.index + close[0].length);
        this.hiddenTag = null;
        continue;
      }

      const open = findOpeningTag(text);
      if (open === null) {
        const partialStart = partialOpeningTagStart(text);
        if (partialStart >= 0) {
          output += text.slice(0, partialStart);
          this.carry = text.slice(partialStart);
          return output;
        }
        output += text;
        return output;
      }

      output += text.slice(0, open.index);
      this.hiddenTag = open[1].toLowerCase();
      text = text.slice(open.index + open[0].length);
    }

    return output;
  }

  flush(): string {
    const tail = this.hiddenTag === null ? this.carry : '';
    this.carry = '';
    this.hiddenTag = null;
    return tail;
  }
}
