import { extractBaseTitle } from '@/lib/supabase';

/** 핵심어 추출: 부제/괄호/번호/문장부호 정규화 */
/** 전각→반각 숫자·영문자 정규화 */
function normalizeFullWidth(s: string): string {
  return s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0),
  );
}

export function toCore(s: string): string {
  return normalizeFullWidth(s)
    // 문장부호 정규화 (전각→반각)
    .replace(/～/g, '~').replace(/〜/g, '~')
    .replace(/！/g, '!').replace(/？/g, '?')
    .replace(/\u3000/g, ' ')
    // 전각 괄호 → 반각 통일
    .replace(/［/g, '[').replace(/］/g, ']')
    // 부제/괄호 제거
    .replace(/~[^~]*~/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    // 괄호 없는 에디션 표기도 제거
    .replace(/\s*(改訂版|完全版|分冊版|特装版|連載版)/g, '')
    .replace(/\s+/g, '')
    .trim();
}

interface TitleKrMaps {
  krExact: Map<string, string>;
  krBase: Map<string, string>;
  krCore: Map<string, string>;
}

/** title_master 데이터로 매칭 맵 구축 */
export function buildTitleKrMaps(masterData: Array<{ title_jp: string; title_kr: string | null }>): TitleKrMaps {
  const krExact = new Map<string, string>();
  const krBase = new Map<string, string>();
  const krCore = new Map<string, string>();
  for (const m of masterData) {
    if (m.title_jp && m.title_kr) {
      krExact.set(m.title_jp, m.title_kr);
      krBase.set(extractBaseTitle(m.title_jp), m.title_kr);
      const c = toCore(m.title_jp);
      if (c && !krCore.has(c)) krCore.set(c, m.title_kr);
    }
  }
  return { krExact, krBase, krCore };
}

/** 일본어 에디션 표기 → 한국어 접미사 */
function editionSuffix(titleJp: string): string {
  if (/完全版/.test(titleJp)) return ' 완전판';
  if (/改訂版/.test(titleJp)) return ' 개정판';
  if (/分冊版/.test(titleJp)) return ' 분권판';
  if (/特装版/.test(titleJp)) return ' 특장판';
  if (/連載版/.test(titleJp)) return ' 연재판';
  return '';
}

/** title_jp에 대한 title_kr 매칭 (정확 → base → 핵심어 순서 폴백) */
export function matchTitleKr(titleJp: string, maps: TitleKrMaps): string {
  // 1. 정확히 일치
  const exact = maps.krExact.get(titleJp);
  if (exact) return exact;
  // 2. base/core 매칭 → 에디션 접미사 추가
  const base = maps.krBase.get(extractBaseTitle(titleJp));
  if (base) return base + editionSuffix(titleJp);
  const core = maps.krCore.get(toCore(titleJp));
  if (core) return core + editionSuffix(titleJp);
  return '';
}
