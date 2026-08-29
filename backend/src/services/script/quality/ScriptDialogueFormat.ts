const SPOKEN_ATTRIBUTION = /(?:说|问|答|喊|补充|补了(?:一|句)|解释|提醒|警告|劝道|安慰道|嘀咕|回应|开口|语气[^：:\n]{0,12})[：:]\s*\S/u;
const DIRECT_ADDRESS = /^[\p{Script=Han}A-Za-z0-9·]{1,8}[，,]\s*(?:我|我们|你|您|咱们|这里|这边|听说|别|先|麻烦|请|到底)/u;
const DIRECT_QUESTION_ADDRESS = /^[\p{Script=Han}A-Za-z0-9·]{1,8}[，,][^。\n]{0,40}[？！!?]/u;
const SPOKEN_OPENING = /^(?:您请|请进|请坐|请看|随便看|放心|没事|辛苦了|欢迎|谢谢|对不起|不用|不是|我们是|我是|我说|我没|我不|好吧|行了|当然)[，,。！？!?\p{Script=Han}]/u;

/**
 * Finds high-confidence spoken lines that were incorrectly emitted as an
 * action. It deliberately does not guess the missing speaker: an address such
 * as “林老板” is commonly the listener, not the person speaking.
 */
export function looksLikeUnattributedDialogueAction(value: string): boolean {
  const text = value.trim().replace(/^△\s*/u, '');
  if (!text) return false;
  return (
    SPOKEN_ATTRIBUTION.test(text) ||
    DIRECT_ADDRESS.test(text) ||
    DIRECT_QUESTION_ADDRESS.test(text) ||
    SPOKEN_OPENING.test(text)
  );
}
