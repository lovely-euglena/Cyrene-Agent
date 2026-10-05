// QQ 文本分片（从 adapters/qq/napcat-adapter.ts 抽出，纯函数）。
//
// 桌面 NapCat（`qq`）与 QQ 官方 bot（`qqbot`）共用同一分片口径；
// 服务端契约 fixtures 锁定该行为（docs/design/2026-10-05-server-channel.md §2.5/§7.2）。
export const TEXT_CHUNK_CODEPOINTS = 1500;

export function splitQqText(text: string, maxCodepoints = TEXT_CHUNK_CODEPOINTS): string[] {
  const source = text.trim();
  if (!source) return [];
  const result: string[] = [];
  let rest = Array.from(source);
  while (rest.length > maxCodepoints) {
    const window = rest.slice(0, maxCodepoints);
    let splitAt = -1;
    for (let i = window.length - 1; i >= Math.floor(maxCodepoints * 0.55); i--) {
      if (/[。！？!?；;…\n]/u.test(window[i])) {
        splitAt = i + 1;
        break;
      }
    }
    if (splitAt < 0) splitAt = maxCodepoints;
    result.push(window.slice(0, splitAt).join("").trim());
    rest = rest.slice(splitAt);
  }
  const tail = rest.join("").trim();
  if (tail) result.push(tail);
  return result.filter(Boolean);
}
